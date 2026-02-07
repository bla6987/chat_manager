/**
 * Chat Reader — JSONL parsing, search index building, branch detection.
 * Never modifies any chat files.
 */

import { getCachedChatsForCharacter, putCachedChat, removeCachedChat } from './cache-store.js';

const MODULE_NAME = 'chat_manager';
const HYDRATION_BATCH_SIZE = 50;
const FALLBACK_SORT_TIMESTAMP = 0;

/** @type {Object<string, ChatIndexEntry>} filename -> index entry */
let chatIndex = {};
let currentCharacterAvatar = null;
let indexBuildInProgress = false;
let nextInitialOrder = 0;

let hydrationQueue = [];
let queuedFiles = new Set();
let hydrationInProgress = false;
let hydrationSessionId = 0;
const entryHydrationPromises = new Map();
const hydrationListeners = new Set();
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
 */

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
        return [];
    }

    return await response.json();
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
        return [];
    }

    return await response.json();
}

/**
 * Parse messages from a chat data array into our index format.
 * @param {Array} chatData - Raw message objects from the server
 * @param {string} fileName - Chat filename
 * @returns {IndexMessage[]}
 */
function parseMessages(chatData, fileName) {
    const messages = [];
    for (let i = 0; i < chatData.length; i++) {
        const msg = chatData[i];
        // Skip metadata-only entries (no 'mes' field)
        if (!msg || typeof msg.mes !== 'string') continue;

        messages.push({
            filename: fileName,
            index: i,
            role: msg.is_user ? 'user' : 'assistant',
            text: msg.mes,
            timestamp: msg.send_date || '',
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

    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : FALLBACK_SORT_TIMESTAMP;
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
    if (!entry || entry.isLoaded) return;
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

function bumpIndexVersion() {
    indexVersion++;
}

function normalizeEntryShape(entry) {
    if (!entry || typeof entry !== 'object') return;

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

    if (typeof entry.isLoaded !== 'boolean') {
        entry.isLoaded = entry.messages.length > 0;
    }

    if (entry.isLoaded) {
        for (const msg of entry.messages) {
            if (!msg.filename) msg.filename = entry.fileName;
        }
    }
}

/**
 * Fetch and hydrate a single entry, re-trying if metadata changed during fetch.
 * @param {string} fileName
 * @param {number} sessionId
 * @returns {Promise<boolean>}
 */
async function hydrateEntry(fileName, sessionId) {
    if (entryHydrationPromises.has(fileName)) {
        return entryHydrationPromises.get(fileName);
    }

    const promise = (async () => {
        while (sessionId === hydrationSessionId) {
            const entry = chatIndex[fileName];
            if (!entry) return false;
            if (entry.isLoaded) return true;

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

            // Metadata changed while this request was in flight.
            if (current.lastModified !== expectedTimestamp) {
                continue;
            }

            const messages = parseMessages(chatData, fileName);

            chatIndex[fileName] = {
                ...current,
                messageCount: messages.length,
                messages,
                firstMessageTimestamp: messages.length > 0 ? messages[0].timestamp : null,
                lastMessageTimestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : current.lastMessageTimestamp,
                branchPoint: null,
                isLoaded: true,
            };
            bumpIndexVersion();

            if (currentCharacterAvatar) {
                putCachedChat(currentCharacterAvatar, fileName, chatIndex[fileName]);
            }

            return true;
        }

        return false;
    })().finally(() => {
        entryHydrationPromises.delete(fileName);
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

                await Promise.all(batch.map(fileName => hydrateEntry(fileName, sessionId)));
                emitHydrationUpdate();
            }
        } catch (err) {
            console.error('[chat_manager] Hydration loop error:', err);
        } finally {
            hydrationInProgress = false;

            // New items may have been queued while this loop was running.
            if (sessionId === hydrationSessionId && hydrationQueue.length > 0) {
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
export async function buildIndex(onProgress, onMetadataReady) {
    progressCallback = onProgress || null;

    if (indexBuildInProgress) {
        if (Object.keys(chatIndex).length > 0) {
            notifyMetadataReady(onMetadataReady, false);
        }
        emitHydrationUpdate();
        return getBuildStateResponse(false, true);
    }

    indexBuildInProgress = true;
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
    }

    currentCharacterAvatar = character.avatar;
    let changed = false;

    try {
        const chatList = await fetchChatList();
        if (!chatList || !chatList.length) {
            changed = Object.keys(chatIndex).length > 0;
            chatIndex = {};
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

        // Bulk-read IndexedDB cache for this character
        let idbCache = new Map();
        try {
            idbCache = await getCachedChatsForCharacter(character.avatar);
        } catch {
            // IndexedDB unavailable — proceed without cache
        }

        const existingKeys = new Set(Object.keys(chatIndex));

        for (const [fileName, metaObj] of serverChats) {
            existingKeys.delete(fileName);

            const serverTimestamp = getMetaTimestamp(metaObj);
            const metaLastTimestamp = getMetaTimestampString(metaObj);
            const metaMessageCount = getMetaMessageCount(metaObj);

            const cached = chatIndex[fileName];
            if (!cached) {
                // Check IndexedDB cache before scheduling hydration
                const idbEntry = idbCache.get(fileName);
                if (idbEntry && idbEntry.lastModified === serverTimestamp && Array.isArray(idbEntry.messages) && idbEntry.messages.length > 0) {
                    changed = true;
                    chatIndex[fileName] = {
                        fileName,
                        lastModified: serverTimestamp,
                        messageCount: idbEntry.messageCount,
                        messages: idbEntry.messages,
                        firstMessageTimestamp: idbEntry.firstMessageTimestamp,
                        lastMessageTimestamp: idbEntry.lastMessageTimestamp || metaLastTimestamp,
                        sortTimestamp: idbEntry.sortTimestamp || serverTimestamp,
                        initialOrder: allocateInitialOrder(),
                        branchPoint: null,
                        isLoaded: true,
                    };
                    continue;
                }

                changed = true;
                chatIndex[fileName] = {
                    fileName,
                    lastModified: serverTimestamp,
                    messageCount: metaMessageCount ?? 0,
                    messages: [],
                    firstMessageTimestamp: null,
                    lastMessageTimestamp: metaLastTimestamp,
                    sortTimestamp: serverTimestamp,
                    initialOrder: allocateInitialOrder(),
                    branchPoint: null,
                    isLoaded: false,
                };
                markEntryForHydration(fileName);
                continue;
            }

            normalizeEntryShape(cached);

            const timestampChanged = cached.lastModified !== serverTimestamp;
            cached.lastModified = serverTimestamp;
            if (timestampChanged) {
                cached.sortTimestamp = serverTimestamp;
            }

            if (metaLastTimestamp) {
                cached.lastMessageTimestamp = metaLastTimestamp;
            }

            if (timestampChanged) {
                changed = true;
                // Check IndexedDB cache for updated entry
                const idbEntry = idbCache.get(fileName);
                if (idbEntry && idbEntry.lastModified === serverTimestamp && Array.isArray(idbEntry.messages) && idbEntry.messages.length > 0) {
                    cached.isLoaded = true;
                    cached.messages = idbEntry.messages;
                    cached.messageCount = idbEntry.messageCount;
                    cached.firstMessageTimestamp = idbEntry.firstMessageTimestamp;
                    cached.lastMessageTimestamp = idbEntry.lastMessageTimestamp || metaLastTimestamp;
                    cached.branchPoint = null;
                } else {
                    cached.isLoaded = false;
                    cached.messages = [];
                    cached.branchPoint = null;
                    cached.firstMessageTimestamp = null;
                    if (metaMessageCount !== null) {
                        cached.messageCount = metaMessageCount;
                    } else {
                        cached.messageCount = 0;
                    }
                    markEntryForHydration(fileName);
                }
            } else if (!cached.isLoaded) {
                // Check IndexedDB cache before scheduling hydration
                const idbEntry = idbCache.get(fileName);
                if (idbEntry && idbEntry.lastModified === serverTimestamp && Array.isArray(idbEntry.messages) && idbEntry.messages.length > 0) {
                    cached.isLoaded = true;
                    cached.messages = idbEntry.messages;
                    cached.messageCount = idbEntry.messageCount;
                    cached.firstMessageTimestamp = idbEntry.firstMessageTimestamp;
                    cached.lastMessageTimestamp = idbEntry.lastMessageTimestamp || metaLastTimestamp;
                    cached.branchPoint = null;
                    changed = true;
                } else {
                    if (metaMessageCount !== null) {
                        cached.messageCount = metaMessageCount;
                    }
                    markEntryForHydration(fileName);
                }
            }

            if (cached.isLoaded) {
                // Ensure older cached messages can be searched lazily.
                for (const msg of cached.messages) {
                    if (!msg.filename) msg.filename = fileName;
                }
            }
        }

        // existingKeys now contains deleted chats
        for (const deletedKey of existingKeys) {
            delete chatIndex[deletedKey];
            queuedFiles.delete(deletedKey);
            hydrationQueue = hydrationQueue.filter(name => name !== deletedKey);
            removeCachedChat(character.avatar, deletedKey);
            changed = true;
        }

        if (changed) {
            bumpIndexVersion();
            for (const entry of Object.values(chatIndex)) {
                entry.branchPoint = null;
            }
        }

        notifyMetadataReady(onMetadataReady, changed);

        emitHydrationUpdate();

        if (hydrationQueue.length > 0) {
            console.log(`[${MODULE_NAME}] Hydrating ${hydrationQueue.length} chats in background (${Object.keys(chatIndex).length} total)`);
            startHydrationLoop();
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error building index:`, err);
    } finally {
        indexBuildInProgress = false;
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

    if (entry.isLoaded) return true;

    queuedFiles.delete(fileName);
    hydrationQueue = hydrationQueue.filter(name => name !== fileName);

    const loaded = await hydrateEntry(fileName, hydrationSessionId);
    emitHydrationUpdate();
    return loaded;
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
        if (Array.isArray(context.chat) && context.chat.length > 0) {
            chatData = context.chat;
        } else {
            chatData = await fetchChatContent(fileName);
        }

        const messages = parseMessages(chatData, fileName);
        const cached = chatIndex[fileName];
        const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
        const parsedLastModified = lastTimestamp ? new Date(lastTimestamp).getTime() : NaN;
        const hasValidLastModified = Number.isFinite(parsedLastModified);

        chatIndex[fileName] = {
            ...cached,
            messageCount: messages.length,
            messages,
            firstMessageTimestamp: messages.length > 0 ? messages[0].timestamp : null,
            lastMessageTimestamp: lastTimestamp || cached.lastMessageTimestamp,
            lastModified: hasValidLastModified ? parsedLastModified : cached.lastModified,
            sortTimestamp: hasValidLastModified ? parsedLastModified : cached.sortTimestamp,
            branchPoint: null,
            isLoaded: true,
        };
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

    for (const entry of Object.values(index)) {
        if (entry.fileName === activeFilename) continue;
        if (!entry.isLoaded || entry.messages.length < 2) continue;

        // Check if first messages match
        if (entry.messages[0]?.text !== activeEntry.messages[0]?.text) continue;

        // Compare ALL shared messages to find actual divergence point
        const maxCompare = Math.min(entry.messages.length, activeEntry.messages.length);
        let divergeAt = maxCompare;

        for (let k = 1; k < maxCompare; k++) {
            if (entry.messages[k]?.text !== activeEntry.messages[k]?.text) {
                divergeAt = k;
                break;
            }
        }

        if (divergeAt > 0) {
            entry.branchPoint = divergeAt;
        }
    }
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
    return !!entry && !!entry.isLoaded;
}

/**
 * Check whether all entries are fully loaded.
 * @returns {boolean}
 */
export function isHydrationComplete() {
    const entries = Object.values(chatIndex);
    if (entries.length === 0) return true;
    return entries.every(entry => entry.isLoaded);
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
        if (entry.isLoaded) loaded++;
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

    cachedSearchableMessages = messages;
    cachedSearchableVersion = indexVersion;
    return messages;
}
