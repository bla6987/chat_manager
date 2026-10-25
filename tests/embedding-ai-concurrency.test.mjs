import test from 'node:test';
import assert from 'node:assert/strict';
import {
    embedText, embedTexts, iterateEmbeddingBatches, embedTextsBatched, clearEmbeddingCache, getCachedEmbeddingForText,
    captureEmbeddingOperation, isEmbeddingOperationCurrent,
    getEmbeddingRecipeKey, isStaleEmbeddingOperationError, onEmbeddingDimensionsInvalidated,
} from '../src/embedding-service.js';
import {
    generateTitleForChat, generateSummaryForChat,
    generateTitleForActiveChat, generateSummaryForActiveChat,
} from '../src/ai-features.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};
const response = (embeddings, status = 200, errorText = '') => ({
    ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Synthetic failure',
    text: async () => errorText || JSON.stringify({ embeddings }),
});
const stored = new Map();
let context;
let beforeWrite = null;
let beforeRead = null;
const cache = {
    async getItem(key) { if (beforeRead) await beforeRead(key); return stored.get(key) ?? null; },
    async setItem(key, value) { if (beforeWrite) await beforeWrite(key, value); stored.set(key, value); return value; },
    async clear() { stored.clear(); },
};
globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { createInstance: () => cache } } };
globalThis.window = { confirm: () => { throw new Error('Embedding generation must not prompt or clear other recipes.'); } };

async function setupEmbedding(options = {}) {
    context = {
        characterId: 0, characters: [{ avatar: 'synthetic.png' }], saveSettingsDebounced() {},
        extensionSettings: { chat_manager: { metadata: {}, embeddings: {
            enabled: true, provider: 'ollama', model: 'synthetic', ollamaUrl: 'http://synthetic-a',
            dimensions: null, embeddingLevels: { chat: true, message: true, query: true }, ...options,
        } } },
    };
    beforeWrite = null;
    beforeRead = null;
    globalThis.fetch = async () => { throw new Error('Unexpected unmocked provider request.'); };
    await clearEmbeddingCache();
    return context.extensionSettings.chat_manager.embeddings;
}

test('persistent cache isolates same model alias on different endpoints and reuses only the matching recipe', async () => {
    const settings = await setupEmbedding();
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return response([url.includes('synthetic-a') ? [1, 0] : [0, 1]]);
    };
    const operation = captureEmbeddingOperation();
    assert.deepEqual(await embedText('identical text', { level: 'message' }), new Float32Array([1, 0]));
    assert.equal(isEmbeddingOperationCurrent(operation), true, 'learning dimensions does not invalidate a recipe');
    settings.ollamaUrl = 'http://synthetic-b/';
    assert.equal(isEmbeddingOperationCurrent(operation), false);
    assert.equal(await getCachedEmbeddingForText('identical text'), null);
    assert.deepEqual(await embedText('identical text', { level: 'message' }), new Float32Array([0, 1]));
    settings.ollamaUrl = 'http://synthetic-a/';
    assert.deepEqual(await embedText('identical text', { level: 'message' }), new Float32Array([1, 0]));
    assert.equal(calls.length, 2);
    assert.equal(new Set([...stored.values()].filter(x => x.vector).map(x => x.recipeKey)).size, 2);
    assert.equal(getEmbeddingRecipeKey(settings), getEmbeddingRecipeKey({ ...settings, ollamaUrl: 'http://synthetic-a' }));
});

