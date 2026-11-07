/**
 * Cache Store — IndexedDB persistent cache for hydrated chat entries.
 * Keyed by `{avatar}:{fileName}` with `lastModified` staleness check.
 */

import { createMessageDescriptors, messagePreview } from './message-descriptors.js';

const DB_NAME = 'chat_manager_cache';
// Version 3 adds lightweight validity metadata; version 2 discarded legacy message IDs.
const DB_VERSION = 3;
const CACHE_FORMAT_VERSION = 2;
const STORE_NAME = 'chats';
const METADATA_STORE_NAME = 'chatMetadata';
const READ_BATCH_SIZE = 50;
const CATALOG_PREFIX = '\u0000catalog:';
const pendingWrites = new Map();
let flushingWrites = null;

/** @type {IDBDatabase|null} */
let db = null;
/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

/**
 * Open (or reuse) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (db) return Promise.resolve(db);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not available'));
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (event.oldVersion < 2 && database.objectStoreNames.contains(STORE_NAME)) {
                database.deleteObjectStore(STORE_NAME);
            }
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                store.createIndex('avatar', 'avatar', { unique: false });
            }
            // Older bodies have no matching metadata and are safely rehydrated.
            if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
                database.createObjectStore(METADATA_STORE_NAME, { keyPath: 'key' });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            db.onversionchange = () => { db.close(); db = null; dbPromise = null; };
            resolve(db);
        };

        request.onerror = (event) => {
            dbPromise = null; // allow retry on failure
            console.error('[chat_manager] Failed to open IndexedDB:', event.target.error);
            reject(event.target.error);
        };
        request.onblocked = () => {
            // An older tab may hold v1 open without a versionchange handler.
            // Continue with server hydration instead of hanging the index build.
            dbPromise = null;
            reject(new Error('Chat cache upgrade is blocked by another tab'));
        };
    });

    return dbPromise;
}

/**
 * Build the composite key for a cache entry.
 * @param {string} avatar
 * @param {string} fileName
 * @returns {string}
 */
function makeKey(avatar, fileName) {
    return `${avatar}:${fileName}`;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}

async function readRecord(key, signal, { fallbackKey } = {}) {
    throwIfAborted(signal);
    try {
        const database = await openDB();
        const result = await new Promise(resolve => {
            const tx = database.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            let value = null;
            let transactionComplete = false;
            let readComplete = false;
            const finish = () => {
                if (transactionComplete && readComplete) resolve(value?.cacheFormatVersion === CACHE_FORMAT_VERSION ? value : null);
            };
            const read = (recordKey, fallback) => {
                const request = store.get(recordKey);
                request.onsuccess = () => {
                    value = request.result;
                    if (value?.cacheFormatVersion !== CACHE_FORMAT_VERSION && fallback) read(fallback, null);
                    else { readComplete = true; finish(); }
                };
                request.onerror = () => { readComplete = true; finish(); };
            };
            read(key, fallbackKey);
            tx.oncomplete = () => { transactionComplete = true; finish(); };
            tx.onerror = tx.onabort = () => resolve(null);
        });
        throwIfAborted(signal);
        return result;
    } catch (error) {
        throwIfAborted(signal);
        return null;
    }
}

/** Read one complete body, never a whole-character collection. */
export function getCachedChat(avatar, fileName, { signal } = {}) {
    return readRecord(makeKey(avatar, fileName), signal);
}

/** Read compact catalog records one at a time. */
export async function* iterateCachedChatCatalogs(avatar, fileNames, { signal, acceptMetadata } = {}) {
    for (const fileName of fileNames) {
        throwIfAborted(signal);
        const record = await readRecord(CATALOG_PREFIX + makeKey(avatar, fileName), signal);
        throwIfAborted(signal);
        if (record && acceptMetadata && !acceptMetadata(fileName, record)) continue;
        if (record) yield { fileName, entry: record };
    }
}

