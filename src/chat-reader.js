/**
 * Chat Reader — JSONL parsing, search index building, branch detection.
 * Never modifies any chat files.
 */

import { getCachedBody, getCachedDescriptors, getCachedSummaries, putCachedBody, putCachedChat, removeCachedChat, flushPendingCacheWrites } from './cache-store.js';
import { LAST_MESSAGE_PREVIEW_CHARS, canonicalFilename, decodeDescriptors, embeddingTextFromMessages, encodeDescriptors, indexChatData, indexChatText, mainChatFromData, parseMessages, summarizeChat } from './chat-index-data.js';
import { IndexWorkerUnavailable, indexChatTextInWorker, isIndexWorkerAvailable } from './chat-index-client.js';
import { getRepresentativeEmbeddingText } from './embedding-text.js';
import { timestampMs, localDateBoundary } from './timestamps.js';
import { resolveActiveChatFilename } from './active-chat.js';
import { createMessageDescriptor, estimateMessageBodyBytes, messagePreview, sameMessageContent } from './message-descriptors.js';
import { isVector, toFloat32Vector, vectorByteLength, ByteBudgetLRU } from './vector-utils.js';
export { messageFingerprint, normalizedMessageFingerprint, sameMessageContent } from './message-descriptors.js';

const MODULE_NAME = 'chat_manager';
const HYDRATION_BATCH_SIZE = 2;
const HYDRATION_YIELD_MS = 16;
const FALLBACK_SORT_TIMESTAMP = 0;
const EMPTY_MESSAGE_PLACEHOLDER = '[The message is empty]';

/** @type {Object<string, ChatIndexEntry>} filename -> index entry */
let chatIndex = {};
let currentCharacterAvatar = null;
let indexBuildInProgress = false;
let nextBuildToken = 0;
let activeBuildToken = null;
let nextInitialOrder = 0;
// Most work needs no chat bodies. Only callers that need the whole archive set
// this, including while another build is running.
let backgroundHydrationRequested = false;
let forcedBuildPending = false;
let lastBuildFailed = false;

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

export const DEFAULT_BODY_CACHE_BYTES = 96 * 1024 * 1024;
let bodyCacheBudget = DEFAULT_BODY_CACHE_BYTES;
let residentBodyBytes = 0;
let activeBodyFile = null;
const residentBodies = new Map();
const messageDescriptors = new WeakMap();
export const DEFAULT_VECTOR_CACHE_BYTES = 64 * 1024 * 1024;
const vectorOwners = new Map(); // WeakRefs support detached test/extension entries without retaining bodies.
const vectorKeysByFile = new Map();
const residentVectors = new ByteBudgetLRU({
    maxBytes: DEFAULT_VECTOR_CACHE_BYTES,
    onEvict(key, item) {
        vectorKeysByFile.get(item.fileName)?.delete(key);
        const entry = chatIndex[item.fileName] || vectorOwners.get(item.fileName)?.deref();
        if (!entry) return;
        if (item.type === 'chat') {
            if (entry.chatEmbedding === item.vector) entry.chatEmbedding = null;
        } else if (entry.messageEmbeddings?.get(item.msgKey) === item.vector) {
            entry.messageEmbeddings.delete(item.msgKey);
            entry.messageEmbeddingVersion = (entry.messageEmbeddingVersion || 0) + 1;
        }
    },
});

function vectorKey(fileName, type, msgKey = '') { return `${fileName}\u0000${type}\u0000${msgKey}`; }

function rememberVector(entry, type, msgKey, vector) {
    const key = vectorKey(entry.fileName, type, msgKey);
    if (residentVectors.peek(key)?.vector === vector) { residentVectors.get(key); return true; }
    if (typeof WeakRef === 'function') vectorOwners.set(entry.fileName, new WeakRef(entry));
    const stored = residentVectors.set(key, { fileName: entry.fileName, msgKey, vector, type }, vectorByteLength(vector));
    if (stored) {
        if (!vectorKeysByFile.has(entry.fileName)) vectorKeysByFile.set(entry.fileName, new Set());
        vectorKeysByFile.get(entry.fileName).add(key);
    }
    return stored;
}

function syncEntryVectorBudget(entry) {
    for (const key of [...(vectorKeysByFile.get(entry.fileName) || [])]) {
        const item = residentVectors.peek(key);
        const current = item?.type === 'chat' ? entry.chatEmbedding : entry.messageEmbeddings?.get(item?.msgKey);
        if (current !== item?.vector) residentVectors.delete(key);
    }
    if (isVector(entry.chatEmbedding)) setChatEmbedding(entry, entry.chatEmbedding, entry.chatEmbeddingHash);
    for (const [key, vector] of entry.messageEmbeddings || []) {
        if (!isVector(vector)) continue;
        const compact = toFloat32Vector(vector);
        if (rememberVector(entry, 'message', key, compact)) entry.messageEmbeddings.set(key, compact);
        else entry.messageEmbeddings.delete(key);
    }
}

export function setVectorCacheBudget(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Vector cache budget must be a nonnegative number of bytes');
    residentVectors.maxBytes = Math.floor(bytes);
    return getVectorCacheStats();
}

export function getVectorCacheStats() {
    return { budgetBytes: residentVectors.maxBytes, residentBytes: residentVectors.bytes, residentVectors: residentVectors.size };
}

export function clearResidentVectors({ clearCachedKeys = false } = {}) {
    residentVectors.clear();
    vectorKeysByFile.clear();
    vectorOwners.clear();
    for (const entry of Object.values(chatIndex)) {
        entry.chatEmbedding = null;
        entry.messageEmbeddings = null;
        if (clearCachedKeys) {
            entry.cachedMessageEmbeddingKeys = new Set();
            entry.cachedChatEmbeddingHash = null;
        }
    }
}

export function setChatEmbedding(entry, vector, hash = null) {
    if (!entry || !isVector(vector)) return false;
    entry.cachedChatEmbeddingHash = hash;
    if (vector.length * Float32Array.BYTES_PER_ELEMENT > residentVectors.maxBytes) {
        residentVectors.delete(vectorKey(entry.fileName, 'chat'));
        entry.chatEmbedding = null;
        entry.chatEmbeddingHash = hash;
        return false;
    }
    const compact = toFloat32Vector(vector);
    if (!rememberVector(entry, 'chat', '', compact)) return false;
    entry.chatEmbedding = compact;
    entry.chatEmbeddingHash = hash;
    return true;
}

function descriptorsFor(messages) {
    return (messages || []).map(message => {
        if (message?.isDescriptor) return message;
        let descriptor = messageDescriptors.get(message);
        if (!descriptor) {
            descriptor = createMessageDescriptor(message);
            messageDescriptors.set(message, descriptor);
        }
        return descriptor;
    });
}

function invalidateSearchableCache() {
    cachedSearchableMessages = null;
    cachedSearchableVersion = -1;
}

