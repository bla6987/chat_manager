import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const fake = installFakeIndexedDB();
const cache = await import('../src/cache-store.js');
const { encodeDescriptors, decodeDescriptors, forEachSummarizedVariant, indexChatData, indexChatText, iterateActivity } = await import('../src/chat-index-data.js');
const { createMessageDescriptors } = await import('../src/message-descriptors.js');

const entry = (extra = {}) => ({ lastModified: 1, serverSignature: 'sig', validatedAt: 2, messageCount: 1, bodyBytes: 100, ...extra });
const body = text => [{ index: 0, role: 'assistant', text }];
const flush = () => cache.flushPendingCacheWrites();

afterEach(async () => {
    await flush();
    cache.setBodyStoreBudget(cache.DEFAULT_BODY_STORE_BYTES);
    for (const name of ['chatSummaries', 'chatDescriptors', 'chatBodies', 'chatBodyLedger']) {
        for (const key of fake.store(name).keys()) await cache.removeCachedChat(...key.split(':'));
    }
    await flush();
    fake.reset();
});

test('the upgrade drops the older uncapped stores and creates the new ones', async () => {
    await cache.getCachedSummaries('a.png');
    assert.deepEqual(fake.requestedVersions, [4]);
    assert.deepEqual([...fake.stores.keys()].sort(), ['chatBodies', 'chatBodyLedger', 'chatDescriptors', 'chatSummaries']);
});

test('summaries for one character come from a single read and exclude others', async () => {
    await cache.putCachedChats('a.png', Array.from({ length: 120 }, (_, i) => ({ fileName: `${i}.jsonl`, entry: entry() })));
    await cache.putCachedChat('b.png', 'other.jsonl', entry());
    await flush();
    fake.transactions = [];
    const summaries = await cache.getCachedSummaries('a.png');
    assert.equal(summaries.size, 120);
    assert.equal(summaries.has('other.jsonl'), false);
    assert.equal(fake.transactions.length, 1);
});

test('records from another format version are ignored', async () => {
    await cache.getCachedSummaries('a.png');
    fake.store('chatSummaries').set('a.png:old.jsonl', { key: 'a.png:old.jsonl', avatar: 'a.png', fileName: 'old.jsonl', cacheFormatVersion: 2 });
    fake.store('chatBodies').set('a.png:old.jsonl', { key: 'a.png:old.jsonl', cacheFormatVersion: 2, messages: [] });
    assert.equal((await cache.getCachedSummaries('a.png')).size, 0);
    assert.equal(await cache.getCachedBody('a.png', 'old.jsonl'), null);
    fake.store('chatSummaries').clear(); fake.store('chatBodies').clear();
});

test('batched writes share one transaction, and an empty batch touches nothing', async () => {
    await flush();
    const before = fake.writeTransactions;
    await cache.putCachedChats('a.png', [{ fileName: 'a.jsonl', entry: entry() }, { fileName: 'b.jsonl', entry: entry() }]);
    assert.equal(fake.writeTransactions - before, 1);
    assert.equal(await cache.putCachedChats('a.png', []), true);
    assert.equal(fake.writeTransactions - before, 1);
});

test('a body write keeps a same-turn summary update from discarding it', async () => {
    const withBody = cache.putCachedChat('a.png', 'a.jsonl', entry(), { body: body('text') });
    const summaryOnly = cache.putCachedChat('a.png', 'a.jsonl', entry({ messageCount: 9 }));
    await Promise.all([withBody, summaryOnly]);
    assert.equal(fake.store('chatSummaries').get('a.png:a.jsonl').messageCount, 9);
    assert.equal((await cache.getCachedBody('a.png', 'a.jsonl')).messages[0].text, 'text');
});

test('removing a chat clears all of its records and its space', async () => {
    await cache.putCachedChat('a.png', 'a.jsonl', entry(), { body: body('text'), descriptorsPayload: '[]' });
    assert.equal(cache.getBodyStoreStats().storedBytes, 100);
    await cache.removeCachedChat('a.png', 'a.jsonl');
    for (const name of ['chatSummaries', 'chatDescriptors', 'chatBodies', 'chatBodyLedger']) assert.equal(fake.store(name).size, 0, name);
    assert.equal(cache.getBodyStoreStats().storedBytes, 0);
});

test('a single read displaces the least recently used bodies to stay under the cap', async () => {
    cache.setBodyStoreBudget(250);
    await cache.putCachedChat('a.png', 'old.jsonl', entry(), { body: body('old') });
    await cache.putCachedChat('a.png', 'mid.jsonl', entry(), { body: body('mid') });
    const ledger = fake.store('chatBodyLedger');
    ledger.get('a.png:old.jsonl').usedAt = 1;
    await cache.getCachedBody('a.png', 'mid.jsonl');
    await cache.putCachedChat('a.png', 'new.jsonl', entry(), { body: body('new') });
    assert.equal(fake.store('chatBodies').size, 2);
    assert.ok(cache.getBodyStoreStats().storedBytes <= 250);
    assert.ok(fake.store('chatBodies').has('a.png:new.jsonl'));
    assert.ok(fake.store('chatBodies').has('a.png:mid.jsonl'), 'a recently read body survives');
});

