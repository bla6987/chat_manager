/**
 * Cache Store — IndexedDB cache of work already done on the server's chat files.
 *
 * chatSummaries holds one small record per chat and is read for a whole character
 * in one transaction, so opening costs one read however large the archive is.
 * chatDescriptors holds the compact per-message rows, read one chat at a time by
 * the few views that need them. chatBodies holds complete text under a byte cap:
 * the server's files stay authoritative, so a missing body only costs a download.
 */

const DB_NAME = 'chat_manager_cache';
// Version 4 replaces the earlier uncapped stores. Everything in them is derived
// from chat files and is rebuilt on demand, so dropping them loses nothing.
const DB_VERSION = 4;
const CACHE_FORMAT_VERSION = 3;
const LEGACY_STORES = ['chats', 'chatMetadata'];
const SUMMARY_STORE = 'chatSummaries';
const DESCRIPTOR_STORE = 'chatDescriptors';
const BODY_STORE = 'chatBodies';
const LEDGER_STORE = 'chatBodyLedger';
const ALL_STORES = [SUMMARY_STORE, DESCRIPTOR_STORE, BODY_STORE, LEDGER_STORE];
const WRITE_BATCH_SIZE = 50;

/** Shared by every character, because storage is shared. */
export const DEFAULT_BODY_STORE_BYTES = 64 * 1024 * 1024;
let bodyStoreBudget = DEFAULT_BODY_STORE_BYTES;

const pendingWrites = new Map();
let flushingWrites = null;