function activeFileForCache() {
    const context = globalThis.SillyTavern?.getContext?.();
    const avatar = context?.characters?.[context.characterId]?.avatar;
    if (currentCharacterAvatar && avatar !== currentCharacterAvatar) return null;
    return (context && resolveActiveChatFilename(context, chatIndex)) || activeBodyFile;
}

function forgetResidentBody(fileName) {
    const cached = residentBodies.get(fileName);
    if (cached) residentBodyBytes -= cached.bytes;
    residentBodies.delete(fileName);
}

function rememberResidentBody(entry) {
    forgetResidentBody(entry.fileName);
    entry.messageDescriptors = descriptorsFor(entry.messages);
    entry.bodyEmbeddingText = embeddingTextFromMessages(entry.messages);
    entry.bodyResident = true;
    const bytes = estimateMessageBodyBytes(entry.messages);
    entry.bodyBytes = bytes;
    residentBodies.set(entry.fileName, { entry, bytes });
    residentBodyBytes += bytes;
}

/** Summary fields replace an entry's messages when its body leaves memory. */
function withSummary(entry, summary) {
    const lastMessageTimestamp = summary.lastMessageTimestamp ?? entry.lastMessageTimestamp;
    return {
        ...entry, ...summary, lastMessageTimestamp,
        firstTimestampMs: normalizeTimestamp(summary.firstMessageTimestamp),
        lastTimestampMs: normalizeTimestamp(lastMessageTimestamp),
    };
}

/** A resident body can be compared directly; otherwise only hashes remain. */
function sameContent(entry, summary, messages) {
    if (entry.contentHash) return entry.contentHash === summary.contentHash;
    return messagesEqual(entry.messages, messages);
}

function touchResidentBody(fileName) {
    const cached = residentBodies.get(fileName);
    if (!cached) return;
    residentBodies.delete(fileName);
    residentBodies.set(fileName, cached);
}

/** Release cached bodies without changing content revisions or the catalog identity. */
export function trimBodyCache({ keepActive = true, targetBytes = bodyCacheBudget, keepFile = null } = {}) {
    const active = keepActive ? activeFileForCache() : null;
    for (const [fileName, cached] of residentBodies) {
        if (residentBodyBytes <= Math.max(0, targetBytes)) break;
        // A live chat may contain unsaved edits. Never evict its indexed body.
        if (fileName === active || fileName === activeFileForCache() || fileName === keepFile) continue;
        const entry = chatIndex[fileName];
        forgetResidentBody(fileName);
        if (entry !== cached.entry || entry.bodyResident === false) continue;
        entry.messages = [];
        entry.messageDescriptors = null;
        entry.bodyResident = false;
        invalidateSearchableCache();
    }
    return getBodyCacheStats();
}

export function setBodyCacheBudget(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Body cache budget must be a nonnegative number of bytes');
    bodyCacheBudget = Math.floor(bytes);
    return trimBodyCache();
}

