import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const fake = installFakeIndexedDB({ schedule: setImmediate });
const reader = await import('../src/chat-reader.js');
const cache = await import('../src/cache-store.js');
const { decodeDescriptors } = await import('../src/chat-index-data.js');
const date = '2026-10-14T12:00:00Z';
const raw = (mes, extra = {}) => ({ mes, is_user: false, send_date: date, ...extra });
let context;
let rows;
let bodies;
let failures;
let contentRequests;
function setup(names = ['a.jsonl']) {
    reader.clearIndex(); fake.reset(); contentRequests = 0;
    context = { characterId: 0, characters: [{ avatar: 'test.png', name: 'Test' }], chat: [], chatMetadata: {},
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    rows = names.map(file_name => ({ file_name, last_mes: date, chat_items: 2, file_size: '100 B' }));
    bodies = new Map(names.map(name => [name, [{ chat_metadata: {} }, raw('greeting'), raw(name)]]));
    failures = new Set();
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        const list = url === '/api/characters/chats';
        const file = list ? 'list' : `${JSON.parse(options.body).file_name}.jsonl`;
        if (!list) contentRequests++;
        return { ok: !failures.has(file), status: failures.has(file) ? 500 : 200,
            json: async () => structuredClone(list ? rows : bodies.get(file)) };
    };
}
afterEach(async () => { reader.clearIndex(); await new Promise(resolve => setImmediate(resolve)); });

test('disk and live parsing keep host IDs, ancestry and swipe content consistent', async () => {
    setup();
    bodies.set('a.jsonl', [{ chat_metadata: { main_chat: 'parent' } }, raw('greeting', { extra: { branches: ['child'] } }), raw('answer')]);
    await reader.buildIndex(); assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    const entry = reader.getIndex()['a.jsonl'];
    assert.deepEqual(entry.messages.map(m => m.index), [0, 1]);
    assert.equal(entry.mainChat, 'parent.jsonl');
    assert.deepEqual(entry.messages[0].branches, ['child.jsonl']);
    context.chat = bodies.get('a.jsonl').slice(1); context.chatMetadata = { main_chat: 'parent' };
    assert.equal(await reader.updateActiveChat('a.jsonl'), false);
    assert.equal(reader.getIndex()['a.jsonl'], entry);
    await cache.flushPendingCacheWrites();
    assert.equal(fake.store('chatSummaries').get('test.png:a.jsonl').mainChat, 'parent.jsonl');
    assert.deepEqual(fake.store('chatSummaries').get('test.png:a.jsonl').branchTargets, ['child.jsonl']);
    assert.deepEqual(decodeDescriptors(fake.store('chatDescriptors').get('test.png:a.jsonl').payload, 'a.jsonl')[0].branches, ['child.jsonl']);
});

test('failed cold hydration stays retryable; content the list calls empty is loaded', async () => {
    setup(); failures.add('a.jsonl'); await reader.buildIndex();
    assert.equal(await reader.loadEntryNow('a.jsonl'), false);
    assert.equal(reader.getIndex()['a.jsonl'].isLoaded, false);
    assert.equal(fake.writeTransactions, 0);
    failures.clear(); bodies.set('a.jsonl', []);
    const warn = console.warn; console.warn = () => {};
    try { assert.equal(await reader.loadEntryNow('a.jsonl'), false, 'the list counted messages, so this read missed the file'); } finally { console.warn = warn; }
    assert.equal(reader.getIndex()['a.jsonl'].isLoaded, false);
    rows[0].chat_items = 0;
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    assert.equal(reader.getIndex()['a.jsonl'].messageCount, 0);
});

test('list failure and body revalidation failure preserve known good search content', async () => {
    setup(); await reader.buildIndex(); await reader.loadEntryNow('a.jsonl');
    const known = reader.getSearchableMessages(); const version = reader.getIndexVersion();
    failures.add('list'); await reader.buildIndex();
    assert.equal(reader.getIndexVersion(), version); assert.equal(reader.getSearchableMessages(), known);
    failures.delete('list'); failures.add('a.jsonl');
    await reader.buildIndex(null, null, { forceRevalidate: true });
    assert.equal(await reader.loadEntryNow('a.jsonl'), false);
    assert.equal(reader.getIndex()['a.jsonl'].isLoaded, true);
    assert.deepEqual(reader.getSearchableMessages().map(m => m.text), known.map(m => m.text));
    failures.clear(); bodies.get('a.jsonl')[1].mes = 'edited';
    assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    assert.equal(reader.getIndex()['a.jsonl'].messages[0].text, 'edited');
});