test('pending provider responses cannot survive model, provider, endpoint, or explicit cache invalidation', async () => {
    for (const change of [
        settings => { settings.model = 'other-model'; },
        settings => { settings.provider = 'openai'; settings.apiKey = 'synthetic-key'; },
        settings => { settings.ollamaUrl = 'http://synthetic-other'; },
        () => clearEmbeddingCache(),
    ]) {
        const settings = await setupEmbedding();
        const entered = deferred(), release = deferred();
        let requestModel;
        globalThis.fetch = async (_url, options) => {
            requestModel = JSON.parse(options.body).model;
            entered.resolve();
            await release.promise;
            return response([[1, 0]]);
        };
        const pending = embedText('pending text', { level: 'message' });
        const rejected = assert.rejects(pending, isStaleEmbeddingOperationError);
        await entered.promise;
        await change(settings);
        release.resolve();
        await rejected;
        assert.equal(requestModel, 'synthetic');
        assert.equal([...stored.values()].filter(value => value.vector).length, 0);
    }
});

test('clear waits for already-issued cache writes, then removes them before resolving', async () => {
    await setupEmbedding();
    const entered = deferred(), release = deferred();
    beforeWrite = async (_key, value) => {
        if (value.vector) { entered.resolve(); await release.promise; }
    };
    globalThis.fetch = async () => response([[1, 0]]);
    const pending = embedText('pending IndexedDB write', { level: 'message' });
    const rejected = assert.rejects(pending, isStaleEmbeddingOperationError);
    await entered.promise;
    let cleared = false;
    const clearing = clearEmbeddingCache().then(() => { cleared = true; });
    await Promise.resolve();
    assert.equal(cleared, false);
    release.resolve();
    await clearing;
    await rejected;
    assert.equal(stored.size, 0);
});

test('one rejected cache write cannot release a clear while another issued write remains pending', async () => {
    await setupEmbedding();
    const entered = deferred(), release = deferred();
    beforeWrite = async (_key, value) => {
        if (value.text === 'failed write') throw new Error('Synthetic IndexedDB failure');
        if (value.text === 'late write') { entered.resolve(); await release.promise; }
    };
    globalThis.fetch = async () => response([[1, 0], [0, 1]]);
    const pending = embedTexts(['failed write', 'late write'], { level: 'message' });
    const rejected = assert.rejects(pending, /Synthetic IndexedDB failure/);
    await entered.promise;
    let cleared = false;
    const clearing = clearEmbeddingCache().then(() => { cleared = true; });
    await Promise.resolve();
    assert.equal(cleared, false);
    release.resolve();
    await Promise.all([clearing, rejected]);
    assert.equal(stored.size, 0);
});

test('unexpected dimension drift clears old vectors and permits a fresh operation with learned dimensions', async () => {
    const settings = await setupEmbedding({ dimensions: 2 });
    globalThis.fetch = async () => response([[1, 0, 0]]);
    const oldOperation = captureEmbeddingOperation();
    await assert.rejects(embedText('dimension drift', { level: 'message' }), error =>
        isStaleEmbeddingOperationError(error) && error.reason === 'dimensions');
    assert.equal(isEmbeddingOperationCurrent(oldOperation), false);
    assert.equal(settings.dimensions, null);
    assert.equal(stored.size, 0);
    assert.deepEqual(await embedText('dimension drift', { level: 'message' }), new Float32Array([1, 0, 0]));
    assert.equal(settings.dimensions, 3);
});

test('dimension invalidation subscribers run after reset, ignore unsubscribe, and receive no ordinary clear events', async () => {
    const settings = await setupEmbedding({ dimensions: 2 });
    let calls = 0, unsubscribedCalls = 0;
    let resetState;
    const unsubscribe = onEmbeddingDimensionsInvalidated(() => {
        calls++;
        resetState = { dimensions: settings.dimensions, cacheSize: stored.size };
    });
    const removeOther = onEmbeddingDimensionsInvalidated(() => { unsubscribedCalls++; });
    removeOther();
    try {
        await clearEmbeddingCache();
        assert.equal(calls, 0);
        globalThis.fetch = async () => response([[1, 0, 0]]);
        await assert.rejects(embedText('direct view dimension drift', { level: 'query' }), error =>
            isStaleEmbeddingOperationError(error) && error.reason === 'dimensions');
        assert.equal(calls, 1);
        assert.deepEqual(resetState, { dimensions: null, cacheSize: 0 });
        assert.equal(unsubscribedCalls, 0);
        await embedText('direct view dimension drift', { level: 'query' });
        assert.equal(calls, 1, 'successful learning does not invalidate other vectors');
    } finally {
        unsubscribe();
    }
});

