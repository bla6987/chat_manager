import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexChatText } from '../src/chat-index-data.js';
import { installFakeIndexedDB } from './helpers/fake-indexeddb.mjs';

const fake = installFakeIndexedDB({ schedule: setImmediate });

// Runs the real protocol. Whatever crosses here is cloned, as it would be for real.
const workers = [];
let failToStart = false;
let crashOnMessage = false;
globalThis.Worker = class FakeWorker {
    constructor(url, options) {
        if (failToStart) throw new Error('Workers are blocked');
        this.url = String(url);
        this.options = options;
        this.posted = [];
        workers.push(this);
    }
    postMessage(message) {
        this.posted.push(message);
        setImmediate(() => {
            if (this.terminated) return;
            if (crashOnMessage) { this.onerror?.({ message: 'worker crashed' }); return; }
            const { id, text, fileName } = message;
            try {
                this.onmessage?.({ data: structuredClone({ id, ok: true, ...indexChatText(text, fileName) }) });
            } catch (error) {
                this.onmessage?.({ data: { id, ok: false, error: String(error.message) } });
            }
        });
    }
    terminate() { this.terminated = true; }
};

const stamp = Date.now();
const reader = await import('../src/chat-reader.js');
const cache = await import('../src/cache-store.js');
const date = '2026-10-14T12:00:00Z';
let context, rows, bodies, gets, parsedOnPage;

function setup() {
    reader.clearIndex();
    fake.reset();
    gets = []; parsedOnPage = 0;
    context = { characterId: 0, characters: [{ avatar: 'alpha.png', name: 'Alpha' }], chat: [], chatMetadata: {}, extensionSettings: {}, saveSettingsDebounced() {}, getRequestHeaders: () => ({}) };
    bodies = new Map(['a.jsonl', 'b.jsonl'].map(name => [name, [{ chat_metadata: { main_chat: 'parent' } }, { mes: 'greeting', send_date: date }, { mes: `${name} text`, is_user: true, send_date: date }]]));
    rows = [...bodies.keys()].map(file_name => ({ file_name, chat_items: 2, file_size: '1 KB', last_mes: date }));
    globalThis.SillyTavern = { getContext: () => context };
    globalThis.fetch = async (url, options) => {
        if (url === '/api/characters/chats') return { ok: true, json: async () => structuredClone(rows) };
        const name = `${JSON.parse(options.body).file_name}.jsonl`;
        gets.push(name);
        return {
            ok: true,
            text: async () => JSON.stringify(bodies.get(name)),
            json: async () => { parsedOnPage++; return structuredClone(bodies.get(name)); },
        };
    };
}
const settle = async () => {
    while (reader.isBuilding()) await new Promise(resolve => setTimeout(resolve, 2));
    await cache.flushPendingCacheWrites();
};
afterEach(async () => { await settle(); reader.clearIndex(); });

test('background indexing parses in the worker and installs only a summary', async () => {
    setup();
    await reader.buildIndex();
    await settle();
    assert.equal(reader.isHydrationComplete(), true);
    assert.equal(parsedOnPage, 0, 'the page never parsed a chat');
    assert.equal(workers.at(-1).options.type, 'module');
    assert.match(workers.at(-1).url, /chat-index-worker\.js$/);
    const entry = reader.getIndex()['a.jsonl'];
    assert.deepEqual(entry.messages, []);
    assert.equal(entry.bodyResident, false);
    assert.equal(entry.messageCount, 2);
    assert.equal(entry.userMessageCount, 1);
    assert.equal(entry.mainChat, 'parent.jsonl');
    assert.equal(entry.lastMessagePreview, 'a.jsonl text');
    assert.equal((await reader.readChatDescriptors('a.jsonl'))[1].preview, 'a.jsonl text');
});

test('a read somebody is waiting for stays on the page and keeps its body', async () => {
    setup();
    await reader.buildIndex(null, null, { backgroundHydration: false });
    assert.equal(await reader.loadEntryNow('a.jsonl'), true);
    assert.equal(parsedOnPage, 1);
    assert.equal(reader.getIndex()['a.jsonl'].messages[1].text, 'a.jsonl text');
});

