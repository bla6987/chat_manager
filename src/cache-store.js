/**
 * Cache Store — IndexedDB persistent cache for hydrated chat entries.
 * Keyed by `{avatar}:{fileName}` with `lastModified` staleness check.
 */

const DB_NAME = 'chat_manager_cache';
// Version 3 adds lightweight validity metadata; version 2 discarded legacy message IDs.
const DB_VERSION = 3;
const CACHE_FORMAT_VERSION = 2;
const STORE_NAME = 'chats';
const METADATA_STORE_NAME = 'chatMetadata';
const READ_BATCH_SIZE = 50;

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
    putCachedChats(avatar, [{ fileName, entry }]);
}

/**
 * Write several hydrated entries using one transaction.
 * @param {string} avatar
 * @param {Array<{fileName: string, entry: object}>} chats
 */
export function putCachedChats(avatar, chats) {
    if (!Array.isArray(chats) || chats.length === 0) return;
    openDB().then((database) => {
        const tx = database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const { fileName, entry } of chats) {
            if (!fileName || !entry) continue;
            const record = {
                key: makeKey(avatar, fileName),
                cacheFormatVersion: CACHE_FORMAT_VERSION,
                avatar,
                fileName,
                lastModified: entry.lastModified,
                messageCount: entry.messageCount,
                messages: entry.messages,
                firstMessageTimestamp: entry.firstMessageTimestamp,
                lastMessageTimestamp: entry.lastMessageTimestamp,
                sortTimestamp: entry.sortTimestamp,
                validatedAt: entry.validatedAt,
                serverSignature: entry.serverSignature,
                mainChat: entry.mainChat,
            };
            store.put(record);
            tx.objectStore(METADATA_STORE_NAME).put({
                key: record.key,
                cacheFormatVersion: record.cacheFormatVersion,
                lastModified: record.lastModified,
                validatedAt: record.validatedAt,
                serverSignature: record.serverSignature,
            });
        }
    }).catch(() => {
        // Silently ignore cache write failures
    });
}

/**
 * Remove a cached chat entry (fire-and-forget).
 * @param {string} avatar
 * @param {string} fileName
 */
export function removeCachedChat(avatar, fileName) {
    openDB().then((database) => {
        const tx = database.transaction([STORE_NAME, METADATA_STORE_NAME], 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(makeKey(avatar, fileName));
        tx.objectStore(METADATA_STORE_NAME).delete(makeKey(avatar, fileName));
    }).catch(() => {
        // Silently ignore cache delete failures
    });
}
