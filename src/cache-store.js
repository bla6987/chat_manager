/**
 * Cache Store — IndexedDB persistent cache for hydrated chat entries.
 * Keyed by `{avatar}:{fileName}` with `lastModified` staleness check.
 */

const DB_NAME = 'chat_manager_cache';
const DB_VERSION = 1;
const STORE_NAME = 'chats';

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
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
                store.createIndex('avatar', 'avatar', { unique: false });
            }
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            resolve(db);
        };

        request.onerror = (event) => {
            dbPromise = null; // allow retry on failure
            console.error('[chat_manager] Failed to open IndexedDB:', event.target.error);
            reject(event.target.error);
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
        return new Promise((resolve) => {
            const tx = database.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            for (const fileName of fileNames) {
                const request = store.get(makeKey(avatar, fileName));
                request.onsuccess = () => {
                    const entry = request.result;
                    if (!entry) return;
                    result.set(fileName, entry);
                };
            }

            tx.oncomplete = () => resolve(result);
            tx.onerror = () => resolve(result);
        });
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
    openDB().then((database) => {
        const tx = database.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put({
            key: makeKey(avatar, fileName),
            avatar,
            fileName,
            lastModified: entry.lastModified,
            messageCount: entry.messageCount,
            messages: entry.messages,
            firstMessageTimestamp: entry.firstMessageTimestamp,
            lastMessageTimestamp: entry.lastMessageTimestamp,
            sortTimestamp: entry.sortTimestamp,
        });
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
