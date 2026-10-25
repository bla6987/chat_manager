import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildIcicleData, reLayoutSubtree } from '../src/icicle-data.js';
import { getGridCellAtPoint, selectTopStable } from '../src/view-efficiency-utils.js';
import { computePcaBasisAsync, projectVectorToPca } from '../src/semantic-engine.js';
import { isVector } from '../src/vector-utils.js';
import { createMessageDescriptor, normalizedMessageFingerprint, messagePreview } from '../src/message-descriptors.js';

test('bounded selection matches stable descending full sort including ties', () => {
    const items = [3, 9, 9, -1, 8, 9, 2].map((similarity, index) => ({ similarity, index }));
    const expected = [...items].sort((a, b) => b.similarity - a.similarity).slice(0, 4);
    assert.deepEqual(selectTopStable(items, 4), expected);
});

test('heatmap coordinate lookup rejects gaps and resolves column-major cells', () => {
    const cells = Array.from({ length: 14 }, (_, index) => ({ index }));
    const grid = { originX: 28, originY: 16, step: 15, cellSize: 13, rows: 7, columns: 2 };
    assert.equal(getGridCellAtPoint(cells, grid, 29, 17).index, 0);
    assert.equal(getGridCellAtPoint(cells, grid, 44, 47).index, 9);
    assert.equal(getGridCellAtPoint(cells, grid, 42.5, 17), null, 'horizontal gap is not a day');
    assert.equal(getGridCellAtPoint(cells, grid, 29, 30.5), null, 'vertical gap is not a day');
    assert.equal(getGridCellAtPoint(cells, grid, 100, 20), null);
});

test('icicle aggregation preserves membership, pooling, cluster ties, and active layout', async () => {
    const message = (text, role = 'assistant') => ({ text, role, timestamp: null });
    const index = {
        a: { isLoaded: true, messages: [message('root'), message('left')], chatEmbedding: [2, 0], clusterLabel: 4 },
        b: { isLoaded: true, messages: [message('root'), message('right')], chatEmbedding: [0, 2], clusterLabel: 7 },
        c: { isLoaded: true, messages: [message('root'), message('right')], chatEmbedding: [2, 2], clusterLabel: 7 },
    };
    const data = await buildIcicleData(index, 'a', { threadFocus: false });
    const rootMessage = data.flatNodes.find(node => node.depth === 0);
    assert.deepEqual(rootMessage.chatFiles, ['a', 'b', 'c']);
    assert.equal(rootMessage.chatFiles.includes('b'), true);
    assert.equal(rootMessage.chatEmbedding, null, 'aggregates do not retain high-dimensional vectors');
    assert.equal(rootMessage.pca3d, null, 'structural mode does not compute PCA');
    assert.equal(rootMessage.clusterLabel, 7);
    const children = [...rootMessage.children.values()];
    assert.equal(children[0].normalizedText, 'left', 'active branch retains layout priority');
    assert.equal(rootMessage.chatFiles, data.root.chatFiles, 'unbranched prefix nodes share membership storage');
    const relaid = reLayoutSubtree(rootMessage, 'a');
    assert.equal(relaid.flatNodes[0], rootMessage);
});

test('semantic worker no longer allocates the unused per-iteration distance buffer', async () => {
    const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../src/semantic-map-worker.js', import.meta.url), 'utf8'));
    assert.doesNotMatch(source, /new Float64Array\(n\).*\bdist\b/s);
    assert.doesNotMatch(source, /dist\[i\]\s*=\s*bestDist/);
});

test('icicle branch identity survives body eviction even when previews are identical', async () => {
    const prefix = 'shared preview '.repeat(20);
    const message = suffix => ({ index: 0, role: 'assistant', text: prefix + suffix });
    const index = {
        a: { isLoaded: true, messages: [message('first ending')] },
        b: { isLoaded: true, messages: [message('second ending')] },
        c: { isLoaded: true, messages: [message('first   ending')] },
    };
    const resident = await buildIcicleData(index, 'a');
    assert.equal(resident.root.children.size, 2, 'full normalized identities, rather than previews, determine shared branches');
    assert.ok(resident.flatNodes.every(node => node.representative.text.length <= 160));
    const keys = [...resident.root.children.keys()];
    for (const entry of Object.values(index)) entry.messages = entry.messages.map(createMessageDescriptor);
    const evicted = await buildIcicleData(index, 'a', { previousRoot: resident.root });
    assert.deepEqual([...evicted.root.children.keys()], keys);
    assert.deepEqual(evicted.flatNodes.map(node => node.chatFiles), resident.flatNodes.map(node => node.chatFiles));
    assert.ok(evicted.flatNodes.every(node => node.chatEmbedding === null && node.pca3d === null));
});

