import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

// clearIndex() models a page reload, because these records survive it.
const fake = installFakeIndexedDB({ schedule: setImmediate });
const reader = await import('../src/chat-reader.js');
const cache = await import('../src/cache-store.js');
const metadata = await import('../src/metadata-store.js');
const WEEK = 7 * 24 * 3_600_000;
const date = '2026-10-14T12:00:00Z';
const raw = mes => ({ mes, is_user: false, send_date: date });

let context, rows, bodies, gets, listRequests, listGate, failList;
function setup(names = ['a.jsonl', 'b.jsonl', 'c.jsonl']) {
    reader.clearIndex();
    fake.reset();
    gets = []; listRequests = 0; listGate = null; failList = false;
    context = { characterId: 0, characters: [{ avatar: 'alpha.png', name: 'Alpha' }, { avatar: 'beta.png', name: 'Beta' }], chat: [],
        chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    rows = names.map(file_name => ({ file_name, last_mes: date, chat_items: 2, file_size: '100 B' }));
    bodies = new Map(names.map(name => [name, [{ chat_metadata: {} }, raw('greeting'), raw(`${name} text`)]]));
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        if (url === '/api/characters/chats') {
            listRequests++;
            await listGate;
            return { ok: !failList, status: failList ? 500 : 200, json: async () => structuredClone(rows) };
        }
        const name = `${JSON.parse(options.body).file_name}.jsonl`;
        gets.push(name);
        return { ok: true, status: 200, json: async () => structuredClone(bodies.get(name)) };
    };
}
const idle = async () => {
    while (reader.isBuilding()) await new Promise(resolve => setTimeout(resolve, 2));
    await cache.flushPendingCacheWrites();
};
const buildAndSettle = async (options) => { await reader.buildIndex(null, null, options); await idle(); };
/** Index everything once, then forget it all as a page reload would. */
const reload = async () => { await buildAndSettle(); reader.clearIndex(); gets.length = 0; listRequests = 0; };
const text = async name => (await reader.readChatMessages(name))[1].text;

afterEach(async () => { await idle(); reader.clearIndex(); });

test('reopening never re-reads a chat whose metadata still matches, however old it is', async () => {
    setup(); await buildAndSettle();
    assert.equal(gets.length, 3); gets.length = 0;
    await buildAndSettle();
    for (const entry of Object.values(reader.getIndex())) entry.validatedAt -= WEEK;
    await buildAndSettle();
    assert.deepEqual(gets, []);
    assert.equal(reader.isHydrationComplete(), true);
});

test('a reload restores every chat from its summary without downloading a body', async () => {
    setup(); await reload();
    await buildAndSettle();
    assert.deepEqual(gets, []);
    assert.equal(listRequests, 1);
    const entries = Object.values(reader.getIndex());
    assert.equal(entries.length, 3);
    assert.ok(entries.every(entry => entry.isLoaded && !entry.needsHydration && entry.bodyResident === false));
    assert.equal(await text('a.jsonl'), 'a.jsonl text', 'complete text stays readable');
    assert.deepEqual(gets, ['a.jsonl'], 'background indexing stored no body, so the first read downloads it');
    gets.length = 0;
    assert.equal(await text('a.jsonl'), 'a.jsonl text');
    assert.deepEqual(gets, [], 'a body that was read is reused');
});

for (const [field, values] of [
    ['file_size', ['101 B', '102 B', '103 B']],
    ['chat_items', [3, 4, 5]],
    ['last_mes', ['2026-10-15T12:00:00Z', '2026-10-16T12:00:00Z', '2026-10-17T12:00:00Z']],
]) {
    test(`a changed ${field} re-reads only that chat, in a session and after a reload`, async () => {
        setup(); await buildAndSettle(); gets.length = 0;
        rows[1][field] = values[0];
        await buildAndSettle();
        assert.deepEqual(gets, ['b.jsonl']);
        rows[1][field] = values[1];
        await reload();
        rows[1][field] = values[2];
        await buildAndSettle();
        assert.deepEqual(gets, ['b.jsonl']);
    });
}

