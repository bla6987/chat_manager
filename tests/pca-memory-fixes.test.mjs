import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { pca3D, pca3DAsync, pca2DAsync } from '../src/semantic-engine.js';

function close(actual, expected, tolerance = 2e-6) {
    if (Array.isArray(expected)) {
        assert.ok(Array.isArray(actual));
        assert.equal(actual.length, expected.length);
        expected.forEach((value, i) => close(actual[i], value, tolerance));
    } else {
        assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
    }
}

const fixtures = {
    empty: [],
    single: [[3, 4, 5]],
    identical: Array.from({ length: 8 }, () => [4, -2, 7, 0]),
    constantLeadingAxis: Array.from({ length: 25 }, (_, i) => [12, i * 0.7, Math.sin(i), Math.cos(i * 2)]),
    rankOne: Array.from({ length: 13 }, (_, i) => [2 * i, -i, 3 * i, 0]),
    tiedAxes: [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    fullRank: Array.from({ length: 41 }, (_, i) => Array.from({ length: 19 }, (_, d) => Math.sin(i * (d + 1) * 0.19) + Math.cos(i * 0.17) * (d + 1))),
};
for (const [name, vectors] of Object.entries(fixtures)) {
    test(`matrix-free PCA preserves synchronous PCA: ${name}`, async () => {
        const original = structuredClone(vectors);
        const result = await pca3DAsync(vectors);
        const reference = pca3D(vectors);
        close(result.mean, reference.mean);
        close(result.components, reference.components);
        close(result.projected, reference.projected);
        assert.deepEqual(vectors, original);
        assert.deepEqual(await pca3DAsync(vectors), result);
    });
}
test('2D projection retains normal-array public shape', async () => {
    const result = await pca2DAsync(fixtures.fullRank);
    const reference = pca3D(fixtures.fullRank);
    close(result.components, reference.components.slice(0, 2));
    close(result.projected, reference.projected.map(row => row.slice(0, 2)));
});
test('wide full-data PCA yields promptly and throughout computation', async () => {
    const vectors = Array.from({ length: 128 }, (_, i) => Array.from({ length: 3072 }, (_, d) =>
        Math.sin(i * 0.13) * Math.cos(d * 0.1) + 0.3 * Math.cos(i * 0.27) * Math.sin(d * 0.17)));
    const started = performance.now();
    let firstTick = null;
    let ticks = 0;
    const timer = setInterval(() => { firstTick ??= performance.now() - started; ticks++; }, 0);
    try {
        const pending = pca3DAsync(vectors);
        const initialBlock = performance.now() - started;
        const result = await pending;
        assert.ok(initialBlock < 150, `initial blocking ${initialBlock}ms`);
        assert.ok(firstTick < 150, `first timer ${firstTick}ms`);
        assert.ok(ticks >= 3, `only ${ticks} timer turns`);
        assert.equal(result.projected.length, vectors.length);
        assert.ok(result.projected.flat().every(Number.isFinite));
    } finally { clearInterval(timer); }
});
test('PCA allocations scale with dimensions, without centered rows or covariance rows', async () => {
    const dims = 512;
    const source = (await fs.readFile(new URL('../src/semantic-engine.js', import.meta.url), 'utf8')).replace(/export /g, '');
    let dimensionAllocations = 0;
    const TrackedArray = new Proxy(Array, {
        construct(target, args) {
            if (args.length === 1 && args[0] === dims) dimensionAllocations++;
            return Reflect.construct(target, args);
        },
    });
    const context = vm.createContext({ Array: TrackedArray, performance, setTimeout });
    vm.runInContext(source + '\nglobalThis.runPCA = pca3DAsync;', context);
    const vectors = Array.from({ length: 64 }, (_, i) => Array.from({ length: dims }, (_, d) => i * (d + 1)));
    await context.runPCA(vectors);
    // Rank-one power iteration needs only a handful of dimension-length buffers.
    // A centered copy adds 64 and dense covariance adds 512 such allocations.
    assert.ok(dimensionAllocations < 20, `${dimensionAllocations} dimension-sized arrays`);
});
