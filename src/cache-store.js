/**
 * Cache Store — IndexedDB persistent cache for hydrated chat entries.
 * Keyed by `{avatar}:{fileName}` with `lastModified` staleness check.
 */

const DB_NAME = 'chat_manager_cache';
const DB_VERSION = 1;
const STORE_NAME = 'chats';

/** @type {IDBDatabase|null} */
let db = null;

/**
 * Open (or reuse) the IndexedDB database.
 * @returns {Promise<IDBDatabase>}
 */
function openDB() {
    if (db) return Promise.resolve(db);

    return new Promise((resolve, reject) => {
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
            console.error('[chat_manager] Failed to open IndexedDB:', event.target.error);
            reject(event.target.error);
        };
    });
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
 * Bulk-read all cached chat entries for a character.
 * @param {string} avatar
 * @returns {Promise<Map<string, object>>} Map of fileName -> cached entry
 */
export async function getCachedChatsForCharacter(avatar) {
    const result = new Map();
    try {
        const database = await openDB();
        return new Promise((resolve) => {
            const tx = database.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const index = store.index('avatar');
            const request = index.openCursor(IDBKeyRange.only(avatar));

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    result.set(cursor.value.fileName, cursor.value);
                    cursor.continue();
                }
            };

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
