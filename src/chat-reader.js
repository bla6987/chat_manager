/**
 * Chat Reader — JSONL parsing, search index building, branch detection.
 * Never modifies any chat files.
 */

import { getCachedChatsForCharacter, putCachedChat, putCachedChats, removeCachedChat } from './cache-store.js';
import { getRepresentativeEmbeddingText } from './embedding-text.js';
import { timestampMs, localDateBoundary } from './timestamps.js';
import { resolveActiveChatFilename } from './active-chat.js';

const MODULE_NAME = 'chat_manager';
const HYDRATION_BATCH_SIZE = 6;
const HYDRATION_YIELD_MS = 16;
const FALLBACK_SORT_TIMESTAMP = 0;
// The host list has no file revision: last_mes survives edits. Limit reuse even
// when size/count match; explicit refreshes and local dirty events bypass this.
const REVALIDATE_AFTER_MS = 60_000;

/** @type {Object<string, ChatIndexEntry>} filename -> index entry */
let chatIndex = {};
let currentCharacterAvatar = null;
let indexBuildInProgress = false;
let nextBuildToken = 0;
let activeBuildToken = null;
let nextInitialOrder = 0;

let hydrationQueue = [];
let queuedFiles = new Set();
let hydrationInProgress = false;
let hydrationSessionId = 0;
const entryHydrationPromises = new Map();
const hydrationListeners = new Set();
const compositeEmbeddingMaps = new WeakSet();
// Entries are normalized once because every message/body mutation in this
// module replaces the entry object (or installs already-normalized cache data).
const normalizedEntries = new WeakSet();
// Branch inputs follow the same replacement rule: edits and swipe changes
// install new message arrays, so array identity is the cache invalidation key.
const branchPointCache = new WeakMap();
let progressCallback = null;

/** Searchable messages cache — invalidated on every index mutation */
let indexVersion = 0;
let cachedSearchableMessages = null;
let cachedSearchableVersion = -1;

/**
 * @typedef {Object} IndexMessage
 * @property {string} filename
 * @property {number} index
 * @property {string} role - 'user' | 'assistant'
 * @property {string} text
 * @property {string} [textLower] - lazily computed lowercased text for search
 * @property {string} timestamp
 * @property {string[]} [swipes] - Optional swipe variants for this message
 * @property {number} [swipeId] - Active swipe index
 */

/**
 * @typedef {Object} ChatIndexEntry
 * @property {string} fileName
 * @property {number} lastModified
 * @property {number} messageCount
 * @property {IndexMessage[]} messages
 * @property {string|null} firstMessageTimestamp
 * @property {string|null} lastMessageTimestamp
 * @property {number} sortTimestamp - stable recency key for list ordering
 * @property {number} initialOrder - deterministic tie-breaker to avoid jitter while hydrating
 * @property {number|null} branchPoint - message index where this chat diverged from the active chat, or null
 * @property {boolean} isLoaded - whether full chat content has been fetched
 * @property {number[]|null} chatEmbedding - transient semantic embedding vector for this chat
 * @property {string|null} chatEmbeddingHash - transient content hash for representative chat embedding text
 * @property {number|null} clusterLabel - transient cluster assignment derived from embeddings
 * @property {Map<string|number, number[]>|null} messageEmbeddings - transient message embeddings keyed by composite variant key or legacy message index
 */

/**
 * Build a stable composite key for a message swipe variant embedding.
 * @param {number} messageIndex
 * @param {number} swipeIndex
 * @returns {string}
 */
export function makeMessageEmbeddingKey(messageIndex, swipeIndex = 0) {
    const m = Number.isFinite(messageIndex) ? Math.max(0, Math.floor(messageIndex)) : 0;
    const s = Number.isFinite(swipeIndex) ? Math.max(0, Math.floor(swipeIndex)) : 0;
    return `m:${m}:s:${s}`;
}

/**
 * Get active swipe index for a message.
 * @param {IndexMessage|any} msg
 * @returns {number}
 */
export function getMessageActiveSwipeIndex(msg) {
    const raw = Number(msg?.swipeId);
    if (!Number.isFinite(raw) || raw < 0) return 0;
    return Math.floor(raw);
}

/**
 * Ensure an entry has a usable message embedding map and migrate legacy keys.
 * @param {ChatIndexEntry|any} entry
 * @returns {Map<string|number, number[]>}
 */
export function ensureMessageEmbeddingMap(entry) {
    if (!(entry?.messageEmbeddings instanceof Map)) {
        entry.messageEmbeddings = new Map();
        compositeEmbeddingMaps.add(entry.messageEmbeddings);
        return entry.messageEmbeddings;
    }

    if (compositeEmbeddingMaps.has(entry.messageEmbeddings)) return entry.messageEmbeddings;

    if (entry.messageEmbeddings.size === 0 || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return entry.messageEmbeddings;
    }

    let needsMigration = false;
    for (const key of entry.messageEmbeddings.keys()) {
        if (typeof key === 'number') {
            needsMigration = true;
            break;
        }
    }

    if (!needsMigration) {
        compositeEmbeddingMaps.add(entry.messageEmbeddings);
        return entry.messageEmbeddings;
    }

    const migrated = new Map();
    for (const msg of entry.messages) {
        const activeSwipe = getMessageActiveSwipeIndex(msg);
        const key = makeMessageEmbeddingKey(msg.index, activeSwipe);
        const legacyValue = entry.messageEmbeddings.get(msg.index);
        if (Array.isArray(legacyValue) && legacyValue.length > 0) {
            migrated.set(key, legacyValue);
        }
    }
    // Keep any already-composite entries from mixed maps.
    for (const [key, value] of entry.messageEmbeddings.entries()) {
        if (typeof key === 'string' && key.startsWith('m:') && Array.isArray(value) && value.length > 0) {
            migrated.set(key, value);
        }
    }

    entry.messageEmbeddings = migrated;
    compositeEmbeddingMaps.add(migrated);
    return entry.messageEmbeddings;
}

/**
 * Get a message embedding vector, defaulting to the active swipe variant.
 * Falls back to legacy numeric keying for backward compatibility.
 * @param {ChatIndexEntry|any} entry
 * @param {IndexMessage|any} msg
 * @param {number|null} [swipeIndex=null]
 * @returns {number[]|null}
 */