/**
 * Read only the cached chat entries missing or stale in the in-memory index.
 * @param {string} avatar
 * @param {string[]} fileNames
 * @returns {Promise<Map<string, object>>} Map of fileName -> cached entry
 */
export async function getCachedChatsForCharacter(avatar, fileNames) {
    const result = new Map();
    if (fileNames.length === 0) return result;
    try {
        const database = await openDB();
        for (let offset = 0; offset < fileNames.length; offset += READ_BATCH_SIZE) {
            const batch = fileNames.slice(offset, offset + READ_BATCH_SIZE);
            await new Promise((resolve) => {
                const tx = database.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                for (const fileName of batch) {
                    const request = store.get(makeKey(avatar, fileName));
                    request.onsuccess = () => {
                        const entry = request.result;
                        if (entry?.cacheFormatVersion === CACHE_FORMAT_VERSION) result.set(fileName, entry);
                    };
                }
                tx.oncomplete = resolve;
                tx.onerror = resolve;
                tx.onabort = resolve;
            });
        }
        return result;
    } catch {
        return result;
    }
}

/**
 * Restore usable bodies one bounded batch at a time. Metadata and bodies are
 * read in the same transaction so a concurrent write cannot pair revisions.
 * The consumer must recheck its own session/entry ownership after each await.
 */