test('a same-size local edit made before the index loads is re-read after a reload', async () => {
    setup(); await reload();
    context.chatId = 'b';
    bodies.get('b.jsonl')[2].mes = 'B.JSONL TEXT';
    assert.equal(reader.recordLocalChatEdit(context), true);
    await cache.flushPendingCacheWrites();
    context.chatId = 'a';
    await buildAndSettle();
    assert.deepEqual(gets, ['b.jsonl']);
    assert.equal(await text('b.jsonl'), 'B.JSONL TEXT');
    gets.length = 0;
    reader.clearIndex(); await buildAndSettle();
    assert.deepEqual(gets, [], 'the re-read restores trust in that chat');
});

test('a same-size local edit in the loaded index invalidates it and survives a reload', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    context.chatId = 'b';
    bodies.get('b.jsonl')[2].mes = 'B.JSONL TEXT';
    reader.recordLocalChatEdit(context);
    assert.equal(reader.getIndex()['b.jsonl'].needsHydration, true);
    await cache.flushPendingCacheWrites();
    context.chatId = 'a';
    reader.clearIndex(); await buildAndSettle();
    assert.deepEqual(gets, ['b.jsonl']);
    assert.equal(await text('b.jsonl'), 'B.JSONL TEXT');
});

test('an edit under another character cannot invalidate a same-named chat in the index', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    const held = reader.getIndex()['a.jsonl'];
    context.characterId = 1; context.chatId = 'a';
    assert.equal(reader.recordLocalChatEdit(context), true);
    await cache.flushPendingCacheWrites();
    assert.equal(reader.getIndex()['a.jsonl'], held);
    assert.equal(held.needsHydration, false);
    assert.ok(fake.store('chatSummaries').has('alpha.png:a.jsonl'));
});

test('group chats and an empty selection record nothing', async () => {
    setup(); await buildAndSettle();
    const before = fake.store('chatSummaries').size;
    context.chatId = 'a';
    context.characterId = undefined;
    assert.equal(reader.recordLocalChatEdit(context), false);
    context.characterId = 0; context.chatId = undefined;
    assert.equal(reader.recordLocalChatEdit(context), false);
    await cache.flushPendingCacheWrites();
    assert.equal(fake.store('chatSummaries').size, before);
});

test('the open chat prefers live text, including over a file its save has not reached', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    context.chatId = 'a';
    context.chatMetadata = { main_chat: 'b' };
    context.chat = [raw('greeting'), raw('unsaved edit')];
    bodies.get('a.jsonl')[2].mes = 'a.jsonl text';
    reader.recordLocalChatEdit(context);
    assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    assert.deepEqual(gets, [], 'no server read can capture the pre-save file');
    assert.equal(reader.getIndex()['a.jsonl'].messages[1].text, 'unsaved edit');
    assert.equal(reader.getIndex()['a.jsonl'].mainChat, 'b.jsonl');
    await cache.flushPendingCacheWrites();
    // The host's save lands, then a reload finds the chat under its new summary.
    bodies.get('a.jsonl')[2].mes = 'unsaved edit';
    context.chat = []; context.chatId = 'b'; context.chatMetadata = {};
    reader.clearIndex(); await buildAndSettle();
    assert.equal(await text('a.jsonl'), 'unsaved edit');
});

test('a reload with the open chat unchanged reads neither it nor any other body', async () => {
    setup(); await reload();
    context.chatId = 'a';
    context.chat = [raw('greeting'), raw('a.jsonl text')];
    await buildAndSettle();
    assert.deepEqual(gets, []);
    assert.equal(reader.getIndex()['a.jsonl'].bodyResident, true, 'the live chat stays resident');
});