test('a cache-read completion is rejected when its endpoint changes while IndexedDB is pending', async () => {
    const settings = await setupEmbedding();
    globalThis.fetch = async () => response([[1, 0]]);
    await embedText('cached text', { level: 'message' });
    const entered = deferred(), release = deferred();
    beforeRead = async () => { entered.resolve(); await release.promise; };
    const pending = getCachedEmbeddingForText('cached text');
    const rejected = assert.rejects(pending, isStaleEmbeddingOperationError);
    await entered.promise;
    settings.ollamaUrl = 'http://synthetic-new';
    release.resolve();
    await rejected;
});

test('transient Ollama batch errors get one bounded retry and never disable later batching', async () => {
    await setupEmbedding({ ollamaUrl: 'http://synthetic-transient' });
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push(url);
        return calls.length === 1 ? response(null, 503, 'temporarily unavailable')
            : response(JSON.parse(options.body).input.map(() => [1, 0]));
    };
    assert.equal((await embedTexts(['first', 'second'], { level: 'message' })).length, 2);
    await embedText('third', { level: 'message' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(url => url.endsWith('/api/embed')));
});

test('persistent transient failures stop after the retry and a later request tries batching again', async () => {
    await setupEmbedding({ ollamaUrl: 'http://synthetic-persistent-transient' });
    let calls = 0;
    globalThis.fetch = async () => { calls++; return response(null, 503, 'temporarily unavailable'); };
    await assert.rejects(embedText('retry text', { level: 'message' }), /temporarily unavailable/);
    assert.equal(calls, 2);
    globalThis.fetch = async url => { calls++; assert.ok(url.endsWith('/api/embed')); return response([[1, 0]]); };
    await embedText('retry text', { level: 'message' });
    assert.equal(calls, 3);
});

test('explicit unsupported routes fall back only for that endpoint; a missing model does not disable batching', async () => {
    const settings = await setupEmbedding({ ollamaUrl: 'http://synthetic-old-ollama' });
    const calls = [];
    globalThis.fetch = async url => {
        calls.push(url);
        return url.endsWith('/api/embed') ? response(null, 404, '404 page not found')
            : { ok: true, text: async () => JSON.stringify({ embedding: [1, 0] }) };
    };
    await embedTexts(['old first', 'old second'], { level: 'message' });
    await embedText('old third', { level: 'message' });
    assert.equal(calls.filter(url => url.endsWith('/api/embed')).length, 1);
    assert.equal(calls.length, 4);
    settings.ollamaUrl = 'http://synthetic-new-ollama';
    globalThis.fetch = async url => { calls.push(url); return response([[0, 1]]); };
    assert.deepEqual(await embedText('old first', { level: 'message' }), new Float32Array([0, 1]));
    assert.equal(calls.at(-1), 'http://synthetic-new-ollama/api/embed');
    settings.ollamaUrl = 'http://synthetic-missing-model';
    globalThis.fetch = async () => response(null, 404, JSON.stringify({ error: { message: 'model not found' } }));
    await assert.rejects(embedText('model test', { level: 'message' }), /model not found/);
    globalThis.fetch = async url => { assert.ok(url.endsWith('/api/embed')); return response([[1, 0]]); };
    await embedText('model test', { level: 'message' });
});

