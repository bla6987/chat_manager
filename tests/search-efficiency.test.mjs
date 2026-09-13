import test from 'node:test';
import assert from 'node:assert/strict';
import { clearIndex, getIndex } from '../src/chat-reader.js';
import { setEmbeddingSettings } from '../src/metadata-store.js';

function setup() {
    clearIndex();
    const store = new Map();
    const context = {
        characterId: 0,
        characters: [{ avatar: 'efficiency.png' }],
        extensionSettings: {},
        chat: [],
        saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = {
        getContext: () => context,
        libs: { localforage: { createInstance: () => ({
            getItem: async key => store.get(key) ?? null,
            setItem: async (key, value) => { store.set(key, value); return value; },
            clear: async () => store.clear(),
        }) } },
    };
    globalThis.window = { confirm: () => false };
    return { context, store };
}

test('unchanged clustering reuses exact inputs and invalidates fixed-k, mutations, and replacements', async () => {
    setup();
    const { recomputeEmbeddingClusters } = await import('../src/ui-controller.js');
    for (let i = 0; i < 18; i++) {
        getIndex()[`chat-${i}.jsonl`] = {
            fileName: `chat-${i}.jsonl`,
            chatEmbedding: [Math.sin(i), Math.cos(i), i / 18],
            clusterLabel: null,
        };
    }

    const first = await recomputeEmbeddingClusters();
    assert.equal(first.cached, undefined);
    assert.equal((await recomputeEmbeddingClusters()).cached, true);
    assert.equal((await recomputeEmbeddingClusters({ fixedK: 3 })).cached, undefined, 'fixed-k mode has separate validity');
    assert.equal((await recomputeEmbeddingClusters({ fixedK: 3 })).cached, true);

    const stable = getIndex()['chat-2.jsonl'];
    getIndex()['chat-2.jsonl'] = { ...stable, clusterLabel: null };
    assert.equal((await recomputeEmbeddingClusters({ fixedK: 3 })).cached, true, 'entry replacement reuses labels when the vector identity is preserved');
    assert.ok(Number.isFinite(getIndex()['chat-2.jsonl'].clusterLabel));

    getIndex()['chat-0.jsonl'].chatEmbedding[0] += 0.000000001;
    assert.equal((await recomputeEmbeddingClusters({ fixedK: 3 })).cached, undefined, 'in-place numeric changes invalidate exact inputs');

    const pending = recomputeEmbeddingClusters();
    const prior = getIndex()['chat-1.jsonl'];
    getIndex()['chat-1.jsonl'] = { ...prior, chatEmbedding: [...prior.chatEmbedding], clusterLabel: null };
    const refreshed = await pending;
    assert.equal(refreshed.embeddedCount, 18);
    assert.ok(Number.isFinite(getIndex()['chat-1.jsonl'].clusterLabel), 'stale work applies to the current entry only after revalidation');
    assert.equal((await recomputeEmbeddingClusters()).cached, true);
});

test('bounded map batches consume only the requested iterator prefix', async () => {
    setup();
    const { takeMapBatch } = await import('../src/ui-controller.js');
    let visits = 0;
    class CountingMap extends Map {
        entries() {
            const iterator = super.entries();
            return {
                next() { visits++; return iterator.next(); },
                [Symbol.iterator]() { return this; },
            };
        }
    }
    const pending = new CountingMap(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, { id: i }]));
    const batch = takeMapBatch(pending, 24);
    assert.deepEqual(batch.map(item => item.id), Array.from({ length: 24 }, (_, i) => i));
    assert.equal(visits, 24);
    assert.equal(pending.size, 9_976);
});