test('a malformed chat fails only that chat and leaves the worker usable', async () => {
    setup();
    bodies.set('a.jsonl', { error: 'not a chat' });
    const error = console.error; console.error = () => {};
    try {
        await reader.buildIndex();
        await settle();
    } finally { console.error = error; }
    assert.equal(reader.isEntryLoaded('a.jsonl'), false);
    assert.equal(reader.isEntryLoaded('b.jsonl'), true);
    assert.equal(reader.getIndex()['a.jsonl'].needsHydration, true);
});

test('a resident vector follows unchanged text through a background re-index', async () => {
    setup();
    bodies.get('a.jsonl')[1].mes = 'kept text';
    rows[0].file_size = '1 KB';
    await reader.buildIndex();
    await settle();
    await cache.flushPendingCacheWrites();
    const entry = reader.getIndex()['a.jsonl'];
    const vector = new Float32Array([1, 0]);
    assert.equal(reader.setMessageEmbedding(entry, 0, 0, vector), true);
    assert.equal(reader.setMessageEmbedding(entry, 1, 0, new Float32Array([0, 1])), true);
    bodies.get('a.jsonl')[2].mes = 'changed text';
    rows[0].file_size = '2 KB';
    await reader.buildIndex();
    await settle();
    const next = reader.getIndex()['a.jsonl'];
    assert.equal(next.isLoaded && !next.needsHydration, true);
    assert.equal(parsedOnPage, 0, 'the comparison uses the rows the worker returned');
    assert.deepEqual([...next.messageEmbeddings.keys()], ['m:0:s:0'], 'only the unchanged message keeps its vector');
    assert.deepEqual([...next.cachedMessageEmbeddingKeys], ['m:0:s:0']);
});

test('when the worker dies, its chats are indexed on the page and later ones skip it', async () => {
    setup();
    crashOnMessage = true;
    const warn = console.warn; const warnings = []; console.warn = (...args) => warnings.push(args);
    try {
        await reader.buildIndex();
        await settle();
    } finally { console.warn = warn; crashOnMessage = false; }
    assert.equal(reader.isHydrationComplete(), true, 'nothing was lost');
    assert.deepEqual(reader.getIndex()['a.jsonl'].messages, [], 'the fallback keeps the same memory behaviour');
    assert.ok(workers.at(-1).terminated);
    assert.ok(warnings.length > 0);
    const created = workers.length;
    setup();
    await reader.buildIndex();
    await settle();
    assert.equal(workers.length, created, 'a failed worker is not retried');
    assert.equal(reader.isHydrationComplete(), true);
});

test('a browser without workers or one that blocks them still indexes', async () => {
    const client = await import(`../src/chat-index-client.js?blocked=${stamp}`);
    failToStart = true;
    await assert.rejects(client.indexChatTextInWorker('[]', 'x.jsonl'), client.IndexWorkerUnavailable);
    failToStart = false;
    assert.equal(client.isIndexWorkerAvailable(), false);
});

test('the worker script only needs modules that are safe off the page', () => {
    const source = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const seen = new Set();
    const visit = file => {
        if (seen.has(file)) return;
        seen.add(file);
        const text = source(file);
        assert.doesNotMatch(text.replace(/\/\*[\s\S]*?\*\//g, ''), /\b(document|window|SillyTavern|indexedDB|localStorage)\b/, file);
        for (const [, dependency] of text.matchAll(/from '\.\/([^']+)'/g)) visit(dependency);
    };
    visit('chat-index-worker.js');
    assert.deepEqual([...seen].sort(), ['chat-index-data.js', 'chat-index-worker.js', 'message-descriptors.js', 'timestamps.js']);
});

test('a worker that never answers is abandoned so indexing can continue', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const OriginalWorker = globalThis.Worker;
    globalThis.Worker = class SilentWorker extends OriginalWorker { postMessage(message) { this.posted.push(message); } };
    try {
        const client = await import(`../src/chat-index-client.js?silent=${stamp}`);
        const job = client.indexChatTextInWorker('[]', 'x.jsonl');
        t.mock.timers.tick(30_000);
        await assert.rejects(job, client.IndexWorkerUnavailable);
        assert.equal(client.isIndexWorkerAvailable(), false);
    } finally { globalThis.Worker = OriginalWorker; }
});