test('streamed embeddings yield bounded typed batches before consuming the rest of an input', async () => {
    await setupEmbedding();
    let consumed = 0;
    const requests = [];
    function* inputs() {
        for (let i = 0; i < 11; i++) {
            consumed++;
            yield `stream-${i}`;
        }
    }
    globalThis.fetch = async (_url, options) => {
        const texts = JSON.parse(options.body).input;
        requests.push(texts);
        return response(texts.map((_, i) => [i + 0.1, 1]));
    };
    const batches = iterateEmbeddingBatches(inputs(), { level: 'message', batchSize: 4 });
    const first = await batches.next();
    assert.equal(consumed, 4, 'the source pauses at the first full batch');
    assert.equal(requests.length, 1);
    assert.equal(first.value.offset, 0);
    assert.equal(first.value.vectors.length, 4);
    assert.ok(first.value.vectors.every(vector => vector instanceof Float32Array));
    assert.ok([...stored.values()].filter(value => value.vector).every(value => value.vector instanceof Float32Array));
    const offsets = [first.value.offset];
    for await (const batch of batches) offsets.push(batch.offset);
    assert.deepEqual(offsets, [0, 4, 8]);
    assert.deepEqual(requests.map(texts => texts.length), [4, 4, 3]);
});

test('streaming observes text and known vector budgets without truncating large inputs', async () => {
    await setupEmbedding({ dimensions: 2 });
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        const texts = JSON.parse(options.body).input;
        requests.push(texts);
        return response(texts.map(() => [1, 0]));
    };
    const texts = ['aaaa', 'bbbb', 'cccccccccccc', 'dd', 'ee', 'ff'];
    const delivered = [];
    const result = await embedTextsBatched(texts, {
        level: 'message', batchSize: 20, maxBatchChars: 10, maxBatchVectorBytes: 16,
        onBatch: async batch => { delivered.push(...batch.texts); },
    });
    assert.deepEqual(delivered, texts);
    assert.deepEqual(result, { count: 6, dimensions: 2 });
    assert.deepEqual(requests.map(batch => batch.length), [2, 1, 2, 1]);
    assert.equal(requests[1][0], texts[2], 'an oversize item is sent whole and alone');
});

test('batch callbacks apply backpressure and abort prevents further provider calls', async () => {
    await setupEmbedding();
    const controller = new AbortController();
    let consumed = 0, calls = 0;
    async function* inputs() {
        for (let i = 0; i < 10; i++) { consumed++; yield `backpressure-${i}`; }
    }
    globalThis.fetch = async (_url, options) => {
        assert.equal(options.signal, controller.signal);
        calls++;
        return response(JSON.parse(options.body).input.map(() => [1, 0]));
    };
    await assert.rejects(embedTextsBatched(inputs(), {
        level: 'message', batchSize: 2, signal: controller.signal,
        onBatch: async () => {
            await Promise.resolve();
            assert.equal(consumed, 2);
            assert.equal(calls, 1);
            controller.abort();
        },
    }), { name: 'AbortError' });
    assert.equal(calls, 1);
});

test('legacy cached arrays become Float32 and invalid coordinates are rejected before persistence', async () => {
    await setupEmbedding();
    globalThis.fetch = async () => response([[0.1, 0.2]]);
    await embedText('legacy vector', { level: 'message' });
    const record = [...stored.values()].find(value => value.vector);
    record.vector = Array.from(record.vector);
    const restored = await getCachedEmbeddingForText('legacy vector');
    assert.ok(restored instanceof Float32Array);
    assert.equal(restored[0], Math.fround(0.1));
    globalThis.fetch = async () => response([[1e100, 0]]);
    await assert.rejects(embedText('invalid float32', { level: 'message' }), /Float32 range/);
    assert.equal([...stored.values()].filter(value => value.vector).length, 1);
});

function setupAI({ target = 'ai', selected = 'original' } = {}) {
    const events = [];
    const connectionManager = {
        selectedProfile: selected,
        profiles: [{ id: 'original', name: 'Original' }, { id: 'ai', name: 'AI' }, { id: 'user', name: 'User' }],
    };
    context = {
        onlineStatus: 'connected', characterId: 0, characters: [{ avatar: 'synthetic.png' }],
        extensionSettings: { chat_manager: { metadata: {}, aiConnectionProfile: target }, connectionManager },
        saveSettingsDebounced() {},
        SlashCommandParser: { commands: { profile: { async callback(args, name) {
            events.push('/profile ' + name);
            connectionManager.selectedProfile = connectionManager.profiles.find(profile => profile.name === name)?.id ?? null;
        } } } },
    };
    return { events, connectionManager };
}

