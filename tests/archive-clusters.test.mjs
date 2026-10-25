import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { computeArchiveClusters, ARCHIVE_CLUSTER_SAMPLE_LIMIT, ARCHIVE_CLUSTER_SAMPLE_BYTES } from '../src/archive-clusters.js';
import { getIndex, clearIndex, setVectorCacheBudget, getVectorCacheStats, DEFAULT_VECTOR_CACHE_BYTES } from '../src/chat-reader.js';
import { getEmbeddingSettings, setEmbeddingSettings } from '../src/metadata-store.js';
import { getEmbeddingRecipeKey, hashEmbeddingText, isStaleEmbeddingOperationError } from '../src/embedding-service.js';
import { kMeansAsync } from '../src/semantic-engine.js';

let disk = new Map();
let readCount = 0;
let readHook = null;
const store = {
    async getItem(key) {
        readCount++;
        readHook?.(readCount, key);
        // IndexedDB returns a structured clone rather than sharing its vector
        // storage with the caller. Exercise that real ownership boundary.
        return structuredClone(disk.get(key) || null);
    },
    async setItem(key, value) { disk.set(key, structuredClone(value)); return value; },
    async removeItem(key) { disk.delete(key); },
    async clear() { disk.clear(); },
};

function setup(count, dimensions = 2) {
    clearIndex();
    setVectorCacheBudget(0);
    disk = new Map(); readCount = 0; readHook = null;
    const context = { characterId: 0, characters: [{ avatar: 'clusters.png' }],
        extensionSettings: {}, chat: [], saveSettingsDebounced() {} };
    globalThis.SillyTavern = { getContext: () => context,
        libs: { localforage: { createInstance: () => store } } };
    globalThis.fetch = async () => { throw new Error('Clustering must not request a provider or hydrate a compact indexed body.'); };
    setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'cluster-test', dimensions,
        embeddingLevels: { chat: true, message: false, query: false } });
    const recipeKey = getEmbeddingRecipeKey(getEmbeddingSettings());
    const fileNames = [];
    const vectors = [];
    for (let i = 0; i < count; i++) {
        const fileName = `chat-${String(i).padStart(5, '0')}.jsonl`;
        const text = `Distinct representative chat text ${i}`;
        const vector = new Float32Array(dimensions);
        vector[0] = (i < count / 2 ? -10 : 10) + (i % 7) / 100;
        if (dimensions > 1) vector[1] = (i % 11) / 100;
        getIndex()[fileName] = { fileName, isLoaded: true, needsHydration: false,
            bodyResident: false, bodyEmbeddingText: text, messages: [],
            chatEmbedding: null, chatEmbeddingHash: null, clusterLabel: null };
        const key = `${hashEmbeddingText(recipeKey)}:${hashEmbeddingText(text)}`;
        disk.set(key, { text, vector, dims: dimensions, provider: 'ollama', model: 'cluster-test', recipeKey });
        fileNames.push(fileName);
        vectors.push(vector);
    }
    return { context, fileNames, vectors };
}

afterEach(() => {
    readHook = null;
    clearIndex();
    setVectorCacheBudget(DEFAULT_VECTOR_CACHE_BYTES);
});

test('every persisted chat is clustered with zero resident vector bytes', async () => {
    const { fileNames, vectors } = setup(70);
    const expected = await kMeansAsync(vectors, 2, 50);
    const result = await computeArchiveClusters({ fileNames, fixedK: 2 });
    assert.equal(result.k, 2);
    assert.equal(result.clusterCount, 2);
    assert.equal(result.embeddedCount, 70);
    assert.equal(result.sampleCount, 70);
    assert.deepEqual([...result.labelsByFile.keys()], fileNames);
    assert.deepEqual([...result.labelsByFile.values()], expected.labels,
        'an archive smaller than the sample cap retains the existing complete-data fit');
    assert.equal(readCount, 140, 'training and assignment each stream the archive once');
    assert.equal(getVectorCacheStats().residentBytes, 0);
    assert.ok(Object.values(getIndex()).every(entry => entry.chatEmbedding === null));
});

