import test from 'node:test';
import assert from 'node:assert/strict';

let writeTransactions = 0;
let holdReadTransactions = false;
let heldReadTransactions = [];
let readTransactionSizes = [];
let readStartedResolve = null;

function nextReadStarted() {
    return new Promise(resolve => { readStartedResolve = resolve; });
}

function releaseHeldReads() {
    const releases = heldReadTransactions;
    heldReadTransactions = [];
    for (const release of releases) release();
}

globalThis.indexedDB = {
    open() {
        const request = {};
        queueMicrotask(() => {
            const database = {
                objectStoreNames: { contains: () => true },
                transaction(_name, mode) {
                    if (mode === 'readwrite') writeTransactions++;
                    let reads = 0;
                    const tx = {
                        objectStore() {
                            return {
                                get() {
                                    reads++;
                                    const getRequest = {};
                                    queueMicrotask(() => {
                                        getRequest.result = undefined;
                                        getRequest.onsuccess?.();
                                    });
                                    return getRequest;
                                },
                                put() {},
                                delete() {},
                            };
                        },
                    };
                    const complete = () => {
                        if (mode === 'readonly') readTransactionSizes.push(reads);
                        tx.oncomplete?.();
                    };
                    if (mode === 'readonly' && holdReadTransactions) {
                        heldReadTransactions.push(complete);
                        readStartedResolve?.();
                        readStartedResolve = null;
                    } else {
                        queueMicrotask(complete);
                    }
                    return tx;
                },
            };
            request.result = database;
            request.onsuccess?.({ target: { result: database } });
        });
        return request;
    },
};

const reader = await import('../src/chat-reader.js');
const cache = await import('../src/cache-store.js');

function raw(text, { user = false, timestamp = '2026-01-01T00:00:00Z', swipes = [text], swipe = 0 } = {}) {
    return { mes: text, is_user: user, send_date: timestamp, swipes, swipe_id: swipe };
}

function parsed(index, text, options = {}) {
    return {
        filename: 'active.jsonl', index, role: options.user ? 'user' : 'assistant', text,
        timestamp: options.timestamp || '2026-01-01T00:00:00Z',
        swipes: options.swipes || [text], swipeId: options.swipe || 0,
    };
}

function setupActive(messages) {
    reader.clearIndex();
    const context = {
        characterId: 0, characters: [{ avatar: 'test.png', name: 'Test' }], chat: messages,
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    reader.getIndex()['active.jsonl'] = {
        fileName: 'active.jsonl', lastModified: 1, messageCount: messages.length,
        messages: messages.map((message, index) => parsed(index, message.mes, {
            user: message.is_user, timestamp: message.send_date, swipes: [...message.swipes], swipe: message.swipe_id,
        })),
        firstMessageTimestamp: messages[0]?.send_date || null,
        lastMessageTimestamp: messages.at(-1)?.send_date || null,
        sortTimestamp: 1, initialOrder: 0, branchPoint: null, isLoaded: true,
        chatEmbedding: null, chatEmbeddingHash: null, clusterLabel: null, messageEmbeddings: null,
    };
    return context;
}

test('unchanged active updates preserve entry identity and version while all indexed changes invalidate', async () => {
    const context = setupActive([
        raw('first', { user: true }),
        raw('active', { swipes: ['alternate', 'active'], swipe: 1 }),
    ]);
    const entry = reader.getIndex()['active.jsonl'];
    const version = reader.getIndexVersion();
    const writes = writeTransactions;
    let notifications = 0;
    const unsubscribe = reader.onHydrationUpdate(() => notifications++);
    assert.equal(await reader.updateActiveChat('active.jsonl'), false);
    assert.equal(reader.getIndex()['active.jsonl'], entry);
    assert.equal(reader.getIndexVersion(), version);
    assert.equal(writeTransactions, writes);
    assert.equal(notifications, 0);
    unsubscribe();

    context.chat[0] = raw('first', { user: false });
    assert.equal(await reader.updateActiveChat('active.jsonl'), true, 'role changes are indexed');
    context.chat[1] = raw('active', { swipes: ['changed alternate', 'active'], swipe: 1 });
    assert.equal(await reader.updateActiveChat('active.jsonl'), true, 'inactive swipe changes are indexed');
    context.chat[1] = raw('changed alternate', { swipes: ['changed alternate', 'active'], swipe: 0 });
    assert.equal(await reader.updateActiveChat('active.jsonl'), true, 'active swipe changes are indexed');
});

test('branch comparisons are reused while message array identities are unchanged', () => {
    let reads = 0;
    const tracked = text => ({ get text() { reads++; return text; } });
    const base = [tracked('same'), tracked('same 2'), tracked('base')];
    const candidate = [tracked('same'), tracked('same 2'), tracked('branch')];
    assert.equal(reader.computeBranchPoint(base, candidate), 2);
    const firstReads = reads;
    assert.equal(reader.computeBranchPoint(base, candidate), 2);
    assert.equal(reads, firstReads, 'cached comparison performs no message text reads');
    assert.equal(reader.computeBranchPoint(base, [...candidate]), 2, 'a replacement array invalidates the cache');
    assert.ok(reads > firstReads);
});

test('cache batch writes share one IndexedDB transaction', async () => {
    const before = writeTransactions;
    cache.putCachedChats('test.png', [
        { fileName: 'a.jsonl', entry: { messages: [] } },
        { fileName: 'b.jsonl', entry: { messages: [] } },
    ]);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writeTransactions - before, 1);
});