export function getMessageEmbedding(entry, msg, swipeIndex = null) {
    if (!entry || !(entry.messageEmbeddings instanceof Map) || !msg) return null;

    const resolvedSwipe = swipeIndex == null ? getMessageActiveSwipeIndex(msg) : Math.max(0, Math.floor(Number(swipeIndex) || 0));
    const compositeKey = makeMessageEmbeddingKey(msg.index, resolvedSwipe);
    const fromComposite = entry.messageEmbeddings.get(compositeKey);
    if (Array.isArray(fromComposite) && fromComposite.length > 0) {
        return fromComposite;
    }

    // A legacy numeric key describes the active variant only. Another swipe
    // must never borrow this vector just because its own embedding is missing.
    const fromLegacy = resolvedSwipe === getMessageActiveSwipeIndex(msg)
        ? entry.messageEmbeddings.get(msg.index) : null;
    if (Array.isArray(fromLegacy) && fromLegacy.length > 0) {
        return fromLegacy;
    }

    return null;
}

function messageVariantText(msg, swipeIndex) {
    if (!msg) return '';
    const text = swipeIndex === getMessageActiveSwipeIndex(msg) ? msg.text : msg.swipes?.[swipeIndex];
    return typeof text === 'string' ? text.trim() : '';
}

function retainMessageEmbeddings(entry, messages) {
    if (!(entry.messageEmbeddings instanceof Map)) return null;
    const previousMap = ensureMessageEmbeddingMap(entry);
    const retained = new Map();
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const previous = entry.messages[i];
        if (!previous) continue;
        const swipeCount = Math.max(msg.swipes?.length || 0, getMessageActiveSwipeIndex(msg) + 1);
        for (let swipe = 0; swipe < swipeCount; swipe++) {
            const text = messageVariantText(msg, swipe);
            if (!text || text !== messageVariantText(previous, swipe)) continue;
            const vector = previousMap.get(makeMessageEmbeddingKey(previous.index, swipe));
            if (vector) retained.set(makeMessageEmbeddingKey(msg.index, swipe), vector);
        }
    }
    compositeEmbeddingMaps.add(retained);
    return retained;
}

/**
 * Set a message embedding vector for a specific swipe variant.
 * @param {ChatIndexEntry|any} entry
 * @param {number} messageIndex
 * @param {number} swipeIndex
 * @param {number[]} vector
 */
export function setMessageEmbedding(entry, messageIndex, swipeIndex, vector) {
    if (!entry || !Array.isArray(vector) || vector.length === 0) return;
    const map = ensureMessageEmbeddingMap(entry);
    const key = makeMessageEmbeddingKey(messageIndex, swipeIndex);
    if (map.get(key) !== vector) {
        map.set(key, vector);
        entry.messageEmbeddingVersion = (entry.messageEmbeddingVersion || 0) + 1;
    }
}

/**
 * Fetch list of chat files for the current character.
 * @returns {Promise<Array>} Array of chat metadata objects from the server
 */
export async function fetchChatList() {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return [];

    const character = context.characters[context.characterId];
    if (!character) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar }),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to fetch chat list:`, response.status);
        throw new Error(`Failed to fetch chat list (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid chat list response');
    return data;
}

/**
 * Fetch the contents of a specific chat file.
 * @param {string} fileName - The JSONL filename
 * @returns {Promise<Array>} Array of message objects
 */
export async function fetchChatContent(fileName) {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return [];

    const character = context.characters[context.characterId];
    if (!character) return [];

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: character.name,
            file_name: fileName.replace(/\.jsonl$/i, ''),
            avatar_url: character.avatar,
        }),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to fetch chat content for ${fileName}:`, response.status);
        throw new Error(`Failed to fetch ${fileName} (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`Invalid chat content response for ${fileName}`);
    return data;
}

/**
 * Parse messages from a chat data array into our index format.
 * @param {Array} chatData - Raw message objects from the server
 * @param {string} fileName - Chat filename
 * @returns {IndexMessage[]}
 */
function parseMessages(chatData, fileName) {
    const messages = [];
    // Disk arrays include a header; the host's live chat array does not.
    const offset = chatData[0] && typeof chatData[0].mes !== 'string' ? 1 : 0;
    for (let i = offset; i < chatData.length; i++) {
        const msg = chatData[i];
        // Skip metadata-only entries (no 'mes' field)
        if (!msg || typeof msg.mes !== 'string') continue;

        const rawSwipes = Array.isArray(msg.swipes) ? msg.swipes : null;
        let swipeId = Number.isFinite(Number(msg.swipe_id)) ? Math.max(0, Math.floor(Number(msg.swipe_id))) : 0;
        let swipes = null;

        if (rawSwipes && rawSwipes.length > 0) {
            swipes = rawSwipes.map(swipe => typeof swipe === 'string' ? swipe : '');
            if (swipeId >= swipes.length) {
                swipeId = swipes.length - 1;
            }
            if (swipeId < 0) {
                swipeId = 0;
            }
            if (swipes[swipeId] !== msg.mes) {
                swipes[swipeId] = msg.mes;
            }
        } else if (msg.mes.trim().length > 0) {
            swipes = [msg.mes];
            swipeId = 0;
        }

        messages.push({
            filename: fileName,
            index: i - offset,
            role: msg.is_user ? 'user' : 'assistant',
            text: msg.mes,
            timestamp: msg.send_date || '',
            timestampMs: timestampMs(msg.send_date),
            branches: Array.isArray(msg.extra?.branches) ? msg.extra.branches.map(canonicalFilename).filter(Boolean) : [],
            swipes: swipes || undefined,
            swipeId,
        });
    }
    return messages;
}

/**
 * Extract a timestamp (ms since epoch) from a chat metadata object.
 * @param {Object} metaObj
 * @returns {number}
 */
function getMetaTimestamp(metaObj) {
    return normalizeTimestamp(metaObj?.last_mes);
}

/**
 * Extract timestamp string from metadata (if available).
 * @param {Object} metaObj
 * @returns {string|null}
 */
function getMetaTimestampString(metaObj) {
    if (typeof metaObj?.last_mes === 'string' && metaObj.last_mes.length > 0) {
        return metaObj.last_mes;
    }
    return null;
}

/**
 * Best-effort extraction of message count from metadata list item.
 * @param {Object} metaObj
 * @returns {number|null}
 */
function getMetaMessageCount(metaObj) {
    if (!metaObj || typeof metaObj !== 'object') return null;

    const candidates = [
        metaObj.mes_count,
        metaObj.message_count,
        metaObj.messageCount,
        metaObj.msg_count,
        metaObj.chat_items,
    ];

    for (const value of candidates) {
        if (Number.isFinite(value) && value >= 0) {
            return Math.floor(value);
        }
    }

    if (Array.isArray(metaObj.messages)) {
        return metaObj.messages.length;
    }

    if (Array.isArray(metaObj.chat_items)) {
        return metaObj.chat_items.length;
    }

    return null;
}

/**
 * Normalize server chat list row into a metadata object.
 * @param {Object|Array} chatMeta
 * @returns {Object|null}
 */
function normalizeMeta(chatMeta) {
    const metaObj = Array.isArray(chatMeta) ? chatMeta[0] : chatMeta;
    if (!metaObj || typeof metaObj.file_name !== 'string') return null;
    return metaObj;
}

