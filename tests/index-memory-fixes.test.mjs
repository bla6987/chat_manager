import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Transaction snapshots model IndexedDB's isolation between concurrent writes
// and a metadata-first body read, including requests enqueued by success events.
const stores = new Map([['chats', new Map()], ['chatMetadata', new Map()]]);
let bodyReads = [];
let transactionStores = [];
let beforeBodyRead = null;
let failReads = false;
let delayReadCompletion = null;
let oldVersion = 2;
let upgrades = [];
globalThis.indexedDB = { open(_name, version) {
    const request = {};
    setImmediate(() => {
        const database = {
            objectStoreNames: { contains: name => stores.has(name) },
            createObjectStore(name) { upgrades.push(name); stores.set(name, new Map()); return { createIndex() {} }; },
            deleteObjectStore(name) { stores.delete(name); },
            close() {},
            transaction(names, mode) {
                const scope = Array.isArray(names) ? names : [names];
                transactionStores.push({ names: scope, mode });
                const snapshots = new Map(scope.map(name => [name, new Map(stores.get(name))]));
                let pending = 0;
                const tx = { objectStore(name) {
                    assert.ok(scope.includes(name));
                    return {
                        get(key) {
                            pending++;
                            const req = {};
                            if (name === 'chats') { bodyReads.push(key); beforeBodyRead?.(key); }
                            setImmediate(() => {
                                req.result = structuredClone(snapshots.get(name).get(key));
                                req.onsuccess?.();
                                pending--;
                                if (!pending) setImmediate(() => {
                                    const complete = () => failReads ? tx.onabort?.() : tx.oncomplete?.();
                                    if (delayReadCompletion) delayReadCompletion(complete);
                                    else complete();
                                });
                            });
                            return req;
                        },
                        put(record) { stores.get(name).set(record.key, structuredClone(record)); },
                        delete(key) { stores.get(name).delete(key); },
                    };
                } };
                if (mode === 'readwrite') setImmediate(() => tx.oncomplete?.());
                return tx;
            },
        };
        if (oldVersion < version) request.onupgradeneeded?.({ oldVersion, target: { result: database } });
        oldVersion = version;
        request.onsuccess?.({ target: { result: database } });
    });
    return request;
} };
const cache = await import('../src/cache-store.js');
const valid = (_name, record) => record.lastModified === 1 && record.serverSignature === 'current'
    && Date.now() - record.validatedAt < 60_000 && record.validatedAt <= Date.now();
function seed(name, overrides = {}) {
    const record = { key: `avatar:${name}`, fileName: name, cacheFormatVersion: 2,
        lastModified: 1, serverSignature: 'current', validatedAt: Date.now(), messages: [{ text: name }], ...overrides };
    stores.get('chats').set(record.key, record);
    const { messages, ...metadata } = record;
    stores.get('chatMetadata').set(record.key, metadata);
}
function reset() {
    for (const store of stores.values()) store.clear();
    bodyReads = []; transactionStores = []; beforeBodyRead = null; failReads = false; delayReadCompletion = null;
}

test('v2 migration preserves bodies while metadata-less bodies are safely skipped', async () => {
    reset(); stores.delete('chatMetadata');
    stores.get('chats').set('avatar:legacy', { messages: [{ text: 'legacy' }] });
    const restored = [];
    await cache.consumeCachedChatsForCharacter('avatar', ['legacy'], valid, batch => restored.push(...batch));
    assert.deepEqual(upgrades, ['chatMetadata']);
    assert.equal(stores.get('chats').get('avatar:legacy').messages[0].text, 'legacy');
    assert.deepEqual(bodyReads, []); assert.deepEqual(restored, []);
});

test('stale timestamps, signatures, TTL and future validation never clone bodies', async () => {
    reset();
    seed('timestamp', { lastModified: 0 }); seed('signature', { serverSignature: 'old' });
    seed('expired', { validatedAt: Date.now() - 60_001 }); seed('future', { validatedAt: Date.now() + 60_000 });
    await cache.consumeCachedChatsForCharacter('avatar', ['timestamp', 'signature', 'expired', 'future'], valid,
        batch => assert.equal(batch.size, 0));
    assert.deepEqual(bodyReads, []);
});

test('fresh bodies are consumed in bounded batches with consistent metadata', async () => {
    reset();
    const names = Array.from({ length: 121 }, (_, i) => `chat${i}`);
    names.forEach(name => seed(name));
    const sizes = []; let readAtConsumption = 0;
    await cache.consumeCachedChatsForCharacter('avatar', names, valid, batch => {
        sizes.push(batch.size);
        assert.equal(bodyReads.length - readAtConsumption, batch.size);
        readAtConsumption = bodyReads.length;
        for (const [name, body] of batch) assert.equal(body.messages[0].text, name);
    });
    assert.deepEqual(sizes, [50, 50, 21]);
    assert.ok(transactionStores.every(tx => tx.names.includes('chatMetadata') && tx.names.includes('chats')));
});