export function getBodyCacheStats() {
    const active = activeFileForCache();
    return {
        budgetBytes: bodyCacheBudget, residentBytes: Math.max(0, residentBodyBytes),
        residentChats: residentBodies.size,
        pinnedBytes: residentBodies.get(active)?.bytes || 0,
        catalogChats: Object.keys(chatIndex).length,
    };
}

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
        if (isVector(legacyValue)) {
            migrated.set(key, legacyValue);
        }
    }
    // Keep any already-composite entries from mixed maps.
    for (const [key, value] of entry.messageEmbeddings.entries()) {
        if (typeof key === 'string' && key.startsWith('m:') && isVector(value)) {
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
    if (isVector(fromComposite)) {
        residentVectors.get(vectorKey(entry.fileName, 'message', compositeKey));
        return fromComposite;
    }

    // A legacy numeric key describes the active variant only. Another swipe
    // must never borrow this vector just because its own embedding is missing.
    const fromLegacy = resolvedSwipe === getMessageActiveSwipeIndex(msg)
        ? entry.messageEmbeddings.get(msg.index) : null;
    if (isVector(fromLegacy)) {
        residentVectors.get(vectorKey(entry.fileName, 'message', msg.index));
        return fromLegacy;
    }

    return null;
}

function retainMessageEmbeddings(entry, messages) {
    if (!(entry.messageEmbeddings instanceof Map)) return null;
    const previousMap = ensureMessageEmbeddingMap(entry);
    const retained = new Map();
    const previous = descriptorsFor(entry.messages);
    const next = descriptorsFor(messages);
    for (let i = 0; i < next.length; i++) {
        if (!previous[i]) continue;
        for (let swipe = 0; swipe < next[i].swipeCount; swipe++) {
            if (!(next[i].swipeLengths?.[swipe] > 0) || previous[i].swipeHashes?.[swipe] !== next[i].swipeHashes?.[swipe]) continue;
            const vector = previousMap.get(makeMessageEmbeddingKey(previous[i].index, swipe));
            if (vector) retained.set(makeMessageEmbeddingKey(next[i].index, swipe), vector);
        }
    }
    compositeEmbeddingMaps.add(retained);
    return retained;
}

function retainCachedEmbeddingKeys(entry, messages) {
    const previousKeys = entry.cachedMessageEmbeddingKeys;
    if (!(previousKeys instanceof Set)) return new Set();
    const retained = new Set();
    for (let i = 0; i < messages.length; i++) {
        const previous = entry.messages?.[i];
        if (!previous) continue;
        const oldDescriptor = descriptorsFor([previous])[0];
        const nextDescriptor = descriptorsFor([messages[i]])[0];
        for (let swipe = 0; swipe < nextDescriptor.swipeCount; swipe++) {
            if (oldDescriptor.swipeHashes?.[swipe] !== nextDescriptor.swipeHashes?.[swipe]) continue;
            if (previousKeys.has(makeMessageEmbeddingKey(previous.index, swipe))) {
                retained.add(makeMessageEmbeddingKey(messages[i].index, swipe));
            }
        }
    }
    return retained;
}

function forgetEntryVectors(fileName) {
    for (const key of [...(vectorKeysByFile.get(fileName) || [])]) residentVectors.delete(key);
    vectorKeysByFile.delete(fileName);
    vectorOwners.delete(fileName);
}

/**
 * Set a message embedding vector for a specific swipe variant.
 * @param {ChatIndexEntry|any} entry
 * @param {number} messageIndex
 * @param {number} swipeIndex
 * @param {number[]} vector
 */
export function setMessageEmbedding(entry, messageIndex, swipeIndex, vector) {
    if (!entry || !isVector(vector)) return false;
    const map = ensureMessageEmbeddingMap(entry);
    const key = makeMessageEmbeddingKey(messageIndex, swipeIndex);
    entry.cachedMessageEmbeddingKeys ||= new Set();
    entry.cachedMessageEmbeddingKeys.add(key);
    if (vector.length * Float32Array.BYTES_PER_ELEMENT > residentVectors.maxBytes) {
        residentVectors.delete(vectorKey(entry.fileName, 'message', key));
        map.delete(key);
        return false;
    }
    const compact = toFloat32Vector(vector);
    if (!rememberVector(entry, 'message', key, compact)) return false;
    if (map.get(key) !== compact) {
        map.set(key, compact);
        entry.messageEmbeddingVersion = (entry.messageEmbeddingVersion || 0) + 1;
    }
    return true;
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
        // Headers carry main_chat, which identifies a chat's relatives without reading it.
        body: JSON.stringify({ avatar_url: character.avatar, metadata: true }),
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
export async function fetchChatContent(fileName, { signal } = {}) {
    const response = await requestChatContent(fileName, { signal });
    if (!response) return [];
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error(`Invalid chat content response for ${fileName}`);
    return data;
}

async function requestChatContent(fileName, { signal } = {}) {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return null;

    const character = context.characters[context.characterId];
    if (!character) return null;

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        signal,
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
    return response;
}

/** Index a chat nobody is reading, keeping its body off the page where possible. */
async function indexChatInBackground(fileName) {
    if (isIndexWorkerAvailable()) {
        const response = await requestChatContent(fileName);
        if (!response) return null;
        const text = await response.text();
        try {
            return await indexChatTextInWorker(text, fileName);
        } catch (error) {
            if (!(error instanceof IndexWorkerUnavailable)) throw error;
            console.warn(`[${MODULE_NAME}] Indexing on the page instead of a worker:`, error.message);
            return indexChatText(text, fileName);
        }
    }
    const { descriptors, summary } = indexChatData(await fetchChatContent(fileName), fileName);
    return { summary, descriptorsPayload: encodeDescriptors(descriptors) };
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

/** The list reports the last message, so a card needs no download to show it. */
function getMetaPreview(metaObj) {
    if (typeof metaObj?.mes !== 'string' || !getMetaMessageCount(metaObj)) return '';
    return metaObj.mes === EMPTY_MESSAGE_PLACEHOLDER ? '' : messagePreview(metaObj.mes.trim(), LAST_MESSAGE_PREVIEW_CHARS);
}

function normalizeTimestamp(value) {
    if (value === null || value === undefined || value === '') {
        return FALLBACK_SORT_TIMESTAMP;
    }

    return timestampMs(value) ?? FALLBACK_SORT_TIMESTAMP;
}

function metaSignature(meta) {
    return JSON.stringify([meta?.file_size ?? null, getMetaMessageCount(meta)]);
}

/*
 * The host list has no file revision, so matching size/count/date can still hide
 * a same-size edit. Local edits delete their cached record (recordLocalChatEdit)
 * and remote ones wait for a forceRevalidate build.
 */

/**
 * The host selects a new character before announcing the change. Until then a read
 * would ask for our filenames under that character, and the server answers a missing
 * file with an empty chat, which must never be saved as this chat's content.
 */
function isHostOnIndexedCharacter() {
    if (!currentCharacterAvatar) return true;
    const context = SillyTavern.getContext();
    return context.characters?.[context.characterId]?.avatar === currentCharacterAvatar;
}

/** The host's array is newer than the file while a debounced save is pending. */
function liveChatContext(fileName) {
    const context = SillyTavern.getContext();
    if (context.characters?.[context.characterId]?.avatar !== currentCharacterAvatar) return null;
    if (!Array.isArray(context.chat) || context.chat.length === 0) return null;
    return resolveActiveChatFilename(context, chatIndex) === fileName ? context : null;
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
            listener({ ...progress, complete: isHydrationComplete(), idle: isHydrationIdle() });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Hydration listener failed:`, err);
        }
    }
}

function markEntryForHydration(fileName) {
    if (!backgroundHydrationRequested) return;
    enqueueHydration(fileName);
}

function enqueueHydration(fileName) {
    const entry = chatIndex[fileName];
    if (!entry || (entry.isLoaded && !entry.needsHydration)) return;
    if (queuedFiles.has(fileName)) return;
    if (entryHydrationPromises.has(fileName)) return;

    hydrationQueue.push(fileName);
    queuedFiles.add(fileName);
}

/**
 * Index specific chats now, ahead of anything already queued.
 * @param {string[]} fileNames
 */
export function requestHydration(fileNames) {
    if (!Array.isArray(fileNames)) return;
    for (const fileName of fileNames) enqueueHydration(fileName);
    prioritizeHydrationFiles(fileNames);
    // A running build may be about to restore these from their summaries.
    if (!indexBuildInProgress) startHydrationLoop();
}

/** Index every chat, for a view that reports on the whole archive. */
export function requestFullHydration() {
    backgroundHydrationRequested = true;
    for (const fileName of Object.keys(chatIndex)) enqueueHydration(fileName);
    if (!indexBuildInProgress) startHydrationLoop();
}

/** Stop indexing chats nobody is waiting for. In-flight reads finish normally. */
export function cancelBackgroundHydration() {
    backgroundHydrationRequested = false;
    if (hydrationQueue.length === 0) return;
    hydrationQueue = [];
    queuedFiles = new Set();
    emitHydrationUpdate();
}

/**
 * Whether any requested indexing is still queued or running.
 * @returns {boolean}
 */
export function isHydrationIdle() {
    return !hydrationInProgress && !hasPendingHydration();
}

/**
 * How many chats are waiting to be indexed.
 * @returns {number}
 */
export function getPendingHydrationCount() {
    return hydrationQueue.length + entryHydrationPromises.size;
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
    cachedSearchableMessages = null;
    cachedSearchableVersion = -1;
    indexVersion++;
    invalidateSearchableCache();
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
    if (typeof entry.bodyResident !== 'boolean') {
        entry.bodyResident = entry.isLoaded && !entry.messages.some(message => message?.isDescriptor);
    }
    if (!Array.isArray(entry.messageDescriptors)) entry.messageDescriptors = descriptorsFor(entry.messages);
    if (!isVector(entry.chatEmbedding)) {
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
            || !sameMessageContent(left, right)
            || left?.timestamp !== right?.timestamp
            || JSON.stringify(left?.branches || []) !== JSON.stringify(right?.branches || [])
            || getMessageActiveSwipeIndex(left) !== getMessageActiveSwipeIndex(right)) return false;
        const useHashes = left?.isDescriptor || right?.isDescriptor;
        const leftSwipes = useHashes ? descriptorsFor([left])[0].swipeHashes : left?.swipes;
        const rightSwipes = useHashes ? descriptorsFor([right])[0].swipeHashes : right?.swipes;
        if (leftSwipes === rightSwipes) continue;
        if (!Array.isArray(leftSwipes) || !Array.isArray(rightSwipes) || leftSwipes.length !== rightSwipes.length) return false;
        for (let swipe = 0; swipe < leftSwipes.length; swipe++) {
            if (leftSwipes[swipe] !== rightSwipes[swipe]) return false;
        }
    }
    return true;
}

function hasResidentEmbeddingState(entry) {
    return entry.messageEmbeddings?.size > 0 || entry.cachedMessageEmbeddingKeys?.size > 0;
}

/** Embedding state follows unchanged messages, which needs the previous records. */
async function withPreviousMessages(entry) {
    if (entry.messages?.length || !hasResidentEmbeddingState(entry)) return entry;
    const stored = currentCharacterAvatar ? await getCachedDescriptors(currentCharacterAvatar, entry.fileName) : null;
    if (!stored || stored.validatedAt !== entry.validatedAt) return entry;
    try {
        return { ...entry, messages: decodeDescriptors(stored.payload, entry.fileName) };
    } catch {
        return entry;
    }
}

async function indexChatContent(fileName, live, previousMessages) {
    // Reading the file before a pending save lands would persist the old text
    // under metadata that no later list could tell apart.
    const chatData = live ? live.chat : await fetchChatContent(fileName);
    const messages = parseMessages(chatData, fileName, previousMessages);
    const descriptors = descriptorsFor(messages);
    return { messages, descriptors, summary: summarizeChat(messages, descriptors, mainChatFromData(chatData, live?.chatMetadata)) };
}

/**
 * Fetch and index a single entry, re-trying if metadata changed during fetch.
 * @param {string} fileName
 * @param {number} sessionId
 * @param {{ retainBody?: boolean, storeBody?: boolean, evictBodies?: boolean, onBody?: Function }} [options]
 *   retainBody false keeps only the summary in memory. storeBody writes complete
 *   text to the capped store, where evictBodies lets it displace older bodies;
 *   archive scans leave that off. onBody receives text the caller asked to borrow.
 * @returns {Promise<boolean>}
 */
async function hydrateEntry(fileName, sessionId, { retainBody = true, storeBody = true, evictBodies = true, onBody = null } = {}) {
    if (entryHydrationPromises.has(fileName)) {
        return entryHydrationPromises.get(fileName);
    }

    const promise = (async () => {
        while (sessionId === hydrationSessionId) {
            const entry = chatIndex[fileName];
            if (!entry) return false;
            if (entry.isLoaded && !entry.needsHydration) return true;
            if (!isHostOnIndexedCharacter()) return false;

            const expectedTimestamp = entry.lastModified;
            const live = liveChatContext(fileName);
            const offPage = !retainBody && !storeBody && !onBody && !live;
            let indexed;
            try {
                indexed = offPage
                    ? await indexChatInBackground(fileName)
                    : await indexChatContent(fileName, live, entry.bodyResident !== false ? entry.messages : null);
                if (!indexed) return false;
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

            const previous = await withPreviousMessages(current);
            if (sessionId !== hydrationSessionId || chatIndex[fileName] !== current) continue;
            if (!isHostOnIndexedCharacter()) return false;

            const { messages = null, summary } = indexed;
            // The list counted messages, so an empty answer means the read missed the
            // file. Saving it would show this chat as empty until it next changes.
            if (!live && summary.messageCount === 0 && current.messageCount > 0) {
                console.warn(`[${MODULE_NAME}] Ignoring an empty read of ${fileName}, listed with ${current.messageCount} messages`);
                return false;
            }
            // A read that finds different text means earlier keyword scans are out of date.
            if (current.contentHash && current.contentHash !== summary.contentHash) keywordSearchEpoch++;
            const descriptorsPayload = indexed.descriptorsPayload ?? encodeDescriptors(indexed.descriptors);
            // Without a body, embedding state follows the stored rows instead.
            const comparable = messages ?? (hasResidentEmbeddingState(current) ? decodeDescriptors(descriptorsPayload, fileName) : []);
            // The open chat stays resident: it may hold edits no file has yet.
            const keepBody = retainBody || !!live;
            const next = {
                ...withSummary(current, summary),
                messages: keepBody ? messages : [],
                messageDescriptors: keepBody ? indexed.descriptors : null,
                bodyResident: keepBody,
                branchPoint: null,
                isLoaded: true,
                needsHydration: false,
                validatedAt: Date.now(),
                messageEmbeddings: retainMessageEmbeddings(previous, comparable),
                cachedMessageEmbeddingKeys: retainCachedEmbeddingKeys(previous, comparable),
            };
            chatIndex[fileName] = next;
            if (keepBody) rememberResidentBody(next);
            else forgetResidentBody(fileName);
            if (!current.isLoaded || getRepresentativeEmbeddingText(current) !== getRepresentativeEmbeddingText(next)) {
                next.chatEmbedding = null;
                next.chatEmbeddingHash = null;
                next.cachedChatEmbeddingHash = null;
                next.clusterLabel = null;
            }
            syncEntryVectorBudget(next);
            bumpIndexVersion();

            if (currentCharacterAvatar) {
                await putCachedChat(currentCharacterAvatar, fileName, next, {
                    descriptorsPayload,
                    body: storeBody && !live ? messages : undefined,
                    evictBodies,
                });
                if (sessionId !== hydrationSessionId || !chatIndex[fileName]) return false;
                trimBodyCache({ keepFile: fileName });
            }

            onBody?.(messages);
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

                await Promise.all(batch.map(fileName => hydrateEntry(fileName, sessionId, { retainBody: false, storeBody: false })));
                if (sessionId === hydrationSessionId) emitHydrationUpdate();
                // Only parsing on the page needs to give way. This wait is also what a
                // background tab stretches to a second, so a worker skips it.
                if (sessionId === hydrationSessionId && hydrationQueue.length > 0 && !isIndexWorkerAvailable()) {
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
 * Metadata phase returns quickly; hydration of new or changed chats runs in the
 * background. Chats whose list metadata matches their cached summary are reused.
 * @param {Function} [onProgress] - Called with (completed, total) for progress tracking
 * @param {Function} [onMetadataReady] - Called once metadata is available for immediate UI rendering
 * @param {{ forceRevalidate?: boolean, backgroundHydration?: boolean }} [options]
 *   forceRevalidate re-reads every chat from the server. backgroundHydration: false
 *   leaves unknown chats queued until a later build asks for hydration.
 * @returns {Promise<{ index: Object, changed: boolean, buildInProgress: boolean, hydrationStarted: boolean, isComplete: boolean }>}
 */
export async function buildIndex(onProgress, onMetadataReady, options = {}) {
    progressCallback = onProgress || null;
    const requestsHydration = options.forceRevalidate === true || options.backgroundHydration !== false;

    if (indexBuildInProgress) {
        if (requestsHydration) backgroundHydrationRequested = true;
        if (options.forceRevalidate) forcedBuildPending = true;
        if (Object.keys(chatIndex).length > 0) {
            notifyMetadataReady(onMetadataReady, false);
        }
        emitHydrationUpdate();
        return getBuildStateResponse(false, true);
    }

    indexBuildInProgress = true;
    backgroundHydrationRequested = requestsHydration;
    if (options.forceRevalidate) keywordSearchEpoch++;
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
        backgroundHydrationRequested = requestsHydration;
    }

    currentCharacterAvatar = character.avatar;
    const buildAvatar = character.avatar;
    const buildSessionId = hydrationSessionId;
    let changed = false;
    let metadataNotified = false;

    lastBuildFailed = false;
    try {
        const chatList = await fetchChatList();
        if (buildSessionId !== hydrationSessionId || currentCharacterAvatar !== buildAvatar) {
            return getBuildStateResponse(false);
        }
        if (!chatList || !chatList.length) {
            changed = Object.keys(chatIndex).length > 0;
            for (const fileName of Object.keys(chatIndex)) removeCachedChat(character.avatar, fileName);
            clearResidentVectors();
            chatIndex = {};
            residentBodies.clear();
            residentBodyBytes = 0;
            activeBodyFile = null;
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
                lastMessagePreview: getMetaPreview(metaObj),
                chatEmbedding: null,
                chatEmbeddingHash: null,
                clusterLabel: null,
                messageEmbeddings: null,
            };
            markEntryForHydration(fileName);
            changed = true;
            keywordSearchEpoch++;
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

        // Loaded, unchanged entries already live in memory. Everything else is
        // restored from one read of the character's summaries.
        const cachedSummaries = options.forceRevalidate || serverChats.size === 0
            ? new Map() : await getCachedSummaries(character.avatar);
        if (buildSessionId !== hydrationSessionId || currentCharacterAvatar !== buildAvatar) {
            return getBuildStateResponse(false);
        }
        for (const [fileName, record] of cachedSummaries) {
            const metadata = serverChats.get(fileName);
            // The file was deleted while no index was loaded.
            if (!metadata) { removeCachedChat(character.avatar, fileName); continue; }
            const current = chatIndex[fileName];
            if (!current || current.isLoaded || current !== entriesBeforeCacheRead.get(fileName)
                || record.lastModified !== getMetaTimestamp(metadata)
                || record.serverSignature !== metaSignature(metadata)) continue;
            chatIndex[fileName] = {
                ...current, ...record, fileName, initialOrder: current.initialOrder,
                firstTimestampMs: normalizeTimestamp(record.firstMessageTimestamp),
                lastTimestampMs: normalizeTimestamp(record.lastMessageTimestamp),
                messages: [], messageDescriptors: null, bodyResident: false,
                branchPoint: null, isLoaded: true, needsHydration: false,
                chatEmbedding: null, chatEmbeddingHash: null, clusterLabel: null, messageEmbeddings: null,
            };
            delete chatIndex[fileName].key;
            delete chatIndex[fileName].avatar;
            delete chatIndex[fileName].cacheFormatVersion;
            entriesBeforeCacheRead.set(fileName, chatIndex[fileName]);
            queuedFiles.delete(fileName);
            changed = true;
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
            const reusable = !options.forceRevalidate && !entry.needsHydration && entry.isLoaded && !metadataChanged;
            if (reusable) continue;

            // Keep the last successful body visible while revalidating; a
            // failed request must not turn known-good data into an empty chat.
            chatIndex[fileName] = {
                ...entry, lastModified: serverTimestamp, serverSignature: signature,
                sortTimestamp: metadataChanged ? serverTimestamp : entry.sortTimestamp,
                needsHydration: true,
            };
            if (metadataChanged) {
                // The chat may wait a long time for its next read. Show what the list knows.
                keywordSearchEpoch++;
                const lastTimestamp = getMetaTimestampString(metaObj) ?? entry.lastMessageTimestamp;
                Object.assign(chatIndex[fileName], {
                    messageCount: getMetaMessageCount(metaObj) ?? entry.messageCount,
                    lastMessageTimestamp: lastTimestamp,
                    lastTimestampMs: normalizeTimestamp(lastTimestamp),
                    lastMessagePreview: getMetaPreview(metaObj) || entry.lastMessagePreview,
                });
            }
            if (entry.isLoaded && entry.bodyResident !== false) rememberResidentBody(chatIndex[fileName]);
            markEntryForHydration(fileName);
            changed = true;
        }

        // Reconcile queue membership once, including all restored and deleted files.
        for (const deletedKey of existingKeys) {
            if (chatIndex[deletedKey] !== entriesBeforeCacheRead.get(deletedKey)) continue;
            delete chatIndex[deletedKey];
            forgetResidentBody(deletedKey);
            forgetEntryVectors(deletedKey);
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

        // A request made while this build ran may need chats it has now listed.
        if (backgroundHydrationRequested) {
            for (const fileName of Object.keys(chatIndex)) markEntryForHydration(fileName);
        }
        if (hydrationQueue.length > 0) {
            const activeFile = resolveActiveChatFilename(SillyTavern.getContext(), chatIndex);
            const recent = getSortedEntries().filter(entry => !entry.isLoaded || entry.needsHydration)
                .slice(0, 12).map(entry => entry.fileName);
            prioritizeHydrationFiles([activeFile, ...recent]);
            console.log(`[${MODULE_NAME}] Hydrating ${hydrationQueue.length} chats in background (${Object.keys(chatIndex).length} total)`);
            startHydrationLoop();
        }
    } catch (err) {
        lastBuildFailed = true;
        console.error(`[${MODULE_NAME}] Error building index:`, err);
    } finally {
        if (activeBuildToken === buildToken) {
            indexBuildInProgress = false;
            activeBuildToken = null;
            // An explicit verification must not be lost to a build already running.
            if (forcedBuildPending) {
                forcedBuildPending = false;
                void buildIndex(progressCallback, null, { forceRevalidate: true });
            }
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

    if (entry.isLoaded && !entry.needsHydration) {
        if (entry.bodyResident !== false) {
            touchResidentBody(fileName);
            return true;
        }
        try {
            const session = hydrationSessionId;
            const messages = await readChatMessages(fileName);
            if (session !== hydrationSessionId || !chatIndex[fileName]) return false;
            const current = chatIndex[fileName];
            current.messages = messages;
            rememberResidentBody(current);
            invalidateSearchableCache();
            trimBodyCache({ keepFile: fileName });
            return true;
        } catch (error) {
            console.warn(`[${MODULE_NAME}] Failed to load ${fileName}:`, error);
            return false;
        }
    }

    queuedFiles.delete(fileName);
    hydrationQueue = hydrationQueue.filter(name => name !== fileName);

    const loaded = await hydrateEntry(fileName, hydrationSessionId);
    if (loaded && chatIndex[fileName]?.bodyResident === false) return loadEntryNow(fileName);
    emitHydrationUpdate();
    return loaded;
}

function assertBodyReadCurrent(sessionId, avatar, signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    const context = globalThis.SillyTavern?.getContext?.();
    const currentAvatar = context?.characters?.[context.characterId]?.avatar;
    if (sessionId !== hydrationSessionId || avatar !== currentCharacterAvatar || (avatar && currentAvatar !== avatar)) {
        throw new DOMException('The selected character changed', 'AbortError');
    }
}

/**
 * Read a complete body for one operation. Cold bodies remain ephemeral; callers
 * keep only IDs/previews after use. No residency or content revision changes are
 * made for a successful read of an unchanged cached body.
 */
export async function readChatMessages(fileName, { signal, evictBodies = true, retainBody = true } = {}) {
    fileName = canonicalFilename(fileName);
    const sessionId = hydrationSessionId;
    const avatar = currentCharacterAvatar;
    assertBodyReadCurrent(sessionId, avatar, signal);
    let entry = chatIndex[fileName];
    if (!entry) throw new Error(`Chat not present in this character's catalog: ${fileName}`);
    normalizeEntryShape(entry);
    if (!entry.isLoaded || entry.needsHydration) {
        let borrowed = null;
        const loaded = await hydrateEntry(fileName, sessionId, { evictBodies, retainBody, onBody: messages => { borrowed = messages; } });
        assertBodyReadCurrent(sessionId, avatar, signal);
        entry = chatIndex[fileName];
        if (!loaded || !entry?.isLoaded || entry.needsHydration) {
            throw new Error(`Could not refresh chat ${fileName}; its previous cached data was preserved`);
        }
        if (borrowed) return borrowed;
    }
    if (entry?.isLoaded && entry.bodyResident !== false) {
        touchResidentBody(fileName);
        const messages = entry.messages;
        trimBodyCache();
        return messages;
    }

    await flushPendingCacheWrites();
    assertBodyReadCurrent(sessionId, avatar, signal);
    const cached = avatar ? await getCachedBody(avatar, fileName, { signal }) : null;
    assertBodyReadCurrent(sessionId, avatar, signal);
    if (chatIndex[fileName] !== entry) return readChatMessages(fileName, { signal, evictBodies, retainBody });
    if (cached && Array.isArray(cached.messages) && !cached.messages.some(message => message?.isDescriptor)
        && cached.lastModified === entry.lastModified && cached.serverSignature === entry.serverSignature
        && cached.validatedAt === entry.validatedAt) {
        return cached.messages;
    }

    // IndexedDB is a cache. If it is unavailable or evicted, authoritative chat
    // files remain readable and archive memory is still allowed to be bounded.
    const raw = await fetchChatContent(fileName, { signal });
    assertBodyReadCurrent(sessionId, avatar, signal);
    const current = chatIndex[fileName];
    if (!current) throw new Error(`Chat was removed while reading: ${fileName}`);
    if (current !== entry) return readChatMessages(fileName, { signal, evictBodies, retainBody });
    const messages = parseMessages(raw, fileName);
    // The file vanished after the list was read. Say so, but do not remember it as empty.
    if (messages.length === 0 && entry.messageCount > 0) return messages;
    const descriptors = descriptorsFor(messages);
    const summary = summarizeChat(messages, descriptors, mainChatFromData(raw));
    if (!entry.isLoaded || !sameContent(entry, summary, messages)) {
        keywordSearchEpoch++;
        const previous = await withPreviousMessages(entry);
        assertBodyReadCurrent(sessionId, avatar, signal);
        if (chatIndex[fileName] !== entry) return readChatMessages(fileName, { signal, evictBodies, retainBody });
        const updated = {
            ...withSummary(entry, summary), messages, isLoaded: true, needsHydration: false,
            validatedAt: Date.now(), branchPoint: null,
            messageEmbeddings: retainMessageEmbeddings(previous, messages),
            cachedMessageEmbeddingKeys: retainCachedEmbeddingKeys(previous, messages),
            chatEmbedding: null, chatEmbeddingHash: null, cachedChatEmbeddingHash: null, clusterLabel: null,
        };
        chatIndex[fileName] = updated;
        syncEntryVectorBudget(updated);
        rememberResidentBody(updated);
        bumpIndexVersion();
        if (avatar) {
            await putCachedChat(avatar, fileName, updated, { descriptorsPayload: encodeDescriptors(descriptors), body: messages, evictBodies });
        }
        assertBodyReadCurrent(sessionId, avatar, signal);
        trimBodyCache();
        emitHydrationUpdate();
    } else if (avatar) {
        entry.bodyBytes = summary.bodyBytes;
        await putCachedBody(avatar, fileName, entry, messages, { evictBodies });
        assertBodyReadCurrent(sessionId, avatar, signal);
    }
    return messages;
}

/**
 * Read the per-message records of one chat for a single operation. They are never
 * retained here, so a view holds at most the chat it is currently working on.
 * @param {string} fileName
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array>}
 */
export async function readChatDescriptors(fileName, { signal } = {}) {
    fileName = canonicalFilename(fileName);
    const sessionId = hydrationSessionId;
    const avatar = currentCharacterAvatar;
    assertBodyReadCurrent(sessionId, avatar, signal);
    const entry = chatIndex[fileName];
    if (!entry) throw new Error(`Chat not present in this character's catalog: ${fileName}`);
    if (entry.isLoaded && !entry.needsHydration) {
        if (entry.messages?.length) return descriptorsFor(entry.messages);
        await flushPendingCacheWrites();
        const stored = avatar ? await getCachedDescriptors(avatar, fileName, { signal }) : null;
        assertBodyReadCurrent(sessionId, avatar, signal);
        if (chatIndex[fileName] !== entry) return readChatDescriptors(fileName, { signal });
        if (stored && stored.lastModified === entry.lastModified && stored.serverSignature === entry.serverSignature
            && stored.validatedAt === entry.validatedAt) {
            try {
                return decodeDescriptors(stored.payload, fileName);
            } catch (error) {
                console.warn(`[${MODULE_NAME}] Ignoring unreadable records for ${fileName}:`, error);
            }
        }
    }
    const descriptors = descriptorsFor(await readChatMessages(fileName, { signal, evictBodies: false }));
    assertBodyReadCurrent(sessionId, avatar, signal);
    const current = chatIndex[fileName];
    if (avatar && current?.isLoaded && !current.needsHydration) {
        await putCachedChat(avatar, fileName, current, { descriptorsPayload: encodeDescriptors(descriptors) });
    }
    return descriptors;
}

/** Complete archive iteration with at most one cold body held by the iterator. */
export async function* iterateChatBodies({ fileNames, signal } = {}) {
    const sessionId = hydrationSessionId;
    const avatar = currentCharacterAvatar;
    const names = Array.isArray(fileNames) ? [...fileNames] : getSortedEntries().map(entry => entry.fileName);
    for (const name of names) {
        assertBodyReadCurrent(sessionId, avatar, signal);
        const fileName = canonicalFilename(name);
        if (!chatIndex[fileName]) continue;
        const messages = await readChatMessages(fileName, { signal, evictBodies: false, retainBody: false });
        assertBodyReadCurrent(sessionId, avatar, signal);
        yield { entry: chatIndex[fileName], messages };
    }
}

// Results stay valid until a chat changes. Indexing alone never invalidates them.
let keywordSearchEpoch = 0;
let keywordSearchMemo = null;
let keywordSearchRunning = null;

function matchesKeywordMemo(needle, avatar) {
    const memo = keywordSearchMemo;
    // A chat holding a longer query also holds any part of it, so one scan can
    // answer every keystroke that extends it.
    return memo && memo.avatar === avatar && memo.epoch === keywordSearchEpoch && needle.includes(memo.needle) ? memo.files : null;
}

function waitUnlessAborted(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
        const onAbort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function scanServerForKeyword(needle, character, headers) {
    const epoch = keywordSearchEpoch;
    try {
        const response = await fetch('/api/chats/search', {
            method: 'POST', headers,
            body: JSON.stringify({ query: needle, avatar_url: character.avatar }),
        });
        if (!response.ok) return null;
        const rows = await response.json();
        if (!Array.isArray(rows)) return null;
        const files = new Set(rows.map(row => canonicalFilename(row?.file_name)).filter(Boolean));
        keywordSearchMemo = { avatar: character.avatar, epoch, needle, files };
        return files;
    } catch (error) {
        console.warn(`[${MODULE_NAME}] Server chat search failed:`, error);
        return null;
    }
}

/**
 * Ask the server which chats could hold a substring of their active message text,
 * so a keyword search reads only those. The server requires every word to appear
 * somewhere in the chat, which every true match satisfies, so nothing is lost. The
 * open chat is always included because it may hold text no file has yet.
 * @param {string} query
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<string[]|null>} Newest first, or null to read every chat
 */
export async function findChatsMatchingKeyword(query, { signal } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const context = SillyTavern.getContext();
    const character = context.characters?.[context.characterId];
    const avatar = currentCharacterAvatar;
    if (!needle || !avatar || character?.avatar !== avatar) return null;

    let files = matchesKeywordMemo(needle, avatar);
    while (!files) {
        // The server cannot cancel a scan, so never start a second one beside it.
        if (keywordSearchRunning) {
            await waitUnlessAborted(keywordSearchRunning, signal);
            files = matchesKeywordMemo(needle, avatar);
            continue;
        }
        keywordSearchRunning = scanServerForKeyword(needle, character, context.getRequestHeaders())
            .finally(() => { keywordSearchRunning = null; });
        files = await waitUnlessAborted(keywordSearchRunning, signal);
        if (!files) return null;
    }
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
    if (currentCharacterAvatar !== avatar) throw new DOMException('The selected character changed', 'AbortError');
    const active = resolveActiveChatFilename(SillyTavern.getContext(), chatIndex);
    return getSortedEntries().map(entry => entry.fileName).filter(name => files.has(name) || name === active);
}

/** Invalidate a locally edited body even when the manager panel is closed. */
export function markChatDirty(fileName) {
    const entry = chatIndex[fileName];
    if (!entry) return false;
    chatIndex[fileName] = { ...entry, needsHydration: true };
    keywordSearchEpoch++;
    if (entry.isLoaded && entry.bodyResident !== false) rememberResidentBody(chatIndex[fileName]);
    // A same-length edit may not change list metadata, even after a page reload.
    if (currentCharacterAvatar) removeCachedChat(currentCharacterAvatar, fileName);
    markEntryForHydration(fileName);
    bumpIndexVersion();
    return true;
}

/**
 * Record an edit to the chat open in the host, whichever character the index holds.
 * A chat with no cached record is re-read by the next build, so deleting the record
 * is the persistent marker for an edit that list metadata might not reveal.
 * @param {Object} context - SillyTavern context
 * @returns {boolean} Whether a character chat was identified
 */
export function recordLocalChatEdit(context) {
    const avatar = context?.characters?.[context.characterId]?.avatar;
    if (!avatar) return false;
    const indexed = avatar === currentCharacterAvatar ? resolveActiveChatFilename(context, chatIndex) : null;
    if (indexed && markChatDirty(indexed)) return true;
    const fileName = resolveActiveChatFilename(context);
    if (!fileName) return false;
    removeCachedChat(avatar, fileName);
    return true;
}

/** Remove an explicitly deleted local chat without retaining stale search results. */
export function removeChatFromIndex(fileName) {
    const resolved = canonicalFilename(fileName);
    if (!resolved || !chatIndex[resolved]) return false;
    delete chatIndex[resolved];
    keywordSearchEpoch++;
    forgetResidentBody(resolved);
    forgetEntryVectors(resolved);
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
    const updateSession = hydrationSessionId;

    try {
        if (!isHostOnIndexedCharacter()) return false;
        // Prefer in-memory chat data over HTTP fetch
        const context = SillyTavern.getContext();
        let chatData;
        if (Array.isArray(context.chat)) {
            // The host empties this array while it opens another chat, under that
            // chat's name. Nothing can be learned until its messages arrive.
            if (context.chat.length === 0 && chatIndex[fileName].messageCount > 0) return false;
            chatData = context.chat;
        } else {
            chatData = await fetchChatContent(fileName);
        }

        const cached = chatIndex[fileName];
        const messages = parseMessages(chatData, fileName, cached.bodyResident !== false ? cached.messages : null);
        activeBodyFile = fileName;
        const descriptors = descriptorsFor(messages);
        const lastTimestamp = messages.length > 0 ? messages[messages.length - 1].timestamp : null;
        const parsedLastModified = timestampMs(lastTimestamp) ?? NaN;
        const hasValidLastModified = Number.isFinite(parsedLastModified);

        const mainChat = mainChatFromData(chatData, context.chatMetadata);
        const summary = summarizeChat(messages, descriptors, mainChat);
        if (cached.isLoaded && !cached.needsHydration && (cached.mainChat || null) === mainChat && sameContent(cached, summary, messages)) {
            if (cached.bodyResident === false) {
                cached.messages = messages;
                rememberResidentBody(cached);
                invalidateSearchableCache();
                trimBodyCache();
            } else touchResidentBody(fileName);
            queuedFiles.delete(fileName);
            hydrationQueue = hydrationQueue.filter(name => name !== fileName);
            return false;
        }

        keywordSearchEpoch++;
        const previous = await withPreviousMessages(cached);
        if (updateSession !== hydrationSessionId || chatIndex[fileName] !== cached) return false;
        const updated = {
            ...withSummary(cached, summary),
            messages,
            lastModified: hasValidLastModified ? parsedLastModified : cached.lastModified,
            sortTimestamp: hasValidLastModified ? parsedLastModified : cached.sortTimestamp,
            branchPoint: null,
            isLoaded: true,
            needsHydration: false,
            validatedAt: Date.now(),
            messageEmbeddings: retainMessageEmbeddings(previous, messages),
            cachedMessageEmbeddingKeys: retainCachedEmbeddingKeys(previous, messages),
        };
        if (getRepresentativeEmbeddingText(cached) !== getRepresentativeEmbeddingText(updated)) {
            updated.chatEmbedding = null;
            updated.chatEmbeddingHash = null;
            updated.cachedChatEmbeddingHash = null;
            updated.clusterLabel = null;
        }
        chatIndex[fileName] = updated;
        syncEntryVectorBudget(updated);
        rememberResidentBody(updated);
        bumpIndexVersion();

        if (currentCharacterAvatar) {
            // The host holds this body and the server file follows its save.
            await putCachedChat(currentCharacterAvatar, fileName, updated, { descriptorsPayload: encodeDescriptors(descriptors) });
        }
        if (updateSession !== hydrationSessionId || chatIndex[fileName] !== updated) return false;
        trimBodyCache();

        queuedFiles.delete(fileName);
        hydrationQueue = hydrationQueue.filter(name => name !== fileName);
        emitHydrationUpdate();
        return true;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error updating active chat:`, err);
        return false;
    }
}

// Comparisons repeat on every render, so results outlive one detection run. They
// hold only numbers, keyed by the content of both chats.
let branchMemo = { baseKey: null, results: new Map() };
let latestBranchRun = 0;

function isBranchMemoHit(hit, entry) {
    return !!hit && !!entry?.contentHash && entry.isLoaded && !entry.needsHydration && hit.token === entry.contentHash;
}

/**
 * Find where related chats diverge from the active chat, reading only the chats
 * that have not been compared yet. Designed to be called deferred.
 * @param {string} activeFilename - The currently active chat filename
 * @param {{ fileNames?: string[]|null, signal?: AbortSignal }} [options]
 *   fileNames limits the comparison to those chats, such as the rendered cards.
 */
export async function runDeferredBranchDetection(activeFilename, { fileNames = null, signal } = {}) {
    // A newer run compares against the chat open now. An older one must not leave
    // results measured from a different base where that run would trust them.
    const run = ++latestBranchRun;
    const session = hydrationSessionId;
    const index = chatIndex;
    const stillLatest = () => run === latestBranchRun && session === hydrationSessionId && index === chatIndex && !signal?.aborted;
    const activeEntry = activeFilename ? index[activeFilename] : null;
    const count = activeEntry?.isLoaded ? (activeEntry.messageCount ?? activeEntry.messages?.length ?? 0) : 0;
    const related = count >= 2 ? relatedThreadNames(index, activeFilename) : new Set();
    related.delete(activeFilename);

    const baseKey = activeEntry?.contentHash ? `${activeFilename}\u0000${activeEntry.contentHash}` : null;
    if (branchMemo.baseKey !== baseKey) branchMemo = { baseKey, results: new Map() };
    const memo = branchMemo;
    const wanted = fileNames ? new Set(fileNames) : null;
    let base = null;
    for (const name of related) {
        if (wanted && !wanted.has(name)) continue;
        if (!stillLatest()) return;
        if (isBranchMemoHit(memo.results.get(name), chatIndex[name])) continue;
        try {
            base ??= await readChatDescriptors(activeFilename, { signal });
            const candidate = await readChatDescriptors(name, { signal });
            if (!stillLatest()) return;
            const branchPoint = base.length >= 2 && candidate.length >= 2 ? computeRelatedBranchPoint(base, candidate) : null;
            memo.results.set(name, { token: chatIndex[name]?.contentHash, branchPoint });
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.warn(`[${MODULE_NAME}] Branch comparison failed for ${name}:`, error);
        }
    }
    if (!stillLatest()) return;
    for (const entry of Object.values(chatIndex)) {
        const hit = related.has(entry.fileName) ? memo.results.get(entry.fileName) : null;
        entry.branchPoint = isBranchMemoHit(hit, entry) ? hit.branchPoint : null;
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

    if (!sameMessageContent(candidateMessages[0], baseMessages[0])) {
        candidateCache.set(candidateMessages, null);
        return null;
    }

    const maxCompare = Math.min(candidateMessages.length, baseMessages.length);
    let divergeAt = maxCompare;

    for (let k = 1; k < maxCompare; k++) {
        if (!sameMessageContent(candidateMessages[k], baseMessages[k])) {
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
        && !sameMessageContent(baseMessages[0], candidateMessages[0])) return 0;
    return computeBranchPoint(baseMessages, candidateMessages);
}

/**
 * Get sibling branch context relative to any thread. Host provenance selects the
 * candidates and only as many are read as it takes, newest first. This never
 * changes the branch points shown for the active chat.
 * @param {string} baseFilename - Filename of the thread being summarized
 * @param {number} [maxBranches=3] - Maximum number of sibling branches to return
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Array<{ fileName: string, branchPoint: number, messages: Array }>>}
 *   messages hold compact records from the branch point on, never complete text.
 */
export async function getSiblingBranchContextForThread(baseFilename, maxBranches = 3, { signal } = {}) {
    if (!baseFilename || !chatIndex[baseFilename]) return [];
    const related = relatedThreadNames(chatIndex, baseFilename);
    related.delete(baseFilename);
    if (!related.size || maxBranches <= 0) return [];

    const candidates = [...related].map(name => chatIndex[name]).filter(Boolean)
        .sort((a, b) => (b.lastTimestampMs || 0) - (a.lastTimestampMs || 0));
    const base = await readChatDescriptors(baseFilename, { signal });
    if (base.length < 2) return [];

    const siblings = [];
    for (const { fileName } of candidates) {
        let messages;
        try {
            messages = await readChatDescriptors(fileName, { signal });
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            continue; // One unreadable relative must not hide the others.
        }
        if (messages.length < 2) continue;
        const branchPoint = computeRelatedBranchPoint(base, messages);
        if (branchPoint === null || messages.length <= branchPoint) continue;
        siblings.push({ fileName, branchPoint, messages: messages.slice(branchPoint) });
        if (siblings.length >= maxBranches) break;
    }
    return siblings;
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
        if (Array.isArray(entry.branchTargets)) {
            for (const branch of entry.branchTargets) connect(entry.fileName, canonicalFilename(branch));
        } else {
            for (const message of entry.messages || []) {
                for (const branch of message.branches || []) connect(entry.fileName, canonicalFilename(branch));
            }
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
    clearResidentVectors();
    chatIndex = {};
    residentBodies.clear();
    residentBodyBytes = 0;
    activeBodyFile = null;
    currentCharacterAvatar = null;
    keywordSearchMemo = null;
    keywordSearchEpoch++;
    nextInitialOrder = 0;
    progressCallback = null;
    indexBuildInProgress = false;
    activeBuildToken = null;
    backgroundHydrationRequested = false;
    forcedBuildPending = false;
    lastBuildFailed = false;
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
 * Whether the most recent build could not read the server's chat list.
 * @returns {boolean}
 */
export function didLastBuildFail() {
    return lastBuildFailed;
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
 * Build a flat array of resident messages for legacy callers. Full archive
 * searches must use iterateChatBodies so eviction never narrows search recall.
 * Returns a cached array if the index hasn't changed since the last call.
 * @returns {Array}
 */
export function getSearchableMessages() {
    if (cachedSearchableMessages && cachedSearchableVersion === indexVersion) {
        return cachedSearchableMessages;
    }

    const messages = [];
    for (const chatData of Object.values(chatIndex)) {
        if (!chatData.isLoaded || chatData.bodyResident === false) continue;

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