export async function consumeCachedChatsForCharacter(avatar, candidates, isValid, consume) {
    let database;
    try { database = await openDB(); } catch { return; }
    for (let offset = 0; offset < candidates.length; offset += READ_BATCH_SIZE) {
        const batch = candidates.slice(offset, offset + READ_BATCH_SIZE);
        const entries = await new Promise((resolve) => {
            const result = new Map();
            const tx = database.transaction([METADATA_STORE_NAME, STORE_NAME], 'readonly');
            const metadataStore = tx.objectStore(METADATA_STORE_NAME);
            const bodyStore = tx.objectStore(STORE_NAME);
            for (const fileName of batch) {
                const request = metadataStore.get(makeKey(avatar, fileName));
                request.onsuccess = () => {
                    const metadata = request.result;
                    if (metadata?.cacheFormatVersion !== CACHE_FORMAT_VERSION || !isValid(fileName, metadata)) return;
                    const bodyRequest = bodyStore.get(makeKey(avatar, fileName));
                    bodyRequest.onsuccess = () => {
                        const body = bodyRequest.result;
                        if (body?.cacheFormatVersion === CACHE_FORMAT_VERSION
                            && body.lastModified === metadata.lastModified
                            && body.serverSignature === metadata.serverSignature
                            && body.validatedAt === metadata.validatedAt
                            && Array.isArray(body.messages) && isValid(fileName, body)) result.set(fileName, body);
                    };
                };
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => resolve(new Map());
        }).catch(() => new Map());
        if (consume(entries) === false) return;
    }
}

/**
 * Write a hydrated chat entry to the cache (fire-and-forget).
 * @param {string} avatar
 * @param {string} fileName
 * @param {object} entry - The ChatIndexEntry to cache
 */
export function putCachedChat(avatar, fileName, entry) {
    return putCachedChats(avatar, [{ fileName, entry }]);
}

function bodyRecord(avatar, fileName, entry) {
    return {
        key: makeKey(avatar, fileName), cacheFormatVersion: CACHE_FORMAT_VERSION,
        avatar, fileName, lastModified: entry.lastModified,
        messageCount: entry.messageCount, messages: entry.messages,
        firstMessageTimestamp: entry.firstMessageTimestamp,
        lastMessageTimestamp: entry.lastMessageTimestamp, sortTimestamp: entry.sortTimestamp,
        validatedAt: entry.validatedAt, serverSignature: entry.serverSignature,
        mainChat: entry.mainChat, bodyEmbeddingText: entry.bodyEmbeddingText,
    };
}

function catalogRecord(avatar, fileName, entry) {
    const descriptors = entry.messageDescriptors || createMessageDescriptors(entry.messages);
    return {
        ...bodyRecord(avatar, fileName, entry),
        key: CATALOG_PREFIX + makeKey(avatar, fileName),
        messages: descriptors, messageDescriptors: descriptors,
        bodyEmbeddingText: entry.bodyEmbeddingText ?? messagePreview((entry.messages || []).slice(-10).map(message => String(message.text || '').trim().slice(0, 2000)).filter(Boolean).join('\n').slice(0, 2000).trim(), 2000),
        bodyResident: false, isLoaded: true,
        // Every writer holds authoritative content; see isTrustedCatalog in chat-reader.js.
        localEditsTracked: true,
    };
}

function queueWrite(key, operation) {
    return new Promise(resolve => {
        const previous = pendingWrites.get(key);
        operation.waiters = [...(previous?.waiters || []), resolve];
        pendingWrites.set(key, operation);
        scheduleFlush();
    });
}

function scheduleFlush() {
    if (flushingWrites) return;
    // Coalesce same-turn updates before cloning the newest body into IDB.
    flushingWrites = Promise.resolve().then(flushWriteLoop).finally(() => {
        flushingWrites = null;
        if (pendingWrites.size) scheduleFlush();
    });
}

async function flushWriteLoop() {
    while (pendingWrites.size) {
        // A single transaction is outstanding at a time. Its completion provides
        // backpressure to the indexer and prevents unlimited structured clones.
        const batch = [...pendingWrites.values()].slice(0, READ_BATCH_SIZE);
        for (const item of batch) pendingWrites.delete(item.key);
        let committed = false;
        try {
            const database = await openDB();
            committed = await new Promise(resolve => {
                const tx = database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
                const metadataStore = tx.objectStore(METADATA_STORE_NAME);
                const store = tx.objectStore(STORE_NAME);
                for (const item of batch) {
                    if (item.remove) {
                        store.delete(item.key);
                        store.delete(CATALOG_PREFIX + item.key);
                        metadataStore.delete(item.key);
                    } else {
                        if (item.body) store.put(item.body);
                        store.put(item.catalog);
                        metadataStore.put({ key: item.key, cacheFormatVersion: CACHE_FORMAT_VERSION,
                            lastModified: item.catalog.lastModified, validatedAt: item.catalog.validatedAt,
                            serverSignature: item.catalog.serverSignature });
                    }
                }
                tx.oncomplete = () => resolve(true);
                tx.onerror = tx.onabort = () => resolve(false);
            });
        } catch { /* A cache failure never changes the source chat files. */ }
        for (const item of batch) {
            for (const resolve of item.waiters) resolve(committed);
            item.body = item.catalog = null;
        }
    }
}

/** Wait for the current coalesced cache work; useful before cold reads. */
export async function flushPendingCacheWrites() {
    while (flushingWrites) await flushingWrites;
}

/**
 * Write several hydrated entries using one transaction.
 * @param {string} avatar
 * @param {Array<{fileName: string, entry: object}>} chats
 */
export function putCachedChats(avatar, chats) {
    if (!Array.isArray(chats) || chats.length === 0) return Promise.resolve(true);
    const writes = [];
    for (const { fileName, entry } of chats) {
        if (!fileName || !entry) continue;
        const key = makeKey(avatar, fileName);
        const hasBody = entry.bodyResident !== false && !(entry.messages || []).some(message => message?.isDescriptor);
        writes.push(queueWrite(key, {
            key, body: hasBody ? bodyRecord(avatar, fileName, entry) : null,
            catalog: catalogRecord(avatar, fileName, entry),
        }));
    }
    return Promise.all(writes).then(results => results.every(Boolean));
}

/**
 * Remove a cached chat entry (fire-and-forget).
 * @param {string} avatar
 * @param {string} fileName
 */
export function removeCachedChat(avatar, fileName) {
    const key = makeKey(avatar, fileName);
    return queueWrite(key, { key, remove: true });
}