test('query embeddings coalesce by provider identity, survive failures, and ignore dimensions learned by the request', async () => {
    setup();
    setEmbeddingSettings({
        enabled: true,
        provider: 'ollama',
        model: 'model-a',
        ollamaUrl: 'http://embedding-a',
        embeddingLevels: { chat: false, message: false, query: true },
    });
    const { getSemanticQueryEmbedding, clearInMemoryEmbeddings } = await import('../src/ui-controller.js');
    const { hashEmbeddingText } = await import('../src/embedding-service.js');
    const store = globalThis.SillyTavern.libs.localforage.createInstance();
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
        calls++;
        const input = JSON.parse(options.body).input;
        return { ok: true, text: async () => JSON.stringify({ embeddings: input.map(() => [1, 2, 3]) }) };
    };
    try {
        const [a, b] = await Promise.all([
            getSemanticQueryEmbedding('same query'),
            getSemanticQueryEmbedding('same query'),
        ]);
        assert.deepEqual(a, [1, 2, 3]);
        assert.equal(a, b);
        assert.equal(calls, 1);
        assert.equal((await getSemanticQueryEmbedding('same query')), a, 'learned dimensions do not split the same provider identity');
        assert.equal(calls, 1);

        setEmbeddingSettings({ model: 'model-b' });
        await getSemanticQueryEmbedding('same query');
        assert.equal(calls, 2, 'model changes do not reuse an incompatible query vector');

        let releaseLate;
        globalThis.fetch = () => {
            calls++;
            return new Promise(resolve => { releaseLate = resolve; });
        };
        const late = getSemanticQueryEmbedding('late query');
        while (!releaseLate) await new Promise(resolve => setTimeout(resolve, 1));
        clearInMemoryEmbeddings({ rerender: false });
        releaseLate({ ok: true, text: async () => JSON.stringify({ embeddings: [[4, 5, 6]] }) });
        await late;
        await store.deleteItem?.(hashEmbeddingText('late query'));
        // The fixture store exposes Map semantics through the closure; clear all
        // persistent entries so this assertion isolates the UI memory cache.
        await store.clear();
        globalThis.fetch = async () => {
            calls++;
            return { ok: true, text: async () => JSON.stringify({ embeddings: [[7, 8, 9]] }) };
        };
        assert.deepEqual(await getSemanticQueryEmbedding('late query'), [7, 8, 9]);
        assert.equal(calls, 4, 'a completion from before cache clear cannot repopulate the query memory cache');

        let failures = 0;
        globalThis.fetch = async () => {
            failures++;
            return { ok: false, status: 500, statusText: 'fail', text: async () => '' };
        };
        await assert.rejects(getSemanticQueryEmbedding('retry failure'));
        await assert.rejects(getSemanticQueryEmbedding('retry failure'));
        assert.ok(failures >= 2, 'a failed in-flight request is removed so a later call retries');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('semantic aggregation ranks before allocating results and preserves dedup filename order', async () => {
    setup();
    const { aggregateSemanticResult, finalizeSemanticResults } = await import('../src/ui-controller.js');
    const aggregated = new Map();
    const add = (key, filename, score, order) => aggregateSemanticResult(aggregated, key, {
        item: { filename }, combinedScore: score, otherFiles: [], _semanticOrder: order,
    });
    add('duplicate', 'low.jsonl', 0.4, 0);
    add('tie-first', 'first.jsonl', 0.9, 1);
    add('duplicate', 'winner.jsonl', 0.9, 2);
    add('duplicate', 'middle.jsonl', 0.7, 3);
    for (let i = 0; i < 150; i++) add(`unique-${i}`, `unique-${i}.jsonl`, 0.3 - i / 1000, i + 4);

    const results = finalizeSemanticResults(aggregated, 10_000);
    assert.equal(results.length, 100, 'semantic search retains the established 100-result cap');
    assert.equal(results[0].item.filename, 'first.jsonl', 'global score ties retain winning-variant encounter order');
    assert.equal(results[1].item.filename, 'winner.jsonl');
    assert.deepEqual(results[1].otherFiles, ['middle.jsonl', 'low.jsonl']);
    assert.equal(aggregated.size, 152, 'one aggregate is retained per dedup key before sorting');
});