test('successful empty archive invalidates search results and releases cached bodies', async () => {
    setup(); await reader.buildIndex(); await reader.loadEntryNow('a.jsonl');
    reader.getSearchableMessages(); const version = reader.getIndexVersion();
    rows = []; await reader.buildIndex();
    assert.ok(reader.getIndexVersion() > version); assert.deepEqual(reader.getSearchableMessages(), []);
    await cache.flushPendingCacheWrites(); assert.equal(fake.store('chatSummaries').size, 0); assert.equal(fake.store('chatDescriptors').size, 0);
});

test('same-length earlier edits revalidate explicitly and when dirty, never by elapsed time', async () => {
    setup(); await reader.buildIndex(); await reader.loadEntryNow('a.jsonl');
    const before = contentRequests; await reader.buildIndex();
    assert.equal(contentRequests, before, 'known-good entries reuse their body');
    bodies.get('a.jsonl')[1].mes = 'new text';
    await reader.buildIndex(null, null, { forceRevalidate: true }); await reader.loadEntryNow('a.jsonl');
    assert.equal(reader.getIndex()['a.jsonl'].messages[0].text, 'new text');
    bodies.get('a.jsonl')[1].mes = 'old text'; reader.markChatDirty('a.jsonl');
    await reader.loadEntryNow('a.jsonl'); assert.equal(reader.getIndex()['a.jsonl'].messages[0].text, 'old text');
    reader.getIndex()['a.jsonl'].validatedAt -= 7 * 24 * 3_600_000; bodies.get('a.jsonl')[1].mes = 'remote text';
    const settled = contentRequests; await reader.buildIndex();
    assert.equal(contentRequests, settled, 'age alone does not re-read matching metadata');
    await reader.buildIndex(null, null, { forceRevalidate: true }); await reader.loadEntryNow('a.jsonl');
    assert.equal(reader.getIndex()['a.jsonl'].messages[0].text, 'remote text');
});

test('warm cached restoration reconciles queue membership with linear work', async () => {
    const count = 1000; setup(Array.from({ length: count }, (_, i) => `${i}.jsonl`));
    await reader.getIndex(); await cache.flushPendingCacheWrites();
    await cache.putCachedChats('test.png', rows.map(row => ({ fileName: row.file_name, entry: {
        lastModified: Date.parse(date), validatedAt: 1, serverSignature: JSON.stringify(['100 B', 2]), messageCount: 2,
    } })));
    await cache.flushPendingCacheWrites();
    let visits = 0;
    const filter = Array.prototype.filter;
    Array.prototype.filter = function (callback, thisArg) {
        return filter.call(this, (item, i, array) => {
            if (typeof item === 'string' && item.endsWith('.jsonl')) visits++;
            return callback.call(thisArg, item, i, array);
        });
    };
    try { await reader.buildIndex(); } finally { Array.prototype.filter = filter; }
    assert.equal(reader.isHydrationComplete(), true);
    assert.equal(contentRequests, 0); assert.ok(visits <= count * 2, `${visits} queue visits for ${count} files`);
});

test('prompt sibling context requires host provenance and compares message roles', async () => {
    setup(['a.jsonl', 'independent.jsonl', 'child.jsonl', 'cousin.jsonl']);
    bodies.get('child.jsonl')[0].chat_metadata.main_chat = 'a';
    bodies.get('cousin.jsonl')[0].chat_metadata.main_chat = 'a';
    await reader.buildIndex();
    await Promise.all(rows.map(row => reader.loadEntryNow(row.file_name)));
    assert.deepEqual((await reader.getSiblingBranchContextForThread('a.jsonl')).map(e => e.fileName).sort(), ['child.jsonl', 'cousin.jsonl']);
    assert.deepEqual(await reader.getSiblingBranchContextForThread('independent.jsonl'), []);
    bodies.get('child.jsonl')[1].mes = 'alternate first greeting';
    reader.markChatDirty('child.jsonl'); await reader.loadEntryNow('child.jsonl');
    assert.equal((await reader.getSiblingBranchContextForThread('a.jsonl')).find(e => e.fileName === 'child.jsonl').branchPoint, 0);
    bodies.get('independent.jsonl')[1].extra = { branches: ['a'] };
    reader.markChatDirty('independent.jsonl'); await reader.loadEntryNow('independent.jsonl');
    assert.ok((await reader.getSiblingBranchContextForThread('a.jsonl')).some(e => e.fileName === 'independent.jsonl'));
    const messages = [{ text: 'hello', role: 'assistant' }, { text: 'same', role: 'user' }];
    assert.equal(reader.computeBranchPoint(messages, [messages[0], { text: 'same', role: 'assistant' }]), 1);
    assert.equal(reader.computeBranchPoint(messages, [{ text: 'hello', role: 'user' }, messages[1]]), null);
});