function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return FALLBACK_SORT_TIMESTAMP;
    }

    return timestampMs(value) ?? FALLBACK_SORT_TIMESTAMP;
}

function canonicalFilename(value) {
    return typeof value === 'string' && value.trim() ? `${value.trim().replace(/\.jsonl$/i, '')}.jsonl` : null;
}

function mainChatFromData(chatData, metadata = null) {
    return canonicalFilename(metadata?.main_chat ?? chatData[0]?.chat_metadata?.main_chat);
}

function metaSignature(meta) {
    return JSON.stringify([meta?.file_size ?? null, getMetaMessageCount(meta)]);
}

function recentlyValidated(entry) {
    const age = Date.now() - entry?.validatedAt;
    return Number.isFinite(age) && age >= 0 && age < REVALIDATE_AFTER_MS;
}

function allocateInitialOrder() {
    const value = nextInitialOrder;
    nextInitialOrder += 1;
    return value;
}

function compareByRecency(a, b) {
    const aTime = Number.isFinite(a.sortTimestamp) ? a.sortTimestamp : FALLBACK_SORT_TIMESTAMP;
    const bTime = Number.isFinite(b.sortTimestamp) ? b.sortTimestamp : FALLBACK_SORT_TIMESTAMP;
    if (aTime !== bTime) {
        return bTime - aTime;
    }

    const aOrder = Number.isFinite(a.initialOrder) ? a.initialOrder : Number.MAX_SAFE_INTEGER;
    const bOrder = Number.isFinite(b.initialOrder) ? b.initialOrder : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
        return aOrder - bOrder;
    }

    return a.fileName.localeCompare(b.fileName);
}

function hasPendingHydration() {
    return hydrationQueue.length > 0 || entryHydrationPromises.size > 0;
}

function getBuildStateResponse(changed = false, buildInProgress = false) {
    return {
        index: chatIndex,
        changed,
        buildInProgress,
        hydrationStarted: hasPendingHydration() || hydrationInProgress,
        isComplete: isHydrationComplete(),
    };
}

function notifyMetadataReady(onMetadataReady, changed) {
    if (typeof onMetadataReady !== 'function') return;
    try {
        onMetadataReady(getBuildStateResponse(changed));
    } catch (err) {
        console.error(`[${MODULE_NAME}] Metadata-ready callback failed:`, err);
    }
}

function resetHydrationQueue() {
    hydrationQueue = [];
    queuedFiles = new Set();
    entryHydrationPromises.clear();
    hydrationInProgress = false;
    hydrationSessionId++;
}