test('cache reads use transactions of at most 50 records', async () => {
    readTransactionSizes = [];
    await cache.getCachedChatsForCharacter('test.png', Array.from({ length: 121 }, (_, i) => `${i}.jsonl`));
    assert.deepEqual(readTransactionSizes, [50, 50, 21]);
});

test('cold metadata is published before delayed cached bodies finish reading', async () => {
    reader.clearIndex();
    holdReadTransactions = true;
    const readStarted = nextReadStarted();
    const context = {
        characterId: 0, characters: [{ avatar: 'cold.png', name: 'Cold' }], chat: [],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async url => ({
        ok: true,
        async json() {
            return url.includes('/api/characters/chats')
                ? [[{ file_name: 'cold.jsonl', last_mes: '2026-01-01T00:00:00Z', mes_count: 12 }]]
                : [];
        },
    });
    let metadataReady = false;
    const build = reader.buildIndex(null, state => {
        metadataReady = true;
        assert.equal(state.index['cold.jsonl'].messageCount, 12);
        assert.equal(state.index['cold.jsonl'].isLoaded, false);
    });
    await readStarted;
    assert.equal(metadataReady, true);
    releaseHeldReads();
    await build;
    holdReadTransactions = false;
});

test('active update that lands during a cache read wins over the older build', async () => {
    reader.clearIndex();
    holdReadTransactions = true;
    const readStarted = nextReadStarted();
    const context = {
        characterId: 0, characters: [{ avatar: 'race.png', name: 'Race' }], chat: [raw('new live text')],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async url => ({ ok: true, async json() {
        return url.includes('/api/characters/chats')
            ? [[{ file_name: 'race.jsonl', last_mes: '2026-01-01T00:00:00Z', mes_count: 1 }]] : [];
    } });
    const build = reader.buildIndex();
    await readStarted;
    assert.equal(await reader.updateActiveChat('race.jsonl'), true);
    const liveEntry = reader.getIndex()['race.jsonl'];
    releaseHeldReads();
    await build;
    assert.equal(reader.getIndex()['race.jsonl'], liveEntry);
    assert.equal(liveEntry.messages[0].text, 'new live text');
    holdReadTransactions = false;
});

test('an entry replaced during a cache read is not deleted by an older server list', async () => {
    reader.clearIndex();
    const context = {
        characterId: 0, characters: [{ avatar: 'delete-race.png', name: 'Race' }], chat: [raw('before')],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, async json() { return []; } });
    await reader.buildIndex();
    reader.getIndex()['active.jsonl'] = {
        fileName: 'active.jsonl', lastModified: 1, messageCount: 1,
        messages: [parsed(0, 'before')], firstMessageTimestamp: '2026-01-01T00:00:00Z',
        lastMessageTimestamp: '2026-01-01T00:00:00Z', sortTimestamp: 1,
        initialOrder: 0, branchPoint: null, isLoaded: true,
        chatEmbedding: null, chatEmbeddingHash: null, clusterLabel: null, messageEmbeddings: null,
    };
    reader.getIndex()['pending.jsonl'] = {
        fileName: 'pending.jsonl', lastModified: 1, messageCount: 0, messages: [],
        initialOrder: 1, branchPoint: null, isLoaded: false,
    };
    globalThis.fetch = async url => ({ ok: true, async json() {
        return url.includes('/api/characters/chats')
            ? [[{ file_name: 'pending.jsonl', last_mes: '2026-01-01T00:00:00Z', mes_count: 1 }]] : [];
    } });

    holdReadTransactions = true;
    const readStarted = nextReadStarted();
    const build = reader.buildIndex();
    await readStarted;
    context.chat = [raw('after')];
    assert.equal(await reader.updateActiveChat('active.jsonl'), true);
    const replacement = reader.getIndex()['active.jsonl'];
    releaseHeldReads();
    await build;
    assert.equal(reader.getIndex()['active.jsonl'], replacement);
    holdReadTransactions = false;
});

test('a reset and newer character build win while an older cache read is pending', async () => {
    reader.clearIndex();
    holdReadTransactions = true;
    const oldReadStarted = nextReadStarted();
    let context = {
        characterId: 0, characters: [{ avatar: 'old.png', name: 'Old' }], chat: [],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    let releaseNewList;
    const newList = new Promise(resolve => { releaseNewList = resolve; });
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async url => ({ ok: true, async json() {
        if (!url.includes('/api/characters/chats')) return [];
        const name = context.characters[0].name.toLowerCase();
        if (name === 'new') await newList;
        return [[{ file_name: `${name}.jsonl`, last_mes: '2026-01-01T00:00:00Z', mes_count: 1 }]];
    } });
    const oldBuild = reader.buildIndex();
    await oldReadStarted;
    reader.clearIndex();
    context = {
        ...context,
        characters: [{ avatar: 'new.png', name: 'New' }],
    };
    holdReadTransactions = false;
    const newBuild = reader.buildIndex();
    releaseHeldReads();
    await oldBuild;
    assert.equal(reader.isBuilding(), true, 'the old build does not clear the newer build flag');
    releaseNewList();
    await newBuild;
    assert.equal(reader.getIndexCharacterAvatar(), 'new.png');
    assert.ok(reader.getIndex()['new.jsonl']);
    assert.equal(reader.getIndex()['old.jsonl'], undefined);
});

test('an internal character switch retains build ownership across a delayed list fetch', async () => {
    reader.clearIndex();
    let context = {
        characterId: 0, characters: [{ avatar: 'first.png', name: 'First' }], chat: [],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, async json() { return []; } });
    await reader.buildIndex();

    let releaseList;
    const delayedList = new Promise(resolve => { releaseList = resolve; });
    let markListStarted;
    const listStarted = new Promise(resolve => { markListStarted = resolve; });
    context = { ...context, characters: [{ avatar: 'second.png', name: 'Second' }] };
    globalThis.fetch = async () => ({ ok: true, async json() { markListStarted(); await delayedList; return []; } });
    const switchingBuild = reader.buildIndex();
    await listStarted;
    const overlapping = await reader.buildIndex();
    assert.equal(overlapping.buildInProgress, true);
    releaseList();
    await switchingBuild;
    assert.equal(reader.getIndexCharacterAvatar(), 'second.png');
});

test('empty chat lists release build ownership for the next build', async () => {
    reader.clearIndex();
    const context = {
        characterId: 0, characters: [{ avatar: 'empty.png', name: 'Empty' }], chat: [],
        extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}),
    };
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async () => ({ ok: true, async json() { return []; } });
    assert.equal((await reader.buildIndex()).buildInProgress, false);
    assert.equal(reader.isBuilding(), false);
    assert.equal((await reader.buildIndex()).buildInProgress, false);
    assert.equal(reader.isBuilding(), false);
});
