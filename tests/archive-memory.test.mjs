import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const fake = installFakeIndexedDB();
const reader = await import('../src/chat-reader.js');
const cache = await import('../src/cache-store.js');
const { messageFingerprint, normalizedMessageFingerprint, sameMessageContent, createMessageDescriptor } = await import('../src/message-descriptors.js');
let context;
let rows;
let bodies;
let contentReads;
const date = '2026-10-25T12:00:00Z';
const raw = (text, swipes = [text]) => ({ mes: text, swipes, swipe_id: 0, is_user: false, send_date: date });

async function until(predicate) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for archive work');
        await new Promise(resolve => setTimeout(resolve, 2));
    }
}

async function setup(count = 4) {
    reader.clearIndex(); await cache.flushPendingCacheWrites(); fake.reset(); contentReads = 0;
    reader.setBodyCacheBudget(30_000); reader.setVectorCacheBudget(reader.DEFAULT_VECTOR_CACHE_BYTES);
    context = {
        characterId: 0, characters: [{ avatar: 'memory.png', name: 'Memory' }],
        chat: [], chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    rows = Array.from({ length: count }, (_, i) => ({ file_name: `chat${i}.jsonl`, last_mes: date, chat_items: 2, file_size: '40 KB' }));
    bodies = new Map(rows.map((row, i) => {
        const text = `${i} active ` + 'x'.repeat(1800);
        return [row.file_name, [{ chat_metadata: {} }, raw(`greeting ${i}`), raw(text, [text, `${i} alternative ` + 'y'.repeat(1800), `${i} third ` + 'z'.repeat(1800)])]];
    }));
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        if (url === '/api/characters/chats') return { ok: true, json: async () => structuredClone(rows) };
        contentReads++;
        const name = `${JSON.parse(options.body).file_name}.jsonl`;
        return { ok: true, json: async () => structuredClone(bodies.get(name)) };
    };
}

afterEach(async () => {
    fake.holdWrites = false; fake.release();
    reader.clearIndex(); await cache.flushPendingCacheWrites();
    reader.setBodyCacheBudget(reader.DEFAULT_BODY_CACHE_BYTES);
    reader.setVectorCacheBudget(reader.DEFAULT_VECTOR_CACHE_BYTES);
    cache.setBodyStoreBudget(cache.DEFAULT_BODY_STORE_BYTES);
    fake.unavailable = false;
});

test('background indexing keeps only summaries and full iteration preserves every swipe', async () => {
    await setup(8); await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    const stats = reader.getBodyCacheStats();
    assert.equal(stats.residentChats, 0, 'nothing asked for a body');
    assert.equal(Object.keys(reader.getIndex()).length, 8);
    for (const entry of Object.values(reader.getIndex())) {
        assert.equal(entry.isLoaded, true, 'indexed completion does not depend on residency');
        assert.deepEqual(entry.messages, []);
        assert.equal(entry.bodyResident, false);
        assert.equal(entry.messageCount, 2);
        assert.equal(entry.userMessageCount, 0);
        assert.ok(entry.lastMessagePreview.length <= 240);
        const stored = await reader.readChatDescriptors(entry.fileName);
        assert.ok(stored.every(message => message.isDescriptor && message.text === '' && !message.swipes));
        assert.equal(stored[1].swipeCount, 3);
        assert.ok(stored[1].preview.length <= 160);
    }
    assert.equal(fake.store('chatBodies').size, 0, 'background indexing stores no complete text');
    let chats = 0, variants = 0;
    for await (const { entry, messages } of reader.iterateChatBodies()) {
        assert.equal(messages[1].text, bodies.get(entry.fileName)[2].mes);
        assert.deepEqual(messages[1].swipes, bodies.get(entry.fileName)[2].swipes);
        chats++; variants += messages[1].swipes.length;
    }
    assert.equal(chats, 8); assert.equal(variants, 24);
    assert.equal(reader.getBodyCacheStats().residentBytes, 0, 'cold reads stay ephemeral');
});

test('foreground reads stay within the resident body budget', async () => {
    await setup(8); await reader.buildIndex();
    for (const row of rows) await reader.loadEntryNow(row.file_name);
    const stats = reader.getBodyCacheStats();
    assert.ok(stats.residentBytes <= stats.budgetBytes);
    assert.ok(stats.residentChats < 8);
    for (const entry of Object.values(reader.getIndex()).filter(item => !item.bodyResident)) {
        assert.deepEqual(entry.messages, [], 'an evicted body leaves no per-message records behind');
    }
});