function emitHydrationUpdate() {
    const progress = getHydrationProgress();

    if (progressCallback) {
        try {
            progressCallback(progress.loaded, progress.total);
        } catch (err) {
            console.error(`[${MODULE_NAME}] Progress callback failed:`, err);
        }
    }

    for (const listener of hydrationListeners) {
        try {
            listener({ ...progress, complete: isHydrationComplete() });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Hydration listener failed:`, err);
        }
    }
}

function markEntryForHydration(fileName) {
    const entry = chatIndex[fileName];
    if (!entry || (entry.isLoaded && !entry.needsHydration)) return;
    if (queuedFiles.has(fileName)) return;
    if (entryHydrationPromises.has(fileName)) return;

    hydrationQueue.push(fileName);
    queuedFiles.add(fileName);
}

/**
 * Move a file to the front of the hydration queue so it loads first.
 * @param {string} fileName
 */
export function prioritizeInQueue(fileName) {
    const idx = hydrationQueue.indexOf(fileName);
    if (idx > 0) {
        hydrationQueue.splice(idx, 1);
        hydrationQueue.unshift(fileName);
    }
}

/** Prioritize the active and visible chats without changing their requested order. */
export function prioritizeHydrationFiles(fileNames) {
    if (!Array.isArray(fileNames)) return;
    const wanted = [...new Set(fileNames.filter(Boolean))];
    for (let i = wanted.length - 1; i >= 0; i--) prioritizeInQueue(wanted[i]);
}

function bumpIndexVersion() {
    indexVersion++;
}

function normalizeEntryShape(entry) {
    if (!entry || typeof entry !== 'object') return;
    if (normalizedEntries.has(entry)) return;

    if (!Array.isArray(entry.messages)) entry.messages = [];
    if (!Number.isFinite(entry.messageCount)) entry.messageCount = 0;
    if (entry.firstMessageTimestamp === undefined) entry.firstMessageTimestamp = null;
    if (entry.lastMessageTimestamp === undefined) entry.lastMessageTimestamp = null;
    if (entry.branchPoint === undefined) entry.branchPoint = null;
    if (!Number.isFinite(entry.sortTimestamp)) {
        entry.sortTimestamp = normalizeTimestamp(entry.lastMessageTimestamp || entry.lastModified);
    }
    if (!Number.isFinite(entry.initialOrder)) {
        entry.initialOrder = allocateInitialOrder();
    }

    if (!Number.isFinite(entry.firstTimestampMs)) {
        entry.firstTimestampMs = normalizeTimestamp(entry.firstMessageTimestamp);
    }
    if (!Number.isFinite(entry.lastTimestampMs)) {
        entry.lastTimestampMs = normalizeTimestamp(entry.lastMessageTimestamp);
    }

    if (typeof entry.isLoaded !== 'boolean') {
        entry.isLoaded = entry.messages.length > 0;
    }
    if (!Array.isArray(entry.chatEmbedding)) {
        entry.chatEmbedding = null;
    }
    if (typeof entry.chatEmbeddingHash !== 'string') {
        entry.chatEmbeddingHash = null;
    }
    if (!Number.isFinite(entry.clusterLabel)) {
        entry.clusterLabel = null;
    }
    if (entry.messageEmbeddings instanceof Map) {
        ensureMessageEmbeddingMap(entry);
    } else {
        entry.messageEmbeddings = null;
    }

    if (entry.isLoaded) {
        for (const msg of entry.messages) {
            if (!msg.filename) msg.filename = entry.fileName;
        }
    }
    normalizedEntries.add(entry);
}

function messagesEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const left = a[i];
        const right = b[i];
        if (left?.filename !== right?.filename
            || left?.index !== right?.index
            || left?.role !== right?.role
            || left?.text !== right?.text
            || left?.timestamp !== right?.timestamp
            || JSON.stringify(left?.branches || []) !== JSON.stringify(right?.branches || [])
            || getMessageActiveSwipeIndex(left) !== getMessageActiveSwipeIndex(right)) return false;
        const leftSwipes = left?.swipes;
        const rightSwipes = right?.swipes;
        if (leftSwipes === rightSwipes) continue;
        if (!Array.isArray(leftSwipes) || !Array.isArray(rightSwipes) || leftSwipes.length !== rightSwipes.length) return false;
        for (let swipe = 0; swipe < leftSwipes.length; swipe++) {
            if (leftSwipes[swipe] !== rightSwipes[swipe]) return false;
        }
    }
    return true;
}

/**
 * Fetch and hydrate a single entry, re-trying if metadata changed during fetch.
 * @param {string} fileName
 * @param {number} sessionId
 * @returns {Promise<boolean>}
 */
async function hydrateEntry(fileName, sessionId, persist = true) {
    if (entryHydrationPromises.has(fileName)) {
        return entryHydrationPromises.get(fileName);
    }

    const promise = (async () => {
        while (sessionId === hydrationSessionId) {
            const entry = chatIndex[fileName];
            if (!entry) return false;
            if (entry.isLoaded && !entry.needsHydration) return true;

            const expectedTimestamp = entry.lastModified;
            let chatData;
            try {
                chatData = await fetchChatContent(fileName);
            } catch (err) {
                console.error(`[${MODULE_NAME}] Failed to hydrate ${fileName}:`, err);
                return false;
            }

            if (sessionId !== hydrationSessionId) return false;

            const current = chatIndex[fileName];
            if (!current) return false;
            // An active-chat event may have populated the entry while the
            // network request was in flight. Its newer in-memory state wins.
            if (current.isLoaded && !current.needsHydration) return true;

            // Metadata changed while this request was in flight.
            if (current !== entry || current.lastModified !== expectedTimestamp) {
                continue;
            }

            const messages = parseMessages(chatData, fileName);
            const firstTs = messages.length > 0 ? messages[0].timestamp : null;
            const lastTs = messages.length > 0 ? messages[messages.length - 1].timestamp : current.lastMessageTimestamp;

            chatIndex[fileName] = {
                ...current,
                messageCount: messages.length,
                messages,
                firstMessageTimestamp: firstTs,
                lastMessageTimestamp: lastTs,
                firstTimestampMs: normalizeTimestamp(firstTs),
                lastTimestampMs: normalizeTimestamp(lastTs),
                branchPoint: null,
                isLoaded: true,
                needsHydration: false,
                validatedAt: Date.now(),
                mainChat: mainChatFromData(chatData),
                messageEmbeddings: retainMessageEmbeddings(current, messages),
            };
            if (!current.isLoaded || getRepresentativeEmbeddingText(current) !== getRepresentativeEmbeddingText(chatIndex[fileName])) {
                chatIndex[fileName].chatEmbedding = null;
                chatIndex[fileName].chatEmbeddingHash = null;
                chatIndex[fileName].clusterLabel = null;
            }
            bumpIndexVersion();

            if (persist && currentCharacterAvatar) {
                putCachedChat(currentCharacterAvatar, fileName, chatIndex[fileName]);
            }

            return true;
        }

        return false;
    })().finally(() => {
        // A reset can start a new same-filename hydration before this older
        // promise settles. Do not delete the newer session's promise.
        if (entryHydrationPromises.get(fileName) === promise) {
            entryHydrationPromises.delete(fileName);
        }
    });

    entryHydrationPromises.set(fileName, promise);
    return promise;
}

function startHydrationLoop() {
    if (hydrationInProgress || hydrationQueue.length === 0) return;

    hydrationInProgress = true;
    const sessionId = hydrationSessionId;

    setTimeout(async () => {
        try {
            while (sessionId === hydrationSessionId && hydrationQueue.length > 0) {
                const batch = hydrationQueue.splice(0, HYDRATION_BATCH_SIZE);
                for (const fileName of batch) {
                    queuedFiles.delete(fileName);
                }

                const results = await Promise.all(batch.map(fileName => hydrateEntry(fileName, sessionId, false)));
                if (sessionId === hydrationSessionId && currentCharacterAvatar) {
                    const hydrated = [];
                    for (let i = 0; i < batch.length; i++) {
                        const entry = chatIndex[batch[i]];
                        if (results[i] && entry?.isLoaded && !entry.needsHydration) hydrated.push({ fileName: batch[i], entry });
                    }
                    putCachedChats(currentCharacterAvatar, hydrated);
                }
                if (sessionId === hydrationSessionId) emitHydrationUpdate();
                if (sessionId === hydrationSessionId && hydrationQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, HYDRATION_YIELD_MS));
                }
            }
        } catch (err) {
            console.error('[chat_manager] Hydration loop error:', err);
        } finally {
            if (sessionId !== hydrationSessionId) return;
            hydrationInProgress = false;

            // New items may have been queued while this loop was running.
            if (hydrationQueue.length > 0) {
                startHydrationLoop();
            } else {
                emitHydrationUpdate();
            }
        }
    }, 0);
}

/**
 * Build (or incrementally update) the index for the current character.
 * Metadata phase returns quickly; full chat hydration runs in the background.
 * @param {Function} [onProgress] - Called with (completed, total) for progress tracking
 * @param {Function} [onMetadataReady] - Called once metadata is available for immediate UI rendering
 * @returns {Promise<{ index: Object, changed: boolean, buildInProgress: boolean, hydrationStarted: boolean, isComplete: boolean }>}
 */
export async function buildIndex(onProgress, onMetadataReady, options = {}) {
    progressCallback = onProgress || null;

    if (indexBuildInProgress) {
        if (Object.keys(chatIndex).length > 0) {
            notifyMetadataReady(onMetadataReady, false);
        }
        emitHydrationUpdate();
        return getBuildStateResponse(false, true);
    }

    indexBuildInProgress = true;
    const buildToken = ++nextBuildToken;
    activeBuildToken = buildToken;
    const context = SillyTavern.getContext();

    if (context.characterId === undefined) {
        clearIndex();
        indexBuildInProgress = false;
        return getBuildStateResponse(false);
    }

    const character = context.characters[context.characterId];
    if (!character) {
        clearIndex();
        indexBuildInProgress = false;
        return getBuildStateResponse(false);
    }

    if (currentCharacterAvatar && currentCharacterAvatar !== character.avatar) {
        clearIndex();
        // clearIndex releases any older build. This invocation now owns the
        // freshly reset session and must retain the build lock across awaits.
        indexBuildInProgress = true;
        activeBuildToken = buildToken;
    }

    currentCharacterAvatar = character.avatar;
    const buildAvatar = character.avatar;
    const buildSessionId = hydrationSessionId;
    let changed = false;
    let metadataNotified = false;

    try {
        const chatList = await fetchChatList();
        if (buildSessionId !== hydrationSessionId || currentCharacterAvatar !== buildAvatar) {
            return getBuildStateResponse(false);
        }
        if (!chatList || !chatList.length) {
            changed = Object.keys(chatIndex).length > 0;
            for (const fileName of Object.keys(chatIndex)) removeCachedChat(character.avatar, fileName);
            chatIndex = {};
            if (changed) bumpIndexVersion();
            resetHydrationQueue();
            notifyMetadataReady(onMetadataReady, changed);
            emitHydrationUpdate();
            return getBuildStateResponse(changed);
        }

        const serverChats = new Map();
        for (const chatMeta of chatList) {
            const metaObj = normalizeMeta(chatMeta);
            if (!metaObj) continue;
            serverChats.set(metaObj.file_name, metaObj);
        }

        // Publish a metadata-only index before potentially large IndexedDB bodies
        // are read. Cached bodies and server hydration fill these entries afterward.
        for (const [fileName, metaObj] of serverChats) {
            if (chatIndex[fileName]) continue;
            const serverTimestamp = getMetaTimestamp(metaObj);
            const metaLastTimestamp = getMetaTimestampString(metaObj);
            chatIndex[fileName] = {
                fileName,
                lastModified: serverTimestamp,
                messageCount: getMetaMessageCount(metaObj) ?? 0,
                messages: [],
                firstMessageTimestamp: null,
                lastMessageTimestamp: metaLastTimestamp,
                firstTimestampMs: FALLBACK_SORT_TIMESTAMP,
                lastTimestampMs: normalizeTimestamp(metaLastTimestamp),
                sortTimestamp: serverTimestamp,
                initialOrder: allocateInitialOrder(),
                branchPoint: null,
                isLoaded: false,
                needsHydration: true,
                validatedAt: 0,
                serverSignature: metaSignature(metaObj),
                mainChat: canonicalFilename(metaObj.chat_metadata?.main_chat),
                chatEmbedding: null,
                chatEmbeddingHash: null,
                clusterLabel: null,
                messageEmbeddings: null,
            };
            markEntryForHydration(fileName);
            changed = true;
        }
        if (changed) {
            bumpIndexVersion();
            notifyMetadataReady(onMetadataReady, true);
            metadataNotified = true;
        }

        // Identity snapshots prevent this build from overwriting an entry
        // replaced by an active-chat event while IndexedDB is being read.
        const entriesBeforeCacheRead = new Map(Object.entries(chatIndex));
        const indexKeysBeforeCacheRead = new Set(Object.keys(chatIndex));

        // Loaded, unchanged entries already live in memory. Avoid cloning their
        // full message histories out of IndexedDB on every panel open.
        const cacheFiles = [];
        for (const [fileName, metaObj] of serverChats) {
            const entry = chatIndex[fileName];
            if (!options.forceRevalidate && !entry?.isLoaded) {
                cacheFiles.push(fileName);
            }
        }
        let idbCache = new Map();
        try {
            if (cacheFiles.length > 0) {
                idbCache = await getCachedChatsForCharacter(character.avatar, cacheFiles);
                if (buildSessionId !== hydrationSessionId || currentCharacterAvatar !== buildAvatar) {
                    return getBuildStateResponse(false);
                }
                for (const [fileName, entry] of idbCache) {
                    if (!Array.isArray(entry.messages)) continue;
                    for (const msg of entry.messages) {
                        if (!msg.filename) msg.filename = fileName;
                    }
                }
            }
        } catch {
            // IndexedDB unavailable — proceed without cache
        }

        const existingKeys = indexKeysBeforeCacheRead;

        for (const [fileName, metaObj] of serverChats) {
            existingKeys.delete(fileName);

            if (chatIndex[fileName] !== entriesBeforeCacheRead.get(fileName)) {
                changed = true;
                continue;
            }

            const serverTimestamp = getMetaTimestamp(metaObj);
            const signature = metaSignature(metaObj);
            const entry = chatIndex[fileName];
            normalizeEntryShape(entry);
            const metadataChanged = entry.lastModified !== serverTimestamp || entry.serverSignature !== signature;
            const reusable = !options.forceRevalidate && !entry.needsHydration && entry.isLoaded
                && !metadataChanged && recentlyValidated(entry);
            if (reusable) continue;

            const cached = idbCache.get(fileName);
            if (!options.forceRevalidate && !entry.isLoaded && cached
                && cached.lastModified === serverTimestamp && cached.serverSignature === signature
                && recentlyValidated(cached) && Array.isArray(cached.messages)) {
                chatIndex[fileName] = {
                    ...entry, ...cached, fileName, initialOrder: entry.initialOrder,
                    firstTimestampMs: normalizeTimestamp(cached.firstMessageTimestamp),
                    lastTimestampMs: normalizeTimestamp(cached.lastMessageTimestamp),
                    branchPoint: null, isLoaded: true, needsHydration: false,
                    chatEmbedding: null, chatEmbeddingHash: null, clusterLabel: null, messageEmbeddings: null,
                };
                queuedFiles.delete(fileName);
                changed = true;
            } else {
                // Keep the last successful body visible while revalidating; a
                // failed request must not turn known-good data into an empty chat.
                chatIndex[fileName] = {
                    ...entry, lastModified: serverTimestamp, serverSignature: signature,
                    sortTimestamp: metadataChanged ? serverTimestamp : entry.sortTimestamp,
                    needsHydration: true,
                };
                markEntryForHydration(fileName);
                changed = true;
            }
        }

        // Reconcile queue membership once, including all restored and deleted files.
        for (const deletedKey of existingKeys) {
            if (chatIndex[deletedKey] !== entriesBeforeCacheRead.get(deletedKey)) continue;
            delete chatIndex[deletedKey];
            queuedFiles.delete(deletedKey);
            removeCachedChat(character.avatar, deletedKey);
            changed = true;
        }
        hydrationQueue = hydrationQueue.filter(fileName => queuedFiles.has(fileName));

        // Seed only an identified, fully loaded live chat. Keep the current
        // invalidation/embedding guards in updateActiveChat rather than copy the
        // older branch's separate, less complete parsing implementation.
        const live = SillyTavern.getContext();
        const liveAvatar = live.characters?.[live.characterId]?.avatar;
        if (liveAvatar === buildAvatar && Array.isArray(live.chat) && live.chat.length > 0) {
            const activeFile = resolveActiveChatFilename(live, chatIndex);
            if (activeFile) changed = (await updateActiveChat(activeFile)) || changed;
            if (buildSessionId !== hydrationSessionId || currentCharacterAvatar !== buildAvatar) {
                return getBuildStateResponse(false);
            }
        }

        if (changed) {
            bumpIndexVersion();
            for (const entry of Object.values(chatIndex)) {
                entry.branchPoint = null;
            }
        }

        if (!metadataNotified) notifyMetadataReady(onMetadataReady, changed);

        emitHydrationUpdate();

        if (hydrationQueue.length > 0) {
            const activeFile = resolveActiveChatFilename(SillyTavern.getContext(), chatIndex);
            const recent = getSortedEntries().filter(entry => !entry.isLoaded || entry.needsHydration)
                .slice(0, 12).map(entry => entry.fileName);
            prioritizeHydrationFiles([activeFile, ...recent]);
            console.log(`[${MODULE_NAME}] Hydrating ${hydrationQueue.length} chats in background (${Object.keys(chatIndex).length} total)`);
            startHydrationLoop();
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error building index:`, err);
    } finally {
        if (activeBuildToken === buildToken) {
            indexBuildInProgress = false;
            activeBuildToken = null;
        }
    }

    return getBuildStateResponse(changed);
}