test('forced revalidation re-reads every chat and finds a same-size remote edit', async () => {
    setup(); await buildAndSettle();
    assert.equal(await text('c.jsonl'), 'c.jsonl text');
    await cache.flushPendingCacheWrites(); gets.length = 0;
    bodies.get('c.jsonl')[2].mes = 'C.JSONL TEXT';
    await buildAndSettle();
    assert.deepEqual(gets, []);
    assert.equal(await text('c.jsonl'), 'c.jsonl text', 'a remote same-size edit stays unseen until verified');
    await buildAndSettle({ forceRevalidate: true });
    assert.deepEqual(gets.toSorted(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
    assert.equal(await text('c.jsonl'), 'C.JSONL TEXT');
});

test('a forced request during a running build runs afterwards instead of being lost', async () => {
    setup(); await buildAndSettle(); gets.length = 0; listRequests = 0;
    let open;
    listGate = new Promise(resolve => { open = resolve; });
    const running = reader.buildIndex();
    const forced = await reader.buildIndex(null, null, { forceRevalidate: true });
    assert.equal(forced.buildInProgress, true);
    assert.equal(listRequests, 1);
    open(); listGate = null;
    await running; await idle();
    assert.equal(listRequests, 2);
    assert.deepEqual(gets.toSorted(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
});

test('builds without background hydration list chats but download nothing until asked', async () => {
    setup();
    await reader.buildIndex(null, null, { backgroundHydration: false }); await idle();
    assert.deepEqual(gets, []);
    assert.equal(Object.keys(reader.getIndex()).length, 3);
    assert.equal(reader.isBuilding(), false);
    assert.equal(reader.isHydrationComplete(), false);
    await buildAndSettle();
    assert.deepEqual(gets.toSorted(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
    assert.equal(reader.isHydrationComplete(), true);
});

test('builds without background hydration still restore summaries and the live chat', async () => {
    setup(); await reload();
    bodies.set('new.jsonl', [{ chat_metadata: {} }, raw('new')]);
    rows.push({ file_name: 'new.jsonl', last_mes: date, chat_items: 1, file_size: '50 B' });
    context.chatId = 'a'; context.chat = [raw('greeting'), raw('a.jsonl text')];
    await reader.buildIndex(null, null, { backgroundHydration: false }); await idle();
    assert.deepEqual(gets, []);
    assert.equal(reader.getIndex()['b.jsonl'].isLoaded, true);
    assert.equal(reader.getIndex()['new.jsonl'].isLoaded, false);
    assert.equal(reader.getIndex()['a.jsonl'].bodyResident, true);
});

test('a hydrating request during a no-hydration build still starts hydration', async () => {
    setup();
    let open;
    listGate = new Promise(resolve => { open = resolve; });
    const startup = reader.buildIndex(null, null, { backgroundHydration: false });
    const panel = await reader.buildIndex();
    assert.equal(panel.buildInProgress, true);
    open(); listGate = null;
    await startup; await idle();
    assert.deepEqual(gets.toSorted(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
    assert.equal(reader.isHydrationComplete(), true);
});

test('a no-hydration build on a new character does not inherit an earlier request', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    context.characterId = 1;
    await reader.buildIndex(null, null, { backgroundHydration: false }); await idle();
    assert.deepEqual(gets, []);
    assert.equal(reader.getIndexCharacterAvatar(), 'beta.png');
});

test('a normal build that replaces another character still hydrates the new one', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    context.characterId = 1;
    await buildAndSettle();
    assert.equal(reader.getIndexCharacterAvatar(), 'beta.png');
    assert.deepEqual(gets.toSorted(), ['a.jsonl', 'b.jsonl', 'c.jsonl']);
    assert.equal(reader.isHydrationComplete(), true);
});

test('a failed chat list is reported and clears on the next successful build', async () => {
    setup(); await buildAndSettle(); gets.length = 0;
    failList = true; await buildAndSettle({ forceRevalidate: true });
    assert.equal(reader.didLastBuildFail(), true);
    assert.deepEqual(gets, [], 'known-good chats are not re-queued by a failed list');
    assert.equal(reader.isHydrationComplete(), true);
    failList = false; await buildAndSettle();
    assert.equal(reader.didLastBuildFail(), false);
});

test('automatic embedding startup does not download the archive', async () => {
    setup();
    const { generateEmbeddingsForCurrentIndex, getAutomaticEmbeddingRunOptions } = await import('../src/ui-controller.js');
    metadata.setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'synthetic', dimensions: 2, embeddingLevels: { chat: true, message: false, query: false } });
    await generateEmbeddingsForCurrentIndex({ ...getAutomaticEmbeddingRunOptions(null, false), rerender: false });
    await idle();
    assert.equal(listRequests, 1);
    assert.deepEqual(gets, []);
    assert.equal(Object.keys(reader.getIndex()).length, 3);
});

test('a cached summary whose chat was deleted while unloaded is removed from storage', async () => {
    setup(); await reload();
    rows.splice(2, 1);
    await buildAndSettle();
    await cache.flushPendingCacheWrites();
    assert.equal(fake.store('chatSummaries').has('alpha.png:c.jsonl'), false);
    assert.equal(fake.store('chatDescriptors').has('alpha.png:c.jsonl'), false);
});

test('specific chats can be indexed without touching the rest of the archive', async () => {
    setup();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.equal(reader.isHydrationIdle(), true, 'nothing queued means nothing running');
    assert.deepEqual(gets, []);
    reader.requestHydration(['b.jsonl']);
    assert.equal(reader.isHydrationIdle(), false);
    assert.equal(reader.getPendingHydrationCount() > 0, true);
    await idle();
    assert.deepEqual(gets, ['b.jsonl']);
    assert.equal(reader.isEntryLoaded('b.jsonl'), true);
    assert.equal(reader.isEntryLoaded('a.jsonl'), false);
    assert.equal(reader.isHydrationIdle(), true);
    reader.requestHydration(['b.jsonl']);
    await idle();
    assert.deepEqual(gets, ['b.jsonl'], 'an indexed chat is not read again');
});

test('a request during a build does not download what its summaries restore', async () => {
    setup(); await reload();
    let release;
    listGate = new Promise(resolve => { release = resolve; });
    const building = reader.buildIndex(null, () => reader.requestHydration(['a.jsonl']), { backgroundHydration: false });
    release();
    await building; await idle();
    assert.deepEqual(gets, []);
    assert.equal(reader.isEntryLoaded('a.jsonl'), true);
    assert.equal(reader.isHydrationIdle(), true);
});

test('cancelling leaves requested work behind and later builds stay partial', async () => {
    setup(['a.jsonl', 'b.jsonl', 'c.jsonl', 'd.jsonl', 'e.jsonl', 'f.jsonl']);
    await reader.buildIndex(null, null, { backgroundHydration: false });
    reader.requestFullHydration();
    reader.cancelBackgroundHydration();
    await idle();
    assert.ok(gets.length <= 2, `${gets.length} chats were read after cancelling`);
    gets.length = 0;
    await buildAndSettle({ backgroundHydration: false });
    assert.deepEqual(gets, []);
    assert.equal(reader.isHydrationIdle(), true);
});

test('full indexing reaches every chat and a list change updates an unindexed card', async () => {
    setup();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    rows[0].chat_items = 9; rows[0].mes = 'newer last message'; rows[0].last_mes = '2026-10-20T12:00:00Z';
    await reader.buildIndex(null, null, { backgroundHydration: false });
    const stale = reader.getIndex()['a.jsonl'];
    assert.equal(stale.isLoaded, false);
    assert.equal(stale.messageCount, 9);
    assert.equal(stale.lastMessageTimestamp, '2026-10-20T12:00:00Z');
    assert.equal(stale.lastMessagePreview, 'newer last message');
    reader.requestFullHydration();
    await idle();
    assert.equal(reader.isHydrationComplete(), true);
    assert.equal(gets.length, 3);
});

test('an empty chat shows no placeholder as its last message', async () => {
    setup();
    Object.assign(rows[0], { chat_items: 0, mes: '[The chat is empty]' });
    Object.assign(rows[1], { chat_items: 1, mes: '[The message is empty]' });
    Object.assign(rows[2], { chat_items: 1, mes: 'real text' });
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.equal(reader.getIndex()['a.jsonl'].lastMessagePreview, '');
    assert.equal(reader.getIndex()['b.jsonl'].lastMessagePreview, '');
    assert.equal(reader.getIndex()['c.jsonl'].lastMessagePreview, 'real text');
});

test('the list request asks for headers so relatives are known before any download', async () => {
    setup();
    const bodiesSeen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { if (url === '/api/characters/chats') bodiesSeen.push(JSON.parse(options.body)); return realFetch(url, options); };
    rows[1].chat_metadata = { main_chat: 'a' };
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.equal(bodiesSeen[0].metadata, true);
    assert.equal(reader.getIndex()['b.jsonl'].mainChat, 'a.jsonl');
    assert.deepEqual(gets, []);
});

function relatives() {
    setup(['main.jsonl', 'child.jsonl', 'other.jsonl', 'grandchild.jsonl']);
    rows[1].chat_metadata = { main_chat: 'main' };
    rows[3].chat_metadata = { main_chat: 'child' };
    bodies.set('main.jsonl', [{}, raw('greeting'), raw('shared'), raw('main path')]);
    bodies.set('child.jsonl', [{ chat_metadata: { main_chat: 'main' } }, raw('greeting'), raw('shared'), raw('child path')]);
    bodies.set('grandchild.jsonl', [{ chat_metadata: { main_chat: 'child' } }, raw('greeting'), raw('other path')]);
    context.chatId = 'main';
    context.chat = bodies.get('main.jsonl').slice(1);
}

test('branch detection reads only provenance relatives, and only once', async () => {
    relatives();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.deepEqual(gets, [], 'the open chat comes from the host');
    await reader.runDeferredBranchDetection('main.jsonl');
    assert.deepEqual(gets.toSorted(), ['child.jsonl', 'grandchild.jsonl']);
    assert.equal(reader.getIndex()['child.jsonl'].branchPoint, 2);
    assert.equal(reader.getIndex()['grandchild.jsonl'].branchPoint, 1);
    assert.equal(reader.getIndex()['other.jsonl'].branchPoint, null);
    gets.length = 0;
    await reader.runDeferredBranchDetection('main.jsonl');
    assert.deepEqual(gets, [], 'a repeated comparison needs no read');
    assert.equal(reader.getIndex()['child.jsonl'].branchPoint, 2);
});

test('branch detection can be limited to the rendered cards', async () => {
    relatives();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    await reader.runDeferredBranchDetection('main.jsonl', { fileNames: ['child.jsonl'] });
    assert.deepEqual(gets, ['child.jsonl']);
    assert.equal(reader.getIndex()['child.jsonl'].branchPoint, 2);
    assert.equal(reader.getIndex()['grandchild.jsonl'].branchPoint, null);
});

test('branch comparison survives a reload using stored records', async () => {
    relatives();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    await reader.runDeferredBranchDetection('main.jsonl');
    await cache.flushPendingCacheWrites();
    reader.clearIndex(); gets.length = 0;
    await reader.buildIndex(null, null, { backgroundHydration: false });
    await reader.runDeferredBranchDetection('main.jsonl');
    assert.deepEqual(gets, []);
    assert.equal(reader.getIndex()['child.jsonl'].branchPoint, 2);
});

test('sibling context stops reading once it has enough relatives', async () => {
    setup(['main.jsonl', 'one.jsonl', 'two.jsonl', 'three.jsonl']);
    bodies.set('main.jsonl', [{}, raw('greeting'), raw('main')]);
    for (const [i, name] of ['one', 'two', 'three'].entries()) {
        rows[i + 1].chat_metadata = { main_chat: 'main' };
        rows[i + 1].last_mes = `2026-10-1${i + 1}T12:00:00Z`;
        bodies.set(`${name}.jsonl`, [{ chat_metadata: { main_chat: 'main' } }, raw('greeting'), raw(name)]);
    }
    await reader.buildIndex(null, null, { backgroundHydration: false });
    const siblings = await reader.getSiblingBranchContextForThread('main.jsonl', 1);
    assert.deepEqual(siblings.map(item => item.fileName), ['three.jsonl'], 'newest first');
    assert.deepEqual(gets.toSorted(), ['main.jsonl', 'three.jsonl']);
});