test('a restore reads one record per character and full bodies only on demand', async () => {
    await setup(3); await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    await cache.flushPendingCacheWrites(); reader.clearIndex(); contentReads = 0;
    const reads = [];
    fake.onRead = (store, key) => reads.push([store, key]);
    await reader.buildIndex();
    assert.deepEqual(reads, [['chatSummaries', 'memory.png']]);
    assert.equal(reader.isHydrationComplete(), true);
    assert.equal(reader.getBodyCacheStats().residentChats, 0);
    assert.equal(contentReads, 0);
    const version = reader.getIndexVersion();
    const entry = reader.getIndex()['chat0.jsonl'];
    const messages = await reader.readChatMessages('chat0.jsonl');
    assert.equal(messages[1].text, bodies.get('chat0.jsonl')[2].mes);
    assert.equal(contentReads, 1, 'an unstored body comes from the server');
    assert.equal(reader.getIndex()['chat0.jsonl'], entry);
    assert.equal(reader.getIndexVersion(), version, 'read-only residency does not change the search revision');
    assert.equal(entry.bodyResident, false);
    await reader.readChatMessages('chat0.jsonl');
    assert.equal(contentReads, 1, 'the second read comes from the stored copy');
});

test('stored descriptors match freshly computed ones after a restore', async () => {
    await setup(2); await reader.buildIndex(); await reader.loadEntryNow('chat0.jsonl');
    const fresh = reader.getIndex()['chat0.jsonl'].messageDescriptors.map(item => ({ ...item, branches: [...item.branches] }));
    await cache.flushPendingCacheWrites(); reader.clearIndex(); contentReads = 0;
    await reader.buildIndex();
    assert.deepEqual(await reader.readChatDescriptors('chat0.jsonl'), fresh);
    assert.equal(contentReads, 0);
});

test('blocked IndexedDB still permits eviction and complete authoritative reads', async () => {
    await setup(4); fake.unavailable = true; reader.setBodyCacheBudget(0);
    await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    assert.equal(reader.getBodyCacheStats().residentBytes, 0);
    let count = 0;
    for await (const { messages } of reader.iterateChatBodies()) {
        assert.equal(messages[1].swipes.length, 3); count++;
    }
    assert.equal(count, 4);
    assert.equal(reader.getBodyCacheStats().residentBytes, 0);
});

test('unsaved active body is pinned even when one chat exceeds the budget', async () => {
    await setup(3); reader.setBodyCacheBudget(0);
    context.chatId = 'chat0'; context.chat = bodies.get('chat0.jsonl').slice(1);
    context.chat[1] = raw('UNSAVED newest text', ['UNSAVED newest text', 'alternate']);
    await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    reader.trimBodyCache({ targetBytes: 0 });
    const stats = reader.getBodyCacheStats();
    assert.equal(stats.residentChats, 1); assert.equal(stats.residentBytes, stats.pinnedBytes);
    assert.equal((await reader.readChatMessages('chat0.jsonl'))[1].text, 'UNSAVED newest text');
    assert.equal(reader.getIndex()['chat1.jsonl'].bodyResident, false);
});

test('an archive iterator rejects a character change and explicit cancellation', async () => {
    await setup(3); await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    const iterator = reader.iterateChatBodies();
    assert.equal((await iterator.next()).done, false);
    reader.clearIndex(); context.characters = [{ avatar: 'other.png', name: 'Other' }];
    await assert.rejects(iterator.next(), error => error.name === 'AbortError');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(reader.readChatMessages('chat0.jsonl', { signal: controller.signal }), error => error.name === 'AbortError');
});

test('a newer live edit wins over an older ephemeral server read', async () => {
    await setup(1); reader.setBodyCacheBudget(0); fake.unavailable = true;
    await reader.buildIndex(); await until(() => reader.isHydrationComplete());
    const originalFetch = globalThis.fetch;
    let release, started;
    const hold = new Promise(resolve => { release = resolve; });
    const reading = new Promise(resolve => { started = resolve; });
    globalThis.fetch = async (url, options) => {
        const response = await originalFetch(url, options);
        const oldBody = await response.json();
        started(); await hold;
        return { ...response, json: async () => oldBody };
    };
    const pending = reader.readChatMessages('chat0.jsonl');
    await reading;
    context.chat = [raw('newer unsaved edit')]; context.chatId = 'chat0';
    await reader.updateActiveChat('chat0.jsonl');
    release();
    assert.equal((await pending)[0].text, 'newer unsaved edit');
    globalThis.fetch = originalFetch;
});

test('failed revalidation preserves known data but rejects explicit full-body consumers', async () => {
    await setup(1); await reader.buildIndex(); await reader.loadEntryNow('chat0.jsonl');
    const before = reader.getIndex()['chat0.jsonl'].messages;
    reader.markChatDirty('chat0.jsonl');
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(reader.readChatMessages('chat0.jsonl'), /Could not refresh chat/);
    assert.equal(reader.getIndex()['chat0.jsonl'].messages, before);
    assert.equal(reader.getIndex()['chat0.jsonl'].needsHydration, true);
});