test('deterministic row-bounded sampling still assigns chats beyond the reservoir', async () => {
    const { fileNames } = setup(ARCHIVE_CLUSTER_SAMPLE_LIMIT + 31);
    const first = await computeArchiveClusters({ fileNames, fixedK: 2 });
    assert.equal(first.sampleCount, ARCHIVE_CLUSTER_SAMPLE_LIMIT);
    assert.equal(first.embeddedCount, fileNames.length);
    assert.ok(first.labelsByFile.has(fileNames.at(-1)));
    const second = await computeArchiveClusters({ fileNames, fixedK: 2 });
    assert.deepEqual([...second.labelsByFile], [...first.labelsByFile]);
    assert.equal(getVectorCacheStats().residentBytes, 0);
});

test('high-dimensional sampling respects the 8 MiB payload budget and full coverage', async () => {
    const dimensions = 4096;
    const byteLimitedRows = Math.floor(ARCHIVE_CLUSTER_SAMPLE_BYTES / (dimensions * Float32Array.BYTES_PER_ELEMENT));
    const { fileNames } = setup(byteLimitedRows + 17, dimensions);
    const result = await computeArchiveClusters({ fileNames, fixedK: 1 });
    assert.equal(result.sampleCount, byteLimitedRows);
    assert.ok(result.sampleCount < ARCHIVE_CLUSTER_SAMPLE_LIMIT);
    assert.ok(result.sampleCount * dimensions * Float32Array.BYTES_PER_ELEMENT <= ARCHIVE_CLUSTER_SAMPLE_BYTES);
    assert.equal(result.embeddedCount, fileNames.length);
    assert.equal(result.clusterCount, 1);
    assert.equal(getVectorCacheStats().residentBytes, 0);
});

test('cancellation during assignment returns no partial cluster result', async () => {
    const { fileNames } = setup(70);
    const controller = new AbortController();
    readHook = count => { if (count === fileNames.length + 1) controller.abort(); };
    await assert.rejects(computeArchiveClusters({ fileNames, fixedK: 2, signal: controller.signal }), { name: 'AbortError' });
    assert.ok(readCount > fileNames.length, 'cancellation occurs during the second streaming pass');
    assert.ok(Object.values(getIndex()).every(entry => entry.clusterLabel === null));
    assert.equal(getVectorCacheStats().residentBytes, 0);
});

test('an earlier chat edited while later batches load invalidates the fit', async () => {
    const { fileNames } = setup(70);
    readHook = count => {
        if (count === 51) getIndex()[fileNames[0]].bodyEmbeddingText = 'A changed representative text';
    };
    await assert.rejects(computeArchiveClusters({ fileNames, fixedK: 2 }), { name: 'AbortError' });
    assert.ok(Object.values(getIndex()).every(entry => entry.clusterLabel === null));
});

test('changing the embedding recipe during cache reads rejects stale work', async () => {
    const { fileNames } = setup(70);
    readHook = count => { if (count === 1) setEmbeddingSettings({ model: 'replacement-model' }); };
    await assert.rejects(computeArchiveClusters({ fileNames, fixedK: 2 }),
        error => error?.name === 'AbortError' || isStaleEmbeddingOperationError(error));
    assert.ok(Object.values(getIndex()).every(entry => entry.clusterLabel === null));
});


test('UI clustering assigns and caches labels for every evicted chat', async () => {
    const { fileNames } = setup(70);
    for (const entry of Object.values(getIndex())) entry.cachedChatEmbeddingHash = hashEmbeddingText(entry.bodyEmbeddingText);
    const { recomputeEmbeddingClusters } = await import('../src/ui-controller.js');
    const first = await recomputeEmbeddingClusters({ fixedK: 2 });
    assert.equal(first.embeddedCount, fileNames.length);
    assert.equal(first.clusterCount, 2);
    assert.ok(fileNames.every(fileName => Number.isInteger(getIndex()[fileName].clusterLabel)));
    assert.equal(getVectorCacheStats().residentBytes, 0);
    const previousReads = readCount;
    const second = await recomputeEmbeddingClusters({ fixedK: 2 });
    assert.equal(second.cached, true);
    assert.equal(readCount, previousReads);
});