test('mismatched bodies and aborted reads cannot be accepted', async () => {
    reset(); seed('mismatch');
    stores.get('chats').get('avatar:mismatch').validatedAt--;
    await cache.consumeCachedChatsForCharacter('avatar', ['mismatch'], valid, batch => assert.equal(batch.size, 0));
    seed('aborted'); failReads = true;
    await cache.consumeCachedChatsForCharacter('avatar', ['aborted'], valid, batch => assert.equal(batch.size, 0));
});

test('a concurrent replacement cannot mix metadata and body revisions', async () => {
    reset(); seed('racing');
    beforeBodyRead = () => seed('racing', { validatedAt: 0, messages: [{ text: 'new stale revision' }] });
    await cache.consumeCachedChatsForCharacter('avatar', ['racing'], valid, batch => {
        assert.equal(batch.get('racing').messages[0].text, 'racing');
        assert.notEqual(batch.get('racing').validatedAt, 0);
    });
});

test('consumer cancellation stops additional body batches; writes pair metadata and body', async () => {
    reset();
    const names = Array.from({ length: 101 }, (_, i) => `${i}`); names.forEach(name => seed(name));
    await cache.consumeCachedChatsForCharacter('avatar', names, valid, () => false);
    assert.equal(bodyReads.length, 50);
    cache.putCachedChat('avatar', 'written', { lastModified: 7, validatedAt: 8, serverSignature: 'sig', messages: [] });
    await new Promise(resolve => setImmediate(resolve));
    const last = transactionStores.at(-1);
    assert.equal(last.mode, 'readwrite'); assert.deepEqual(last.names, ['chats', 'chatMetadata']);
    assert.equal(stores.get('chatMetadata').get('avatar:written').validatedAt, stores.get('chats').get('avatar:written').validatedAt);
    assert.equal('messages' in stores.get('chatMetadata').get('avatar:written'), false);
});

test('clearIndex releases the owned flattened search cache immediately', async () => {
    // Expose ownership for this isolated test without adding production diagnostics.
    let source = await readFile(new URL('../src/chat-reader.js', import.meta.url), 'utf8');
    source = source.replace(/from '(\.\/[^']+)'/g, (_match, relative) =>
        `from '${new URL(`../src/${relative.slice(2)}`, import.meta.url).href}'`);
    source += '\nexport const inspectOwnedSearchCache = () => cachedSearchableMessages;';
    const reader = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
    globalThis.SillyTavern = { getContext: () => ({ characterId: 0, characters: [{ avatar: 'avatar' }], chat: [] }) };
    reader.getIndex()['a.jsonl'] = { messages: [{ text: 'owned message', index: 0 }], isLoaded: true };
    const messages = reader.getSearchableMessages();
    assert.equal(messages.length, 1); assert.equal(reader.inspectOwnedSearchCache(), messages);
    reader.clearIndex();
    assert.equal(reader.inspectOwnedSearchCache(), null);
    assert.equal(messages.length, 1); // A caller still owns its explicit result.
});


test('restored compact catalogs invalidate searches before the next catalog completes', async () => {
    reset();
    const reader = await import('../src/chat-reader.js');
    reader.clearIndex();
    const date = '2026-10-16T12:00:00Z';
    const names = Array.from({ length: 51 }, (_, i) => `batch${i}.jsonl`);
    names.forEach(name => seed(name, {
        key: `\u0000catalog:avatar:${name}`, bodyResident: false, localEditsTracked: true,
        lastModified: Date.parse(date), serverSignature: JSON.stringify(['100 B', 1]),
        messageCount: 1, messages: [{ filename: name, index: 0, role: 'assistant', text: '', isDescriptor: true }],
    }));
    const context = { characterId: 0, characters: [{ avatar: 'avatar' }], chat: [],
        getRequestHeaders: () => ({}) };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, json: async () => names.map(file_name => ({
        file_name, last_mes: date, file_size: '100 B', chat_items: 1,
    })) });
    let release;
    const paused = new Promise(resolve => {
        delayReadCompletion = complete => {
            if (bodyReads.filter(key => key.startsWith('\u0000catalog:')).length === 51) { release = complete; resolve(); }
            else complete();
        };
    });
    let initialSearch;
    const building = reader.buildIndex(null, () => { initialSearch = reader.getSearchableMessages(); });
    await paused;
    try {
        assert.equal(initialSearch.length, 0);
        assert.equal(Object.values(reader.getIndex()).filter(entry => entry.isLoaded).length, 50);
        assert.ok(Object.values(reader.getIndex()).filter(entry => entry.isLoaded).every(entry => entry.bodyResident === false));
        assert.equal(reader.getSearchableMessages().length, 0, 'descriptor restores do not retain complete search bodies');
        assert.notEqual(reader.getSearchableMessages(), initialSearch);
    } finally {
        delayReadCompletion = null; release(); await building; reader.clearIndex();
    }
});