test('compact fingerprints preserve exact/normalized distinctions and branch comparisons', async () => {
    await setup();
    const full = { index: 0, role: 'assistant', text: 'hello   world', swipes: ['hello   world'], swipeId: 0 };
    const descriptor = createMessageDescriptor(full);
    const normalized = { ...full, text: ' hello world ' };
    assert.equal(messageFingerprint(descriptor), messageFingerprint(full));
    assert.equal(normalizedMessageFingerprint(descriptor), normalizedMessageFingerprint(normalized));
    assert.notEqual(messageFingerprint(descriptor), messageFingerprint(normalized));
    assert.equal(sameMessageContent(descriptor, full), true);
    assert.equal(sameMessageContent(descriptor, { ...full, role: 'user' }), false);
    assert.equal(descriptor.wordCount, 2);
    assert.equal(reader.computeBranchPoint([descriptor, { ...descriptor, textHash: 'next' }], [full, { ...full, text: 'different' }]), 1);
});

test('coalesced cache writes keep the latest body and allow only one transaction in flight', async () => {
    await setup(); await cache.flushPendingCacheWrites();
    fake.puts = new Map(); fake.writeTransactions = 0; fake.activeWrites = 0; fake.peakWrites = 0;
    const entry = { messageCount: 1, bodyBytes: 100 };
    const body = text => [{ index: 0, role: 'assistant', text, swipes: [text], swipeId: 0 }];
    const write = text => cache.putCachedChat('memory.png', 'coalesce.jsonl', entry, { body: body(text) });
    await Promise.all([write('old'), write('new')]);
    assert.equal(fake.puts.get('chatBodies'), 1); assert.equal(fake.writeTransactions, 1);
    assert.equal((await cache.getCachedBody('memory.png', 'coalesce.jsonl')).messages[0].text, 'new');
    fake.holdWrites = true;
    const held = write('held');
    await until(() => fake.held.length > 0);
    const pending = write('latest');
    assert.equal(fake.activeWrites, 1);
    fake.holdWrites = false; fake.release();
    await Promise.all([held, pending]);
    assert.equal(fake.peakWrites, 1);
    assert.equal((await cache.getCachedBody('memory.png', 'coalesce.jsonl')).messages[0].text, 'latest');
});

test('message and chat vectors share a hard byte budget while disk-key metadata survives eviction', async () => {
    await setup(1); await reader.buildIndex(); await reader.loadEntryNow('chat0.jsonl');
    const entry = reader.getIndex()['chat0.jsonl']; reader.setVectorCacheBudget(16);
    assert.equal(reader.setMessageEmbedding(entry, 0, 0, [1, 0]), true);
    assert.equal(reader.setMessageEmbedding(entry, 1, 0, [0, 1]), true);
    assert.equal(reader.setChatEmbedding(entry, [0.5, 0.5], 'hash'), true);
    assert.equal(reader.getMessageEmbedding(entry, entry.messages[0]), null);
    assert.ok(entry.cachedMessageEmbeddingKeys.has('m:0:s:0'));
    assert.equal(entry.cachedChatEmbeddingHash, 'hash');
    assert.ok(reader.getVectorCacheStats().residentBytes <= 16);
    assert.equal(reader.setMessageEmbedding(entry, 1, 1, new Array(100).fill(0)), false);
    assert.equal(reader.getMessageEmbedding(entry, entry.messages[1], 1), null);
    reader.clearIndex(); assert.equal(reader.getVectorCacheStats().residentBytes, 0);
});

test('vector eviction follows the current entry after active-message replacement', async () => {
    await setup(1); await reader.buildIndex(); await reader.loadEntryNow('chat0.jsonl');
    let entry = reader.getIndex()['chat0.jsonl'];
    reader.setMessageEmbedding(entry, 0, 0, [1, 0]);
    reader.setMessageEmbedding(entry, 1, 0, [0, 1]);
    context.chat = bodies.get('chat0.jsonl').slice(1); context.chat.push(raw('appended'));
    await reader.updateActiveChat('chat0.jsonl'); entry = reader.getIndex()['chat0.jsonl'];
    assert.equal(entry.messageEmbeddings.size, 2);
    reader.setVectorCacheBudget(0);
    assert.equal(entry.messageEmbeddings.size, 0);
    assert.ok(entry.cachedMessageEmbeddingKeys.has('m:0:s:0'));
    assert.equal(reader.getVectorCacheStats().residentBytes, 0);
});