/**
 * Force-load one chat entry now (used by foreground operations).
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
export async function loadEntryNow(fileName) {
    const entry = chatIndex[fileName];
    if (!entry) return false;

    normalizeEntryShape(entry);

    if (entry.isLoaded && !entry.needsHydration) return true;

    queuedFiles.delete(fileName);
    hydrationQueue = hydrationQueue.filter(name => name !== fileName);

    const loaded = await hydrateEntry(fileName, hydrationSessionId);
    emitHydrationUpdate();
    return loaded;
}

/** Invalidate a locally edited body even when the manager panel is closed. */
export function markChatDirty(fileName) {
    const entry = chatIndex[fileName];
    if (!entry) return false;
    chatIndex[fileName] = { ...entry, needsHydration: true };
    // A same-length edit may not change list metadata, even after a page reload.
    if (currentCharacterAvatar) removeCachedChat(currentCharacterAvatar, fileName);
    markEntryForHydration(fileName);
    bumpIndexVersion();
    return true;
}

/** Remove an explicitly deleted local chat without retaining stale search results. */
export function removeChatFromIndex(fileName) {
    const resolved = canonicalFilename(fileName);
    if (!resolved || !chatIndex[resolved]) return false;
    delete chatIndex[resolved];
    queuedFiles.delete(resolved);
    hydrationQueue = hydrationQueue.filter(name => name !== resolved);
    if (currentCharacterAvatar) removeCachedChat(currentCharacterAvatar, resolved);
    bumpIndexVersion();
    emitHydrationUpdate();
    return true;
}

