/**
 * Cache Store — IndexedDB persistent cache for hydrated chat entries.
 * Keyed by `{avatar}:{fileName}` with `lastModified` staleness check.
 */

const DB_NAME = 'chat_manager_cache';
// Version 2 discards records whose message IDs included the JSONL header.
const DB_VERSION = 2;
const CACHE_FORMAT_VERSION = 2;
const STORE_NAME = 'chats';
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
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        for (const { fileName, entry } of chats) {
            if (!fileName || !entry) continue;
            store.put({
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
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(makeKey(avatar, fileName));
    }).catch(() => {
        // Silently ignore cache delete failures
    });
}