for (const change of ['metadata signature', 'dirty event']) {
    test(`hydration retries an older same-timestamp body after a ${change}`, async () => {
        setup(); await reader.buildIndex();
        const fetch = globalThis.fetch;
        let release, started;
        const hold = new Promise(resolve => { release = resolve; });
        const pending = new Promise(resolve => { started = resolve; });
        let first = true;
        globalThis.fetch = async (url, options) => {
            const response = await fetch(url, options);
            if (url !== '/api/chats/get' || !first) return response;
            first = false;
            const oldBody = await response.json();
            started(); await hold;
            return { ...response, json: async () => oldBody };
        };
        const load = reader.loadEntryNow('a.jsonl'); await pending;
        bodies.get('a.jsonl')[1].mes = 'newer saved content';
        if (change === 'metadata signature') { rows[0].file_size = '200 B'; await reader.buildIndex(); }
        else reader.markChatDirty('a.jsonl');
        release(); assert.equal(await load, true);
        assert.equal(contentRequests, 2, 'obsolete body is discarded and fetched again');
        assert.equal(reader.getIndex()['a.jsonl'].messages[0].text, 'newer saved content');
    });
}

test('explicit local thread deletion removes search content immediately', async () => {
    setup(); await reader.buildIndex(); await reader.loadEntryNow('a.jsonl');
    reader.getSearchableMessages();
    assert.equal(reader.removeChatFromIndex('a'), true);
    assert.deepEqual(reader.getSearchableMessages(), []);
    assert.equal(reader.removeChatFromIndex('a'), false);
});

test('a blocked legacy-cache upgrade falls back instead of hanging hydration', async () => {
    const indexedDB = globalThis.indexedDB;
    globalThis.indexedDB = { open() { const request = {}; queueMicrotask(() => request.onblocked?.()); return request; } };
    try {
        const isolatedCache = await import('../src/cache-store.js?blocked-upgrade');
        assert.equal((await isolatedCache.getCachedSummaries('test.png')).size, 0);
    } finally { globalThis.indexedDB = indexedDB; }
});

test('malformed successful HTTP responses cannot replace known-good bodies', async () => {
    setup(); await reader.buildIndex(); await reader.loadEntryNow('a.jsonl');
    const known = reader.getIndex()['a.jsonl'].messages;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ error: 'not a chat array' }) });
    await reader.buildIndex(); assert.equal(reader.getIndex()['a.jsonl'].messages, known);
    reader.markChatDirty('a.jsonl'); assert.equal(await reader.loadEntryNow('a.jsonl'), false);
    assert.equal(reader.getIndex()['a.jsonl'].messages, known);
});


test('cold indexing seeds only the identified active chat from current live messages', async () => {
    setup(['a.jsonl', 'b.jsonl']);
    context.chatId = 'a'; context.chat = [raw('unsaved live text')];
    await reader.buildIndex();
    const active = reader.getIndex()['a.jsonl'];
    assert.equal(active.isLoaded, true); assert.equal(active.needsHydration, false);
    assert.equal(active.messages[0].index, 0);
    assert.equal(active.messages[0].text, 'unsaved live text');
    assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    assert.equal(contentRequests, 0, 'the live chat needs no duplicate disk hydration');
    assert.equal(reader.getIndex()['b.jsonl'].isLoaded, false);
});

test('background hydration prioritizes requested files and bounds concurrent chat reads', async () => {
    setup(Array.from({ length: 25 }, (_, i) => `chat${i}.jsonl`));
    context.chatId = 'chat24';
    const originalFetch = globalThis.fetch;
    const started = [], release = [];
    let active = 0, peak = 0;
    globalThis.fetch = async (url, options) => {
        if (url === '/api/characters/chats') return originalFetch(url, options);
        started.push(`${JSON.parse(options.body).file_name}.jsonl`);
        peak = Math.max(peak, ++active);
        await new Promise(resolve => release.push(resolve));
        try { return await originalFetch(url, options); } finally { active--; }
    };
    await reader.buildIndex();
    reader.prioritizeHydrationFiles(['chat20.jsonl', 'chat19.jsonl', 'chat20.jsonl']);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(started.slice(0, 2), ['chat20.jsonl', 'chat19.jsonl']);
    assert.equal(peak, 2, 'large archive bodies are parsed at most two at a time');
    reader.clearIndex(); release.forEach(resolve => resolve());
    await new Promise(resolve => setImmediate(resolve));
});