/**
 * Update only the active chat's entry in the index (lightweight, no full rebuild).
 * Reads from SillyTavern's in-memory chat array when possible, avoiding an HTTP request.
 * @param {string} fileName - The chat file to update
 * @returns {Promise<boolean>} Whether the entry was actually updated
 */
export async function updateActiveChat(fileName) {
    if (!fileName || !chatIndex[fileName]) return false;

    try {
        // Prefer in-memory chat data over HTTP fetch
        const context = SillyTavern.getContext();
        let chatData;
        if (Array.isArray(context.chat)) {
            chatData = context.chat;
        } else {
            chatData = await fetchChatContent(fileName);
        }

        const messages = parseMessages(chatData, fileName);
        const cached = chatIndex[fileName];
        const firstTimestamp = messages.length > 0 ? messages[0].timestamp : null;
        const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
        const parsedLastModified = timestampMs(lastTimestamp) ?? NaN;
        const hasValidLastModified = Number.isFinite(parsedLastModified);
        const effectiveLastTs = lastTimestamp || cached.lastMessageTimestamp;

        const mainChat = mainChatFromData(chatData, context.chatMetadata);
        if (cached.isLoaded && !cached.needsHydration && (cached.mainChat || null) === mainChat && messagesEqual(cached.messages, messages)) {
            queuedFiles.delete(fileName);
            hydrationQueue = hydrationQueue.filter(name => name !== fileName);
            return false;
        }

        const updated = {
            ...cached,
            messageCount: messages.length,
            messages,
            firstMessageTimestamp: firstTimestamp,
            lastMessageTimestamp: effectiveLastTs,
            firstTimestampMs: normalizeTimestamp(firstTimestamp),
            lastTimestampMs: normalizeTimestamp(effectiveLastTs),
            lastModified: hasValidLastModified ? parsedLastModified : cached.lastModified,
            sortTimestamp: hasValidLastModified ? parsedLastModified : cached.sortTimestamp,
            branchPoint: null,
            isLoaded: true,
            needsHydration: false,
            validatedAt: Date.now(),
            mainChat,
            messageEmbeddings: retainMessageEmbeddings(cached, messages),
        };
        if (getRepresentativeEmbeddingText(cached) !== getRepresentativeEmbeddingText(updated)) {
            updated.chatEmbedding = null;
            updated.chatEmbeddingHash = null;
            updated.clusterLabel = null;
        }
        chatIndex[fileName] = updated;
        bumpIndexVersion();

        if (currentCharacterAvatar) {
            putCachedChat(currentCharacterAvatar, fileName, chatIndex[fileName]);
        }

        queuedFiles.delete(fileName);
        hydrationQueue = hydrationQueue.filter(name => name !== fileName);
        emitHydrationUpdate();
        return true;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error updating active chat:`, err);
        return false;
    }
}

/**
 * Run branch detection on the current index. Designed to be called deferred (via setTimeout).
 * @param {string} activeFilename - The currently active chat filename
 */
export function runDeferredBranchDetection(activeFilename) {
    detectBranches(chatIndex, activeFilename);
}

/**
 * Detect branch points by comparing each chat against the active chat.
 * @param {Object} index - The chat index to analyze
 * @param {string} activeFilename - The currently active chat filename
 */
function detectBranches(index, activeFilename) {
    // Reset all branch points (detection is relative to the active chat)
    for (const entry of Object.values(index)) {
        entry.branchPoint = null;
    }

    const activeEntry = activeFilename ? index[activeFilename] : null;
    if (!activeEntry || !activeEntry.isLoaded || activeEntry.messages.length < 2) return;
    const related = relatedThreadNames(index, activeFilename);

    for (const entry of Object.values(index)) {
        if (entry.fileName === activeFilename) continue;
        if (!entry.isLoaded || entry.messages.length < 2) continue;
        if (!related.has(entry.fileName)) continue;

        const branchPoint = computeRelatedBranchPoint(activeEntry.messages, entry.messages);
        if (branchPoint !== null) {
            entry.branchPoint = branchPoint;
        }
    }
}

/**
 * Compute where two threads diverge.
 * Returns the first differing message index, or the shared-length boundary if one is a strict
 * prefix of the other. Returns null when threads do not share the same starting message.
 * @param {IndexMessage[]} baseMessages
 * @param {IndexMessage[]} candidateMessages
 * @returns {number|null}
 */
export function computeBranchPoint(baseMessages, candidateMessages) {
    if (!Array.isArray(baseMessages) || !Array.isArray(candidateMessages)) return null;
    if (baseMessages.length < 2 || candidateMessages.length < 2) return null;

    let candidateCache = branchPointCache.get(baseMessages);
    if (!candidateCache) {
        candidateCache = new WeakMap();
        branchPointCache.set(baseMessages, candidateCache);
    } else if (candidateCache.has(candidateMessages)) {
        return candidateCache.get(candidateMessages);
    }

    if (candidateMessages[0]?.text !== baseMessages[0]?.text || candidateMessages[0]?.role !== baseMessages[0]?.role) {
        candidateCache.set(candidateMessages, null);
        return null;
    }

    const maxCompare = Math.min(candidateMessages.length, baseMessages.length);
    let divergeAt = maxCompare;

    for (let k = 1; k < maxCompare; k++) {
        if (candidateMessages[k]?.text !== baseMessages[k]?.text || candidateMessages[k]?.role !== baseMessages[k]?.role) {
            divergeAt = k;
            break;
        }
    }

    const result = divergeAt > 0 ? divergeAt : null;
    candidateCache.set(candidateMessages, result);
    return result;
}

function computeRelatedBranchPoint(baseMessages, candidateMessages) {
    // Provenance also permits a branch made from an alternate first greeting.
    if (baseMessages.length && candidateMessages.length
        && (baseMessages[0].text !== candidateMessages[0].text || baseMessages[0].role !== candidateMessages[0].role)) return 0;
    return computeBranchPoint(baseMessages, candidateMessages);
}

function sortSiblingContextByRecency(siblings) {
    siblings.sort((a, b) => {
        const aLast = a.messages[a.messages.length - 1];
        const bLast = b.messages[b.messages.length - 1];
        const aTime = aLast?.timestamp ? normalizeTimestamp(aLast.timestamp) : 0;
        const bTime = bLast?.timestamp ? normalizeTimestamp(bLast.timestamp) : 0;
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
}

/**
 * Get sibling branch context for the active chat.
 * Returns post-divergence messages from sibling branches (chats that share a common prefix
 * with the active chat but diverge at some point).
 * @param {string} activeFilename - The currently active chat filename
 * @param {number} [maxBranches=3] - Maximum number of sibling branches to return
 * @returns {Array<{ fileName: string, branchPoint: number, messages: IndexMessage[] }>}
 */
export function getSiblingBranchContext(activeFilename, maxBranches = 3) {
    if (!activeFilename) return [];

    const siblings = [];

    for (const entry of Object.values(chatIndex)) {
        if (entry.fileName === activeFilename) continue;
        if (!entry.isLoaded || entry.branchPoint === null) continue;

        // Collect all messages after the branch point
        const postBranchMessages = entry.messages.slice(entry.branchPoint);
        if (postBranchMessages.length === 0) continue;

        siblings.push({
            fileName: entry.fileName,
            branchPoint: entry.branchPoint,
            messages: postBranchMessages,
        });
    }

    // Sort by most recent activity (newest first), then cap
    sortSiblingContextByRecency(siblings);

    return siblings.slice(0, maxBranches);
}

/**
 * Get sibling branch context relative to an arbitrary base thread.
 * Unlike active-chat branch detection, this helper never mutates global entry.branchPoint values.
 * @param {string} baseFilename - Filename of the thread being summarized
 * @param {number} [maxBranches=3] - Maximum number of sibling branches to return
 * @returns {Array<{ fileName: string, branchPoint: number, messages: IndexMessage[] }>}
 */
export function getSiblingBranchContextForThread(baseFilename, maxBranches = 3) {
    if (!baseFilename) return [];

    const baseEntry = chatIndex[baseFilename];
    if (!baseEntry || !baseEntry.isLoaded || baseEntry.messages.length < 2) return [];

    const siblings = [];
    const related = relatedThreadNames(chatIndex, baseFilename);

    for (const entry of Object.values(chatIndex)) {
        if (entry.fileName === baseFilename) continue;
        if (!entry.isLoaded || entry.messages.length < 2) continue;
        if (!related.has(entry.fileName)) continue;

        const branchPoint = computeRelatedBranchPoint(baseEntry.messages, entry.messages);
        if (branchPoint === null) continue;

        const postBranchMessages = entry.messages.slice(branchPoint);
        if (postBranchMessages.length === 0) continue;

        siblings.push({
            fileName: entry.fileName,
            branchPoint,
            messages: postBranchMessages,
        });
    }

    sortSiblingContextByRecency(siblings);
    return siblings.slice(0, maxBranches);
}

/** Host provenance defines families; shared greetings alone never authorize injection. */
function relatedThreadNames(index, baseFilename) {
    const links = new Map();
    const connect = (a, b) => {
        if (!a || !b || a === b) return;
        if (!links.has(a)) links.set(a, new Set());
        if (!links.has(b)) links.set(b, new Set());
        links.get(a).add(b);
        links.get(b).add(a);
    };
    for (const entry of Object.values(index)) {
        connect(entry.fileName, canonicalFilename(entry.mainChat));
        for (const message of entry.messages || []) {
            for (const branch of message.branches || []) connect(entry.fileName, canonicalFilename(branch));
        }
    }
    const related = new Set([baseFilename]);
    const pending = [baseFilename];
    while (pending.length) {
        for (const name of links.get(pending.pop()) || []) {
            if (related.has(name)) continue;
            related.add(name);
            pending.push(name);
        }
    }
    return related;
}

/**
 * Get the current chat index.
 * @returns {Object}
 */
export function getIndex() {
    return chatIndex;
}

/**
 * Get a stable, recent-first snapshot of entries.
 * @returns {ChatIndexEntry[]}
 */
export function getSortedEntries() {
    const entries = Object.values(chatIndex);
    entries.sort(compareByRecency);
    return entries;
}

/**
 * Get the avatar of the character the index was built for.
 * @returns {string|null}
 */
export function getIndexCharacterAvatar() {
    return currentCharacterAvatar;
}

/**
 * Clear the index (e.g., when no character is selected).
 */
export function clearIndex() {
    chatIndex = {};
    currentCharacterAvatar = null;
    nextInitialOrder = 0;
    progressCallback = null;
    indexBuildInProgress = false;
    activeBuildToken = null;
    bumpIndexVersion();
    resetHydrationQueue();
    emitHydrationUpdate();
}

/**
 * Check if an index build is currently in progress.
 * @returns {boolean}
 */
export function isBuilding() {
    return indexBuildInProgress || hydrationInProgress;
}

/**
 * Check whether a specific thread entry is fully loaded.
 * @param {string} fileName
 * @returns {boolean}
 */
export function isEntryLoaded(fileName) {
    const entry = chatIndex[fileName];
    return !!entry && !!entry.isLoaded && !entry.needsHydration;
}

/**
 * Check whether all entries are fully loaded.
 * @returns {boolean}
 */
export function isHydrationComplete() {
    const entries = Object.values(chatIndex);
    if (entries.length === 0) return true;
    return entries.every(entry => entry.isLoaded && !entry.needsHydration);
}

/**
 * Get hydration progress for current character index.
 * @returns {{ loaded: number, total: number }}
 */
export function getHydrationProgress() {
    const entries = Object.values(chatIndex);
    const total = entries.length;
    let loaded = 0;

    for (const entry of entries) {
        if (entry.isLoaded && !entry.needsHydration) loaded++;
    }

    return { loaded, total };
}

/**
 * Subscribe to hydration updates.
 * @param {(progress: { loaded: number, total: number, complete: boolean }) => void} callback
 * @returns {() => void} unsubscribe function
 */
export function onHydrationUpdate(callback) {
    hydrationListeners.add(callback);
    return () => hydrationListeners.delete(callback);
}

/**
 * Get the current index version (bumped on every mutation).
 * @returns {number}
 */
export function getIndexVersion() {
    return indexVersion;
}

/**
 * Get a filtered and sorted snapshot of entries.
 * @param {{ tags: string[], dateFrom: string|null, dateTo: string|null, messageCountMin: number|null, messageCountMax: number|null }} filterState
 * @param {{ field: string, direction: string, secondaryField?: string }} sortState
 * @param {(fileName: string) => Object} getChatMetaFn - function to retrieve per-chat metadata
 * @returns {ChatIndexEntry[]}
 */
export function getFilteredSortedEntries(filterState, sortState, getChatMetaFn) {
    let entries = Object.values(chatIndex);

    // ── Filter: tags (OR logic) ──
    if (filterState.tags && filterState.tags.length > 0) {
        const filterTags = new Set(filterState.tags);
        entries = entries.filter(entry => {
            const meta = getChatMetaFn(entry.fileName);
            const chatTags = Array.isArray(meta.tags) ? meta.tags : [];
            return chatTags.some(t => filterTags.has(t));
        });
    }

    // ── Filter: date range (AND with above) ──
    // dateBasis selects which timestamp a thread is judged by:
    //   'created'      → first message time, 'lastActivity' (default) → last message time.
    // Both bounds are applied to that single timestamp so the range reads intuitively.
    const useCreated = filterState.dateBasis === 'created';
    const entryDateMs = (entry) => {
        const ts = useCreated ? entry.firstTimestampMs : entry.lastTimestampMs;
        return Number.isFinite(ts) ? ts : entry.sortTimestamp;
    };
    if (filterState.dateFrom) {
        const from = localDateBoundary(filterState.dateFrom);
        if (from !== null) {
            entries = entries.filter(entry => {
                const ts = entryDateMs(entry);
                return Number.isFinite(ts) && ts >= from;
            });
        }
    }
    if (filterState.dateTo) {
        // Exclusive next local midnight keeps both bounds correct across DST.
        const to = localDateBoundary(filterState.dateTo, true);
        if (to !== null) {
            entries = entries.filter(entry => {
                const ts = entryDateMs(entry);
                return Number.isFinite(ts) && ts < to;
            });
        }
    }

    // ── Filter: message count range (AND) ──
    if (Number.isFinite(filterState.messageCountMin)) {
        entries = entries.filter(entry => entry.messageCount >= filterState.messageCountMin);
    }
    if (Number.isFinite(filterState.messageCountMax)) {
        entries = entries.filter(entry => entry.messageCount <= filterState.messageCountMax);
    }

    // ── Sort ──
    const dir = sortState.direction === 'asc' ? 1 : -1;
    const field = sortState.field || 'recency';
    const secondaryFieldRaw = sortState.secondaryField || 'recency';
    const secondaryField = secondaryFieldRaw === 'cluster' ? 'recency' : secondaryFieldRaw;

    const compareByField = (a, b, fieldName) => {
        switch (fieldName) {
            case 'recency': {
                const aTime = Number.isFinite(a.sortTimestamp) ? a.sortTimestamp : FALLBACK_SORT_TIMESTAMP;
                const bTime = Number.isFinite(b.sortTimestamp) ? b.sortTimestamp : FALLBACK_SORT_TIMESTAMP;
                return aTime - bTime;
            }
            case 'alphabetical': {
                const aName = (getChatMetaFn(a.fileName).displayName || a.fileName).toLowerCase();
                const bName = (getChatMetaFn(b.fileName).displayName || b.fileName).toLowerCase();
                return aName.localeCompare(bName);
            }
            case 'messageCount':
                return a.messageCount - b.messageCount;
            case 'created': {
                const aFirst = a.firstTimestampMs ?? FALLBACK_SORT_TIMESTAMP;
                const bFirst = b.firstTimestampMs ?? FALLBACK_SORT_TIMESTAMP;
                return aFirst - bFirst;
            }
            default:
                return 0;
        }
    };

    entries.sort((a, b) => {
        let cmp = 0;
        switch (field) {
            case 'cluster': {
                cmp = (a.clusterLabel ?? 999) - (b.clusterLabel ?? 999);
                if (cmp === 0) {
                    cmp = compareByField(a, b, secondaryField);
                }
                break;
            }
            case 'recency':
            case 'alphabetical':
            case 'messageCount':
            case 'created':
                cmp = compareByField(a, b, field);
                break;
            default:
                cmp = 0;
        }

        if (cmp !== 0) return cmp * dir;

        // Tie-breaker: initialOrder then fileName
        const aOrder = Number.isFinite(a.initialOrder) ? a.initialOrder : Number.MAX_SAFE_INTEGER;
        const bOrder = Number.isFinite(b.initialOrder) ? b.initialOrder : Number.MAX_SAFE_INTEGER;
        if (aOrder !== bOrder) return aOrder - bOrder;
        return a.fileName.localeCompare(b.fileName);
    });

    return entries;
}

/**
 * Build a flat array of loaded messages for search.
 * Returns a cached array if the index hasn't changed since the last call.
 * @returns {Array}
 */
export function getSearchableMessages() {
    if (cachedSearchableMessages && cachedSearchableVersion === indexVersion) {
        return cachedSearchableMessages;
    }

    const messages = [];
    for (const chatData of Object.values(chatIndex)) {
        if (!chatData.isLoaded) continue;

        for (const msg of chatData.messages) {
            if (!msg.filename) msg.filename = chatData.fileName;
            messages.push(msg);
        }
    }

    // Sort by recency (newest messages first)
    messages.sort((a, b) => {
        const aTime = Number.isFinite(a.timestampMs) ? a.timestampMs : normalizeTimestamp(a.timestamp);
        const bTime = Number.isFinite(b.timestampMs) ? b.timestampMs : normalizeTimestamp(b.timestamp);
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    cachedSearchableMessages = messages;
    cachedSearchableVersion = indexVersion;
    return messages;
}