/** key -> { bytes, usedAt }, loaded once and kept in step with each write. */
let bodyLedger = null;
let bodyLedgerBytes = 0;
const touchedLedgerKeys = new Set();

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
            for (const name of LEGACY_STORES) {
                if (database.objectStoreNames.contains(name)) database.deleteObjectStore(name);
            }
            if (!database.objectStoreNames.contains(SUMMARY_STORE)) {
                database.createObjectStore(SUMMARY_STORE, { keyPath: 'key' }).createIndex('avatar', 'avatar', { unique: false });
            }
            for (const name of [DESCRIPTOR_STORE, BODY_STORE, LEDGER_STORE]) {
                if (!database.objectStoreNames.contains(name)) database.createObjectStore(name, { keyPath: 'key' });
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
            // An older tab may hold a previous version open without a versionchange
            // handler. Continue from the server instead of hanging the index build.
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

async function readRecord(storeName, key, signal) {
    throwIfAborted(signal);
    try {
        const database = await openDB();
        const result = await new Promise(resolve => {
            const tx = database.transaction(storeName, 'readonly');
            let value = null;
            const request = tx.objectStore(storeName).get(key);
            request.onsuccess = () => { value = request.result; };
            tx.oncomplete = () => resolve(value?.cacheFormatVersion === CACHE_FORMAT_VERSION ? value : null);
            tx.onerror = tx.onabort = () => resolve(null);
        });
        throwIfAborted(signal);
        return result;
    } catch (error) {
        throwIfAborted(signal);
        return null;
    }
}

/**
 * Read every chat summary of one character in a single transaction.
 * @param {string} avatar
 * @returns {Promise<Map<string, object>>} fileName -> summary record
 */
export async function getCachedSummaries(avatar) {
    const result = new Map();
    try {
        const database = await openDB();
        await new Promise(resolve => {
            const tx = database.transaction(SUMMARY_STORE, 'readonly');
            const request = tx.objectStore(SUMMARY_STORE).index('avatar').getAll(avatar);
            request.onsuccess = () => {
                for (const record of request.result || []) {
                    if (record?.cacheFormatVersion === CACHE_FORMAT_VERSION) result.set(record.fileName, record);
                }
            };
            tx.oncomplete = resolve;
            tx.onerror = tx.onabort = resolve;
        });
    } catch { /* Proceed without a cache; the server's files remain readable. */ }
    return result;
}

/** Read the per-message rows of one chat. */
export function getCachedDescriptors(avatar, fileName, { signal } = {}) {
    return readRecord(DESCRIPTOR_STORE, makeKey(avatar, fileName), signal);
}

/** Read one complete body, never a whole-character collection. */
export async function getCachedBody(avatar, fileName, { signal } = {}) {
    const key = makeKey(avatar, fileName);
    const record = await readRecord(BODY_STORE, key, signal);
    const known = record && bodyLedger?.get(key);
    if (known) {
        known.usedAt = Date.now();
        touchedLedgerKeys.add(key);
    }
    return record;
}

function validity(entry) {
    return { lastModified: entry.lastModified, serverSignature: entry.serverSignature, validatedAt: entry.validatedAt };
}

function summaryRecord(avatar, fileName, entry) {
    return {
        key: makeKey(avatar, fileName), cacheFormatVersion: CACHE_FORMAT_VERSION, avatar, fileName, ...validity(entry),
        sortTimestamp: entry.sortTimestamp, messageCount: entry.messageCount,
        firstMessageTimestamp: entry.firstMessageTimestamp, lastMessageTimestamp: entry.lastMessageTimestamp,
        mainChat: entry.mainChat ?? null, bodyEmbeddingText: entry.bodyEmbeddingText ?? '',
        lastMessagePreview: entry.lastMessagePreview ?? '', userMessageCount: entry.userMessageCount ?? 0,
        activity: entry.activity ?? [], branchTargets: entry.branchTargets ?? [], openingKeys: entry.openingKeys ?? [],
        contentHash: entry.contentHash ?? null, variants: entry.variants ?? null,
    };
}

function descriptorRecord(avatar, fileName, entry, payload) {
    return { key: makeKey(avatar, fileName), cacheFormatVersion: CACHE_FORMAT_VERSION, ...validity(entry), payload };
}

function bodyRecord(avatar, fileName, entry, messages) {
    return { key: makeKey(avatar, fileName), cacheFormatVersion: CACHE_FORMAT_VERSION, ...validity(entry), messages };
}

function queueWrite(key, operation) {
    return new Promise(resolve => {
        const previous = pendingWrites.get(key);
        operation.waiters = [...(previous?.waiters || []), resolve];
        // A later chat update must not lose a body queued by the same chat's read.
        if (previous && !operation.remove && !previous.remove && !operation.body) {
            operation.body = previous.body;
            operation.bodyBytes = previous.bodyBytes;
            operation.evict = previous.evict;
        }
        pendingWrites.set(key, operation);
        scheduleFlush();
    });
}

function scheduleFlush() {
    if (flushingWrites) return;
    // Coalesce same-turn updates before cloning the newest records into IDB.
    flushingWrites = Promise.resolve().then(flushWriteLoop).finally(() => {
        flushingWrites = null;
        if (pendingWrites.size) scheduleFlush();
    });
}

async function loadBodyLedger(database) {
    if (bodyLedger) return;
    const records = await new Promise(resolve => {
        let found = [];
        const tx = database.transaction(LEDGER_STORE, 'readonly');
        const request = tx.objectStore(LEDGER_STORE).getAll();
        request.onsuccess = () => { found = request.result || []; };
        tx.oncomplete = () => resolve(found);
        tx.onerror = tx.onabort = () => resolve([]);
    });
    bodyLedger = new Map(records.map(({ key, bytes, usedAt }) => [key, { bytes, usedAt }]));
    bodyLedgerBytes = records.reduce((sum, record) => sum + (record.bytes || 0), 0);
}

function forgetLedgerBody(key, ledgerStore, bodyStore) {
    const known = bodyLedger.get(key);
    if (!known) return;
    bodyLedgerBytes -= known.bytes || 0;
    bodyLedger.delete(key);
    touchedLedgerKeys.delete(key);
    bodyStore.delete(key);
    ledgerStore.delete(key);
}

/**
 * Admit a body under the byte cap. A single chat's read may displace the least
 * recently used bodies. An archive scan only fills free space: evicting on a scan
 * larger than the cap would rewrite everything and leave nothing useful behind.
 */
function admitBody(item, ledgerStore, bodyStore) {
    forgetLedgerBody(item.key, ledgerStore, bodyStore);
    const bytes = item.bodyBytes;
    if (!(bytes <= bodyStoreBudget)) return;
    if (bodyLedgerBytes + bytes > bodyStoreBudget) {
        if (!item.evict) return;
        const oldest = [...bodyLedger].sort((a, b) => a[1].usedAt - b[1].usedAt);
        for (const [key] of oldest) {
            if (bodyLedgerBytes + bytes <= bodyStoreBudget) break;
            forgetLedgerBody(key, ledgerStore, bodyStore);
        }
    }
    const usedAt = Date.now();
    bodyStore.put(item.body);
    ledgerStore.put({ key: item.key, bytes, usedAt });
    bodyLedger.set(item.key, { bytes, usedAt });
    bodyLedgerBytes += bytes;
}

async function flushWriteLoop() {
    while (pendingWrites.size) {
        // A single transaction is outstanding at a time. Its completion provides
        // backpressure to the indexer and prevents unlimited structured clones.
        const batch = [...pendingWrites.values()].slice(0, WRITE_BATCH_SIZE);
        for (const item of batch) pendingWrites.delete(item.key);
        let committed = false;
        try {
            const database = await openDB();
            await loadBodyLedger(database);
            committed = await new Promise(resolve => {
                const tx = database.transaction(ALL_STORES, 'readwrite');
                const summaries = tx.objectStore(SUMMARY_STORE);
                const descriptors = tx.objectStore(DESCRIPTOR_STORE);
                const bodies = tx.objectStore(BODY_STORE);
                const ledger = tx.objectStore(LEDGER_STORE);
                for (const item of batch) {
                    if (item.remove) {
                        summaries.delete(item.key);
                        descriptors.delete(item.key);
                        forgetLedgerBody(item.key, ledger, bodies);
                        bodies.delete(item.key);
                        continue;
                    }
                    if (item.summary) summaries.put(item.summary);
                    if (item.descriptors) descriptors.put(item.descriptors);
                    if (item.body) admitBody(item, ledger, bodies);
                }
                for (const key of touchedLedgerKeys) {
                    const known = bodyLedger.get(key);
                    if (known) ledger.put({ key, ...known });
                }
                touchedLedgerKeys.clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = tx.onabort = () => resolve(false);
            });
        } catch { /* A cache failure never changes the source chat files. */ }
        for (const item of batch) {
            for (const resolve of item.waiters) resolve(committed);
            item.body = item.summary = item.descriptors = null;
        }
    }
}

/** Wait for the current coalesced cache work; useful before cold reads. */
export async function flushPendingCacheWrites() {
    while (flushingWrites) await flushingWrites;
}

/**
 * Write several indexed chats using one transaction.
 * @param {string} avatar
 * @param {Array<{ fileName: string, entry: object, descriptorsPayload?: string, body?: Array, evictBodies?: boolean }>} chats
 *   body stores complete text; evictBodies lets it displace older bodies.
 * @returns {Promise<boolean>} Whether every write committed
 */
export function putCachedChats(avatar, chats) {
    if (!Array.isArray(chats) || chats.length === 0) return Promise.resolve(true);
    const writes = [];
    for (const { fileName, entry, descriptorsPayload, body, evictBodies = true } of chats) {
        if (!fileName || !entry) continue;
        writes.push(queueWrite(makeKey(avatar, fileName), {
            key: makeKey(avatar, fileName),
            summary: summaryRecord(avatar, fileName, entry),
            descriptors: typeof descriptorsPayload === 'string' ? descriptorRecord(avatar, fileName, entry, descriptorsPayload) : null,
            body: body ? bodyRecord(avatar, fileName, entry, body) : null,
            bodyBytes: entry.bodyBytes,
            evict: evictBodies,
        }));
    }
    return Promise.all(writes).then(results => results.every(Boolean));
}

/** Write one indexed chat. See putCachedChats. */
export function putCachedChat(avatar, fileName, entry, extra = {}) {
    return putCachedChats(avatar, [{ fileName, entry, ...extra }]);
}

/**
 * Store a body read for an already indexed, unchanged chat.
 * @param {string} avatar
 * @param {string} fileName
 * @param {object} entry
 * @param {Array} messages
 * @param {{ evictBodies?: boolean }} [options]
 */
export function putCachedBody(avatar, fileName, entry, messages, { evictBodies = true } = {}) {
    const key = makeKey(avatar, fileName);
    return queueWrite(key, { key, body: bodyRecord(avatar, fileName, entry, messages), bodyBytes: entry.bodyBytes, evict: evictBodies });
}

/**
 * Remove everything cached for a chat (fire-and-forget).
 * @param {string} avatar
 * @param {string} fileName
 */
export function removeCachedChat(avatar, fileName) {
    const key = makeKey(avatar, fileName);
    return queueWrite(key, { key, remove: true });
}

/** Controlled testing of the stored-body cap. */
export function setBodyStoreBudget(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) throw new RangeError('Body store budget must be a nonnegative number of bytes');
    bodyStoreBudget = Math.floor(bytes);
}

export function getBodyStoreStats() {
    return { budgetBytes: bodyStoreBudget, storedBytes: bodyLedgerBytes, storedChats: bodyLedger?.size ?? 0 };
}
