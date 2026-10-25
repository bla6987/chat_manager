import test from 'node:test';
import assert from 'node:assert/strict';
import { ByteBudgetLRU, isVector, toFloat32Vector, vectorByteLength } from '../src/vector-utils.js';
import {
    computePcaBasis, computePcaBasisAsync, projectVectorToPca,
    pca3D, pca3DAsync, cosineSimilarity, kMeans,
} from '../src/semantic-engine.js';

test('vector conversion validates coordinates, keeps typed ownership and accounts actual bytes', () => {
    const vector = toFloat32Vector([0.1, 0.2, 0.3]);
    assert.ok(vector instanceof Float32Array);
    assert.equal(vectorByteLength(vector), 12);
    assert.equal(vectorByteLength([1, 2, 3]), 24);
    assert.equal(toFloat32Vector(vector), vector, 'already normalized vectors are not copied');
    assert.notEqual(toFloat32Vector(vector, { copy: true }), vector);
    const largeBacking = new Float32Array(4096);
    const small = toFloat32Vector(largeBacking.subarray(32, 35));
    assert.equal(small.buffer.byteLength, 12, 'a tiny stored vector does not retain a large source buffer');
    assert.notEqual(small.buffer, largeBacking.buffer);
    assert.ok(isVector(new Float64Array([1, 2])));
    assert.equal(isVector(new DataView(new ArrayBuffer(8))), false);
    assert.equal(isVector(new BigInt64Array([1n])), false);
    for (const value of [[], [Infinity], [NaN], ['1'], [1e100], null]) {
        assert.throws(() => toFloat32Vector(value), TypeError);
    }
});

test('byte LRU evicts least-recently-used vectors and releases external owners', () => {
    const external = new Map();
    const disposed = [];
    const cache = new ByteBudgetLRU({ maxBytes: 16, onEvict(key, value, reason) {
        if (external.get(key) === value) external.delete(key);
        disposed.push([key, reason]);
    } });
    const put = key => {
        const vector = new Float32Array([1, 2]);
        external.set(key, vector);
        return cache.set(key, vector);
    };
    put('a'); put('b');
    cache.get('a');
    put('c');
    assert.deepEqual([...external.keys()], ['a', 'c']);
    assert.deepEqual(disposed, [['b', 'budget']]);
    assert.equal(cache.bytes, 16);
    assert.equal(cache.size, 2);
    assert.equal(cache.set('too-large', new Float32Array(5)), false);
    assert.equal(cache.bytes, 16, 'an oversize entry does not flush useful cached vectors');
    cache.maxBytes = 8;
    assert.equal(cache.has('a'), false);
    assert.equal(cache.peek('c'), external.get('c'));
    cache.clear();
    assert.equal(external.size, 0);
    assert.equal(cache.bytes, 0);
});

test('typed vectors support cosine similarity and clustering without mutating input', () => {
    const vectors = [[1, 0], [0.9, 0.1], [0, 1], [0.1, 0.9]].map(row => new Float32Array(row));
    const original = vectors.map(row => Array.from(row));
    assert.equal(cosineSimilarity(vectors[0], vectors[2]), 0);
    const result = kMeans(vectors, 2);
    assert.equal(result.labels[0], result.labels[1]);
    assert.equal(result.labels[2], result.labels[3]);
    assert.notEqual(result.labels[0], result.labels[2]);
    assert.deepEqual(vectors.map(row => Array.from(row)), original);
});

test('matrix-free PCA recovers analytic variance and exposes a reusable basis', async () => {
    const rows = [[0, -3, -1], [0, -3, 1], [0, 3, -1], [0, 3, 1]].map(row => new Float32Array(row));
    const basis = computePcaBasis(rows);
    assert.ok(basis.mean instanceof Float64Array);
    assert.ok(basis.components.every(row => row instanceof Float64Array));
    const sync = pca3D(rows);
    const asyncResult = await pca3DAsync(rows);
    assert.deepEqual(asyncResult, sync);
    assert.deepEqual(rows.map(row => projectVectorToPca(row, basis)), sync.projected);
    assert.deepEqual(sync.projected.map(row => row[0]), [-3, -3, 3, 3]);
    assert.deepEqual(sync.projected.map(row => row[1]), [-1, 1, -1, 1]);
    assert.ok(sync.projected.every(row => row[2] === 0));
    assert.throws(() => projectVectorToPca([1, 2], basis), /dimensions/);
});

test('large embedding dimensions do not require a quadratic covariance allocation', () => {
    // A dense covariance matrix here would contain over a billion doubles.
    const dims = 32768;
    const rows = [-2, -1, 1, 2].map(value => {
        const row = new Float32Array(dims);
        row[dims - 1] = value;
        return row;
    });
    const result = pca3D(rows);
    assert.deepEqual(result.projected.map(row => row[0]), [-2, -1, 1, 2]);
    assert.ok(result.projected.every(row => row[1] === 0 && row[2] === 0));
    const retainedBytes = result.mean.byteLength + result.components.reduce((sum, row) => sum + row.byteLength, 0);
    assert.equal(retainedBytes, dims * 8 * 4);
});

test('async PCA yields for cancellation without modifying its input vectors', async () => {
    const controller = new AbortController();
    const rows = Array.from({ length: 512 }, (_, i) => Float32Array.from({ length: 128 }, (_, d) => Math.sin(i * 0.17 + d * 0.31)));
    const first = rows[0].slice();
    const abort = setTimeout(() => controller.abort(), 0);
    try {
        await assert.rejects(computePcaBasisAsync(rows, { signal: controller.signal }), { name: 'AbortError' });
    } finally {
        clearTimeout(abort);
    }
    assert.deepEqual(rows[0], first);
});