test('icicle fits PCA only for gradient mode, caches its basis by vector revision and keeps three-coordinate aggregates', async () => {
    const raw = (await readFile(new URL('../src/icicle-data.js', import.meta.url), 'utf8'))
        .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    let fits = 0;
    const api = new Function('computePcaBasisAsync', 'projectVectorToPca', 'isVector', 'normalizedMessageFingerprint', 'truncateMessagePreview',
        `${raw};return { buildIcicleData, clearIcicleSemanticCache };`)(
        async (...args) => { fits++; return computePcaBasisAsync(...args); }, projectVectorToPca, isVector, normalizedMessageFingerprint, messagePreview);
    const messages = branch => [{ index: 0, role: 'user', text: 'shared' }, { index: 1, role: 'assistant', text: branch }];
    const index = {
        a: { isLoaded: true, messages: messages('left'), chatEmbedding: new Float32Array([1, 0, 0]), clusterLabel: 1 },
        b: { isLoaded: true, messages: messages('right'), chatEmbedding: new Float32Array([0, 2, 0]), clusterLabel: 2 },
        c: { isLoaded: true, messages: messages('left'), chatEmbedding: new Float32Array([4, 1, 1]), clusterLabel: 1 },
    };
    for (const colorMode of ['structural', 'cluster']) {
        const data = await api.buildIcicleData(index, 'a', { colorMode });
        assert.ok(data.flatNodes.every(node => node.pca3d === null));
    }
    assert.equal(fits, 0);
    const gradient = await api.buildIcicleData(index, 'a', { colorMode: 'gradient', embeddingRevision: 1 });
    await api.buildIcicleData(index, 'a', { colorMode: 'gradient', embeddingRevision: 1 });
    assert.equal(fits, 1, 'unchanged vectors reuse one small basis');
    const basis = await computePcaBasisAsync(Object.values(index).map(entry => entry.chatEmbedding), { components: 3 });
    const left = gradient.flatNodes.find(node => node.normalizedText === 'left');
    const a = projectVectorToPca(index.a.chatEmbedding, basis), c = projectVectorToPca(index.c.chatEmbedding, basis);
    for (let axis = 0; axis < 3; axis++) assert.ok(Math.abs(left.pca3d[axis] - (a[axis] + c[axis]) / 2) < 1e-9);
    assert.ok(gradient.flatNodes.every(node => node.chatEmbedding === null && node.pca3d.length === 3));
    await api.buildIcicleData(index, 'a', { colorMode: 'gradient', embeddingRevision: 2 });
    assert.equal(fits, 2);
    index.a.chatEmbedding = new Float32Array([3, 0, 0]);
    await api.buildIcicleData(index, 'a', { colorMode: 'gradient', embeddingRevision: 2 });
    assert.equal(fits, 3, 'replaced vectors invalidate without rescanning every coordinate');
    api.clearIcicleSemanticCache();
    await api.buildIcicleData(index, 'a', { colorMode: 'gradient', embeddingRevision: 2 });
    assert.equal(fits, 4, 'view teardown releases the shared basis');
});

test('icicle gradient projects every persisted chat from a bounded sample and reuses only basis/coordinate data', async () => {
    const raw = (await readFile(new URL('../src/icicle-data.js', import.meta.url), 'utf8'))
        .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    const fitSizes = [];
    const api = new Function('computePcaBasisAsync', 'projectVectorToPca', 'isVector', 'normalizedMessageFingerprint', 'truncateMessagePreview',
        `${raw};return { buildIcicleData, clearIcicleSemanticCache, cache:()=>semanticBasisCache };`)(
        async (vectors, options) => { fitSizes.push(vectors.length); return computePcaBasisAsync(vectors, options); },
        projectVectorToPca, isVector, normalizedMessageFingerprint, messagePreview);
    const index = Object.fromEntries(Array.from({ length: 1300 }, (_, i) => [`chat${i}`, {
        isLoaded: true, chatEmbedding: null,
        messages: [createMessageDescriptor({ index: 0, role: 'assistant', text: `branch ${i}` })],
    }]));
    let calls = 0, recipeKey = 'first';
    const iterateChatVectors = async function* ({ fileNames }) {
        calls++;
        for (const fileName of fileNames) {
            const i = Number(fileName.slice(4));
            yield { fileName, hash: `${i}`, recipeKey, epoch: 1,
                vector: new Float32Array([Math.cos(i), Math.sin(i), i % 7, 1]) };
        }
    };
    await api.buildIcicleData(index, 'chat0', { colorMode: 'cluster', iterateChatVectors });
    assert.equal(calls, 0, 'cluster and structural modes do not hydrate gradient inputs');
    const data = await api.buildIcicleData(index, 'chat0', { colorMode: 'gradient', iterateChatVectors });
    assert.equal(data.flatNodes.length, 1300);
    assert.ok(data.flatNodes.every(node => node.pca3d?.length === 3 && node.chatEmbedding === null));
    assert.deepEqual(fitSizes, [1024]);
    assert.equal(calls, 2, 'first scan samples, second scan projects the entire archive');
    assert.equal(api.cache().projections.size, 1300);
    assert.ok([...api.cache().projections.values()].every(point => point.length === 3));
    await api.buildIcicleData(index, 'chat0', { colorMode: 'gradient', iterateChatVectors });
    assert.deepEqual(fitSizes, [1024]);
    assert.equal(calls, 3, 'stable archive identities reuse the basis and per-chat coordinates');
    recipeKey = 'second';
    await api.buildIcicleData(index, 'chat0', { colorMode: 'gradient', iterateChatVectors });
    assert.deepEqual(fitSizes, [1024, 1024], 'same-dimensional provider changes invalidate cached colors');
    api.clearIcicleSemanticCache();
    assert.equal(api.cache(), null);
});
