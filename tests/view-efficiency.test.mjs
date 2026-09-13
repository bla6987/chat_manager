import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcicleData, reLayoutSubtree } from '../src/icicle-data.js';
import { getGridCellAtPoint, selectTopStable } from '../src/view-efficiency-utils.js';

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
    assert.deepEqual(rootMessage.chatEmbedding, [4 / 3, 4 / 3]);
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