test('an archive scan fills free space and never evicts', async () => {
    cache.setBodyStoreBudget(250);
    await cache.putCachedChat('a.png', 'kept.jsonl', entry(), { body: body('kept') });
    await cache.putCachedBody('a.png', 'scan1.jsonl', entry(), body('s1'), { evictBodies: false });
    await cache.putCachedBody('a.png', 'scan2.jsonl', entry(), body('s2'), { evictBodies: false });
    assert.deepEqual([...fake.store('chatBodies').keys()].sort(), ['a.png:kept.jsonl', 'a.png:scan1.jsonl']);
});

test('a body larger than the whole cap is not stored', async () => {
    cache.setBodyStoreBudget(50);
    await cache.putCachedChat('a.png', 'huge.jsonl', entry(), { body: body('huge') });
    assert.equal(fake.store('chatBodies').size, 0);
    assert.ok(fake.store('chatSummaries').has('a.png:huge.jsonl'), 'its summary is still kept');
});

test('rewriting a body replaces its size instead of adding to it', async () => {
    await cache.putCachedChat('a.png', 'a.jsonl', entry({ bodyBytes: 100 }), { body: body('one') });
    await cache.putCachedChat('a.png', 'a.jsonl', entry({ bodyBytes: 40 }), { body: body('two') });
    assert.equal(cache.getBodyStoreStats().storedBytes, 40);
});

const message = (index, text, extra = {}) => ({ filename: 'f.jsonl', index, role: index % 2 ? 'assistant' : 'user', text, timestamp: '2026-01-01T00:00:00Z', timestampMs: 1767225600000, branches: [], swipeId: 0, ...extra });

test('descriptors survive the compact stored form exactly', () => {
    const messages = [
        message(0, 'plain'),
        message(1, '  needs   normalizing ', { swipes: ['first', '  needs   normalizing ', ''], swipeId: 1, branches: ['b.jsonl'] }),
        message(3, '', { timestamp: '', timestampMs: undefined }),
    ];
    const descriptors = createMessageDescriptors(messages);
    assert.deepEqual(decodeDescriptors(encodeDescriptors(descriptors), 'f.jsonl'), descriptors);
});

test('the stored form is much smaller than the descriptors it replaces', () => {
    const descriptors = createMessageDescriptors(Array.from({ length: 50 }, (_, i) => message(i, 'word '.repeat(180))));
    assert.ok(encodeDescriptors(descriptors).length < JSON.stringify(descriptors).length * 0.6);
});

test('a chat summary answers what the views ask without any message records', () => {
    const raw = [{ chat_metadata: { main_chat: 'parent' } },
        { mes: 'hi', is_user: true, send_date: '2026-01-01T00:00:00Z' },
        { mes: 'one', swipes: ['zero', 'one', ''], swipe_id: 1, is_user: false, send_date: '2026-01-01T00:20:00Z', extra: { branches: ['child'] } },
        { mes: '', is_user: true, send_date: '2026-01-02T00:00:00Z' }];
    const { summary } = indexChatData(raw, 'f.jsonl');
    assert.equal(summary.messageCount, 3);
    assert.equal(summary.userMessageCount, 2);
    assert.equal(summary.mainChat, 'parent.jsonl');
    assert.deepEqual(summary.branchTargets, ['child.jsonl']);
    assert.equal(summary.firstMessageTimestamp, '2026-01-01T00:00:00Z');
    assert.deepEqual([...iterateActivity(summary.activity)].reduce((sum, [, count]) => sum + count, 0), 3);
    assert.equal(summary.bodyEmbeddingText, 'hi\none');
    const visits = [];
    forEachSummarizedVariant(summary, { includeAlternates: true, maxSwipes: 8 }, (index, swipe, active) => { visits.push([index, swipe, active]); });
    assert.deepEqual(visits, [[0, 0, 0], [1, 1, 1], [1, 0, 1]], 'empty text is not embeddable');
    const activeOnly = [];
    forEachSummarizedVariant(summary, {}, (index, swipe) => { activeOnly.push([index, swipe]); });
    assert.deepEqual(activeOnly, [[0, 0], [1, 1]]);
});

test('the content hash changes with every field a chat comparison depends on', () => {
    const hash = rows => indexChatData([{}, ...rows], 'f.jsonl').summary.contentHash;
    const row = { mes: 'a', swipes: ['a', 'b'], swipe_id: 0, is_user: false, send_date: 'd', extra: { branches: ['x'] } };
    const base = hash([row]);
    assert.equal(hash([{ ...row }]), base);
    for (const change of [{ mes: 'z' }, { is_user: true }, { send_date: 'e' }, { swipes: ['a', 'c'] }, { swipe_id: 1, mes: 'b' }, { extra: { branches: ['y'] } }]) {
        assert.notEqual(hash([{ ...row, ...change }]), base, JSON.stringify(change));
    }
});

test('the worker entry point rejects a malformed response', () => {
    assert.throws(() => indexChatText('{"error":true}', 'f.jsonl'), /Invalid chat content/);
    assert.throws(() => indexChatText('not json', 'f.jsonl'));
    const { summary, descriptorsPayload } = indexChatText(JSON.stringify([{}, { mes: 'x', send_date: 'd' }]), 'f.jsonl');
    assert.equal(summary.messageCount, 1);
    assert.equal(decodeDescriptors(descriptorsPayload, 'f.jsonl')[0].preview, 'x');
});
