import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

const reader = await import('../src/chat-reader.js');
const date = '2026-10-14T12:00:00Z';
let context, rows, bodies, searches, gets, searchGate, searchResponse;

function setup() {
    reader.clearIndex();
    searches = []; gets = []; searchGate = null; searchResponse = null;
    context = { characterId: 0, characters: [{ avatar: 'alpha.png', name: 'Alpha' }], chat: [], chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    bodies = new Map([
        ['a.jsonl', ['The Lantern glows', 'quiet']],
        ['b.jsonl', ['a lantern', 'another line']],
        ['c.jsonl', ['nothing here', 'at all']],
        ['words.jsonl', ['lantern', 'then glows']],
    ]);
    rows = [...bodies.keys()].map((file_name, i) => ({ file_name, chat_items: 2, file_size: '1 KB', last_mes: `2026-10-1${i}T12:00:00Z` }));
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        if (url === '/api/characters/chats') return { ok: true, json: async () => structuredClone(rows) };
        if (url === '/api/chats/search') {
            searches.push(body.query);
            await searchGate;
            if (searchResponse) return searchResponse();
            // The server's rule: every word appears somewhere in the chat.
            const words = body.query.trim().toLowerCase().split(/\s+/);
            const hits = [...bodies].filter(([, lines]) => words.every(word => lines.some(line => line.toLowerCase().includes(word))));
            return { ok: true, json: async () => hits.map(([name]) => ({ file_name: name.replace('.jsonl', '') })) };
        }
        const name = `${body.file_name}.jsonl`;
        gets.push(name);
        return { ok: true, json: async () => [{}, ...bodies.get(name).map(mes => ({ mes, send_date: date }))] };
    };
    return reader.buildIndex(null, null, { backgroundHydration: false });
}
afterEach(() => reader.clearIndex());

test('only chats the server names are candidates, newest first, with the server told the query', async () => {
    await setup();
    assert.deepEqual(await reader.findChatsMatchingKeyword('  LANTERN  '), ['words.jsonl', 'b.jsonl', 'a.jsonl']);
    assert.deepEqual(searches, ['lantern']);
    assert.deepEqual(gets, []);
});

test('the open chat is always a candidate because it may hold unsaved text', async () => {
    await setup();
    context.chatId = 'c';
    assert.deepEqual(await reader.findChatsMatchingKeyword('lantern'), ['words.jsonl', 'c.jsonl', 'b.jsonl', 'a.jsonl']);
});

test('the server rule never loses a true substring match', async () => {
    await setup();
    const { searchArchivePage } = await import('../src/archive-search.js');
    for (const query of ['lantern glows', 'quiet', 'at all', 'line']) {
        const narrowed = await reader.findChatsMatchingKeyword(query);
        const full = await searchArchivePage({ query, settings: {}, limit: 50 });
        const fromNarrowed = await searchArchivePage({ query, settings: {}, limit: 50, fileNames: narrowed });
        assert.deepEqual(fromNarrowed.results.map(item => item.item.filename), full.results.map(item => item.item.filename), query);
    }
});

test('typing further reuses a scan instead of starting another', async () => {
    await setup();
    await reader.findChatsMatchingKeyword('lan');
    assert.deepEqual(await reader.findChatsMatchingKeyword('lantern'), ['words.jsonl', 'b.jsonl', 'a.jsonl']);
    assert.deepEqual(searches, ['lan']);
    await reader.findChatsMatchingKeyword('quiet');
    assert.deepEqual(searches, ['lan', 'quiet'], 'an unrelated query scans again');
});

test('a chat changing invalidates the reused scan', async () => {
    await setup();
    await reader.findChatsMatchingKeyword('lantern');
    reader.markChatDirty('c.jsonl');
    await reader.findChatsMatchingKeyword('lantern');
    assert.equal(searches.length, 2);
    rows[2].file_size = '2 KB';
    await reader.buildIndex(null, null, { backgroundHydration: false });
    await reader.findChatsMatchingKeyword('lantern');
    assert.equal(searches.length, 3);
});

test('indexing alone does not invalidate the reused scan', async () => {
    await setup();
    await reader.findChatsMatchingKeyword('lantern');
    await reader.loadEntryNow('a.jsonl');
    await reader.findChatsMatchingKeyword('lantern');
    assert.equal(searches.length, 1);
});

test('only one scan runs at a time and a later query waits for it', async () => {
    await setup();
    let release;
    searchGate = new Promise(resolve => { release = resolve; });
    const first = reader.findChatsMatchingKeyword('lan');
    const second = reader.findChatsMatchingKeyword('quiet');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(searches, ['lan']);
    release();
    await first;
    assert.deepEqual(await second, ['a.jsonl']);
    assert.deepEqual(searches, ['lan', 'quiet']);
});

test('a superseded search stops waiting while the running scan still serves the next one', async () => {
    await setup();
    let release;
    searchGate = new Promise(resolve => { release = resolve; });
    const controller = new AbortController();
    const first = reader.findChatsMatchingKeyword('lan', { signal: controller.signal });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(first, { name: 'AbortError' });
    const next = reader.findChatsMatchingKeyword('lantern');
    release();
    assert.deepEqual(await next, ['words.jsonl', 'b.jsonl', 'a.jsonl']);
    assert.deepEqual(searches, ['lan']);
});

for (const [name, response] of [
    ['an error status', () => ({ ok: false, status: 404 })],
    ['a malformed body', () => ({ ok: true, json: async () => ({ error: true }) })],
    ['a network failure', () => { throw new Error('offline'); }],
]) {
    test(`${name} falls back to reading every chat`, async () => {
        await setup();
        searchResponse = response;
        const warn = console.warn; console.warn = () => {};
        try { assert.equal(await reader.findChatsMatchingKeyword('lantern'), null); } finally { console.warn = warn; }
        searchResponse = null;
        assert.deepEqual(await reader.findChatsMatchingKeyword('lantern'), ['words.jsonl', 'b.jsonl', 'a.jsonl'], 'a failure is not remembered');
    });
}

test('no narrowing without a query or a character', async () => {
    await setup();
    assert.equal(await reader.findChatsMatchingKeyword('   '), null);
    context.characterId = undefined;
    assert.equal(await reader.findChatsMatchingKeyword('lantern'), null);
});

test('verifying chats invalidates a scan that could be reused', async () => {
    await setup();
    await reader.findChatsMatchingKeyword('drag');
    bodies.set('c.jsonl', ['a dragon here', 'at all']);
    await reader.buildIndex(null, null, { forceRevalidate: true });
    while (reader.isBuilding()) await new Promise(resolve => setTimeout(resolve, 2));
    assert.ok((await reader.findChatsMatchingKeyword('dragon')).includes('c.jsonl'));
    assert.equal(searches.length, 2);
});

test('a read that finds changed text invalidates a scan that could be reused', async () => {
    await setup();
    await reader.loadEntryNow('c.jsonl');
    reader.trimBodyCache({ keepActive: false, targetBytes: 0 });
    await reader.findChatsMatchingKeyword('drag');
    bodies.set('c.jsonl', ['a dragon here', 'at all']);
    await reader.readChatMessages('c.jsonl');
    assert.ok((await reader.findChatsMatchingKeyword('dragon')).includes('c.jsonl'));
    assert.equal(searches.length, 2);
});