test('AI calls queue before checking the temporary selected profile and restore after each owner completes', async () => {
    const { events, connectionManager } = setupAI();
    const entered = [deferred(), deferred()], release = [deferred(), deferred()];
    let generations = 0;
    context.generateRaw = async () => {
        const i = generations++;
        assert.equal(connectionManager.selectedProfile, 'ai');
        entered[i].resolve();
        await release[i].promise;
        assert.equal(connectionManager.selectedProfile, 'ai');
        return `Title ${i}`;
    };
    const first = generateTitleForChat([{ role: 'user', text: 'one' }], 'Character');
    await entered[0].promise;
    const second = generateTitleForChat([{ role: 'user', text: 'two' }], 'Character');
    await Promise.resolve();
    assert.equal(generations, 1);
    release[0].resolve();
    await first;
    await entered[1].promise;
    assert.deepEqual(events, ['/profile AI', '/profile Original', '/profile AI']);
    release[1].resolve();
    await second;
    assert.equal(connectionManager.selectedProfile, 'original');
});

test('AI cleanup preserves a user-selected profile and queued calls capture the new restoration owner', async () => {
    const { events, connectionManager } = setupAI();
    const entered = deferred(), release = deferred();
    let count = 0;
    context.generateRaw = async () => {
        if (count++ === 0) { entered.resolve(); await release.promise; }
        return 'Synthetic title';
    };
    const first = generateTitleForChat([], 'Character');
    await entered.promise;
    const second = generateTitleForChat([], 'Character');
    connectionManager.selectedProfile = 'user';
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['/profile AI', '/profile AI', '/profile User']);
    assert.equal(connectionManager.selectedProfile, 'user');
});

test('quiet title and summary share one injection owner even with no configured AI profile', async () => {
    setupAI({ target: '' });
    const entered = [deferred(), deferred()], release = [deferred(), deferred()];
    const injections = [];
    let generations = 0;
    context.setExtensionPrompt = (_key, prompt) => { injections.push(prompt); };
    context.generateQuietPrompt = async () => {
        const i = generations++;
        entered[i].resolve();
        await release[i].promise;
        return i === 0 ? 'Synthetic title' : 'Synthetic summary';
    };
    const first = generateTitleForActiveChat();
    await entered[0].promise;
    const second = generateSummaryForActiveChat();
    await Promise.resolve();
    assert.equal(generations, 1);
    release[0].resolve();
    await first;
    await entered[1].promise;
    assert.match(injections[0], /short title/);
    assert.equal(injections[1], '');
    assert.match(injections[2], /Summarize/);
    release[1].resolve();
    await second;
    assert.equal(injections[3], '');
});

test('queued raw AI actions snapshot source text before waiting for the profile lock', async () => {
    setupAI();
    const entered = deferred(), release = deferred();
    const prompts = [];
    context.generateRaw = async ({ prompt }) => {
        prompts.push(prompt);
        if (prompts.length === 1) { entered.resolve(); await release.promise; }
        return 'Synthetic output';
    };
    const first = generateTitleForChat([], 'Character');
    await entered.promise;
    const messages = [{ role: 'user', text: 'captured source' }];
    const title = generateTitleForChat(messages, 'Character');
    const summary = generateSummaryForChat(messages, 'Character');
    messages[0].text = 'later mutation';
    release.resolve();
    await Promise.all([first, title, summary]);
    for (const prompt of prompts.slice(1)) {
        assert.match(prompt, /captured source/);
        assert.doesNotMatch(prompt, /later mutation/);
    }
});
