/**
 * Semantic Engine — pure vector math for clustering, dimensionality reduction, and coloring.
 */

import { isVector } from './vector-utils.js';

const EPSILON = 1e-12;
const CONVERGENCE_THRESHOLD = 1e-6;
const POWER_ITER_MAX = 200;
const POWER_ITER_TOL = 1e-7;

const PALETTE = [
    '#E05252', '#5294E0', '#52B788', '#E0A052',
    '#9B72CF', '#52BFB8', '#CF7298', '#7E8C4A',
];

/**
 * @param {number[][]} vectors
 * @returns {number}
 */
function validateVectors(vectors) {
    if (!Array.isArray(vectors)) {
        throw new Error('Expected vectors to be an array.');
    }
    if (vectors.length === 0) return 0;
    const dims = isVector(vectors[0]) ? vectors[0].length : 0;
    if (dims === 0) throw new Error('Vectors must contain at least one dimension.');
    for (let i = 0; i < vectors.length; i++) {
        const v = vectors[i];
        if (!isVector(v) || v.length !== dims) {
            throw new Error(`Vector dimension mismatch at index ${i}.`);
        }
    }
    return dims;
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

/**
 * @param {number[]} vector
 * @returns {number}
 */
function norm(vector) {
    return Math.sqrt(dot(vector, vector));
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
function squaredEuclideanDistance(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
    }
    return sum;
}

/**
 * @param {number} seed
 * @returns {() => number}
 */
function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Deterministic seed derived from input vectors.
 * @param {number[][]} vectors
 * @param {number} k
 * @returns {number}
 */
function seedFromVectors(vectors, k) {
    let hash = (0x811c9dc5 ^ k) >>> 0;
    const maxRows = Math.min(vectors.length, 64);
    for (let i = 0; i < maxRows; i++) {
        const row = vectors[i];
        const maxCols = Math.min(row.length, 32);
        for (let j = 0; j < maxCols; j++) {
            const quantized = Math.round(row[j] * 1e6) | 0;
            hash ^= quantized;
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
    }
    return hash >>> 0;
}

/**
 * @param {number[][]} vectors
 * @param {number} k
 * @returns {number[][]}
 */
function initializeKMeansPlusPlus(vectors, k) {
    const n = vectors.length;
    const rng = mulberry32(seedFromVectors(vectors, k));
    const centroids = [];
    const minDistSq = new Float64Array(n);

    const firstIndex = Math.floor(rng() * n);
    centroids.push(vectors[firstIndex].slice());
    minDistSq.fill(Infinity);

    for (let c = 1; c < k; c++) {
        let total = 0;
        const prevCentroid = centroids[c - 1];
        for (let i = 0; i < n; i++) {
            const d = squaredEuclideanDistance(vectors[i], prevCentroid);
            if (d < minDistSq[i]) minDistSq[i] = d;
            total += minDistSq[i];
        }

        let nextIndex = -1;
        if (total <= EPSILON) {
            nextIndex = Math.floor(rng() * n);
        } else {
            const target = rng() * total;
            let cumulative = 0;
            for (let i = 0; i < n; i++) {
                cumulative += minDistSq[i];
                if (cumulative >= target) {
                    nextIndex = i;
                    break;
                }
            }
            if (nextIndex < 0) nextIndex = n - 1;
        }

        centroids.push(vectors[nextIndex].slice());
    }

    return centroids;
}

/**
 * Cosine similarity in [-1, 1].
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
    if (!isVector(a) || !isVector(b) || a.length !== b.length) {
        throw new Error('cosineSimilarity requires two vectors with equal non-zero dimensions.');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        const ai = a[i];
        const bi = b[i];
        dotProduct += ai * bi;
        normA += ai * ai;
        normB += bi * bi;
    }

    if (normA <= EPSILON || normB <= EPSILON) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * k-means clustering with k-means++ initialization.
 * @param {number[][]} vectors
 * @param {number} k
 * @param {number} [maxIter=50]
 * @returns {{ labels: number[], centroids: number[][], inertia: number }}
 */
export function kMeans(vectors, k, maxIter = 50) {
    const dims = validateVectors(vectors);
    const n = vectors.length;

    if (n === 0 || k <= 0) {
        return { labels: [], centroids: [], inertia: 0 };
    }

    const clusterCount = Math.min(Math.floor(k), n);
    const centroids = initializeKMeansPlusPlus(vectors, clusterCount);
    const labels = new Array(n).fill(0);

    let inertia = 0;
    for (let iter = 0; iter < Math.max(1, Math.floor(maxIter)); iter++) {
        inertia = 0;
        const counts = new Array(clusterCount).fill(0);
        const sums = new Array(clusterCount);
        const pointDist = new Float64Array(n);

        for (let c = 0; c < clusterCount; c++) {
            sums[c] = new Float64Array(dims);
        }

        // Assignment step.
        for (let i = 0; i < n; i++) {
            let bestLabel = 0;
            let bestDist = Infinity;
            for (let c = 0; c < clusterCount; c++) {
                const d = squaredEuclideanDistance(vectors[i], centroids[c]);
                if (d < bestDist) {
                    bestDist = d;
                    bestLabel = c;
                }
            }
            labels[i] = bestLabel;
            pointDist[i] = bestDist;
            inertia += bestDist;
            counts[bestLabel] += 1;

            const target = sums[bestLabel];
            const row = vectors[i];
            for (let d = 0; d < dims; d++) {
                target[d] += row[d];
            }
        }

        // Update step + empty-cluster recovery.
        let maxShiftSq = 0;
        for (let c = 0; c < clusterCount; c++) {
            if (counts[c] === 0) {
                let farthestIndex = 0;
                let farthestDist = -1;
                for (let i = 0; i < n; i++) {
                    if (pointDist[i] > farthestDist) {
                        farthestDist = pointDist[i];
                        farthestIndex = i;
                    }
                }
                centroids[c] = vectors[farthestIndex].slice();
                continue;
            }

            const next = new Array(dims);
            for (let d = 0; d < dims; d++) {
                next[d] = sums[c][d] / counts[c];
            }
            const shiftSq = squaredEuclideanDistance(centroids[c], next);
            if (shiftSq > maxShiftSq) maxShiftSq = shiftSq;
            centroids[c] = next;
        }

        if (maxShiftSq < CONVERGENCE_THRESHOLD * CONVERGENCE_THRESHOLD) {
            break;
        }
    }

    return { labels, centroids, inertia };
}

/**
 * Kneedle-style elbow detection over inertia curve.
 * @param {number[][]} vectors
 * @param {number} [maxK=8]
 * @returns {number}
 */
export function findOptimalK(vectors, maxK = 8) {
    const n = Array.isArray(vectors) ? vectors.length : 0;
    if (n <= 1) return 1;

    validateVectors(vectors);

    const lowerK = 2;
    const upperK = Math.max(lowerK, Math.min(Math.floor(maxK), n));
    if (upperK === lowerK) return lowerK;

    const ks = [];
    const inertias = [];
    for (let k = lowerK; k <= upperK; k++) {
        const result = kMeans(vectors, k, 50);
        ks.push(k);
        inertias.push(result.inertia);
    }

    if (inertias.length < 3) {
        return ks[0];
    }

    const minInertia = Math.min(...inertias);
    const maxInertia = Math.max(...inertias);
    const span = maxInertia - minInertia;
    if (span <= EPSILON) {
        return Math.min(5, Math.ceil(n / 3));
    }

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 1; i < ks.length - 1; i++) {
        const x = i / (ks.length - 1); // normalized k position
        const y = (inertias[i] - minInertia) / span; // normalized inertia
        const score = (1 - x) - y; // distance from linear decay line
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestIdx < 0 || bestScore < 0.02) {
        return Math.min(5, Math.ceil(n / 3));
    }
    return ks[bestIdx];
}

/** Throw cancellation consistently in both synchronous and async PCA. */
function assertPcaActive(signal) {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === 'function') signal.throwIfAborted();
    const error = new Error('PCA operation aborted.');
    error.name = 'AbortError';
    throw error;
}

/**
 * Calculate a PCA basis without a centered copy or a D-by-D covariance matrix.
 * Covariance multiplication is C*v = Xc' * (Xc*v) / (N-1), evaluated one row
 * at a time. Only the mean, output components and a few D-length work buffers
 * are retained, independently of the number of input vectors.
 *
 * The generator shares the exact same numerical path between sync and async
 * callers; row checkpoints allow the async driver to yield and cancel promptly.
 */
function* pcaBasisSteps(vectors, { components: requested = 3, signal } = {}) {
    assertPcaActive(signal);
    const dims = validateVectors(vectors);
    const n = vectors.length;
    if (!n) return { mean: new Float64Array(0), components: [] };
    const outputCount = Math.max(1, Math.min(3, Math.floor(Number(requested) || 3)));
    const componentCount = Math.min(dims, outputCount);
    const rowsPerCheckpoint = Math.max(1, Math.floor(32768 / dims));
    const mean = new Float64Array(dims);
    const components = [];
    const variances = new Float64Array(dims);
    const projections = new Float64Array(componentCount);
    let v = new Float64Array(dims);
    let w = new Float64Array(dims);
    const scale = 1 / Math.max(1, n - 1);

    for (let i = 0; i < n; i++) {
        const row = vectors[i];
        for (let d = 0; d < dims; d++) {
            if (!Number.isFinite(row[d])) throw new TypeError('PCA coordinates must be finite numbers.');
            mean[d] += row[d];
        }
        if ((i + 1) % rowsPerCheckpoint === 0) {
            assertPcaActive(signal);
            yield;
        }
    }
    for (let d = 0; d < dims; d++) mean[d] /= n;

    function* covarianceMultiply(input, output) {
        output.fill(0);
        for (let i = 0; i < n; i++) {
            const row = vectors[i];
            let projection = 0;
            for (let d = 0; d < dims; d++) projection += (row[d] - mean[d]) * input[d];
            for (let d = 0; d < dims; d++) output[d] += (row[d] - mean[d]) * projection;
            if ((i + 1) % rowsPerCheckpoint === 0) {
                assertPcaActive(signal);
                yield;
            }
        }
        for (let d = 0; d < dims; d++) output[d] *= scale;
    }

    for (let c = 0; c < componentCount; c++) {
        assertPcaActive(signal);
        // Pick a coordinate with residual variance, including when leading
        // coordinates are constant or earlier components exhausted the rank.
        variances.fill(0);
        for (let i = 0; i < n; i++) {
            const row = vectors[i];
            for (let p = 0; p < components.length; p++) {
                let projection = 0;
                for (let d = 0; d < dims; d++) projection += (row[d] - mean[d]) * components[p][d];
                projections[p] = projection;
            }
            for (let d = 0; d < dims; d++) {
                let residual = row[d] - mean[d];
                for (let p = 0; p < components.length; p++) residual -= projections[p] * components[p][d];
                variances[d] += residual * residual;
            }
            if ((i + 1) % rowsPerCheckpoint === 0) {
                assertPcaActive(signal);
                yield;
            }
        }
        let seed = 0;
        for (let d = 1; d < dims; d++) if (variances[d] > variances[seed]) seed = d;
        if (variances[seed] * scale <= EPSILON) break;
        v.fill(0);
        v[seed] = 1;
        for (const component of components) {
            const projection = dot(v, component);
            for (let d = 0; d < dims; d++) v[d] -= projection * component[d];
        }
        const seedNorm = norm(v);
        if (!Number.isFinite(seedNorm) || seedNorm <= EPSILON) break;
        for (let d = 0; d < dims; d++) v[d] /= seedNorm;

        for (let iter = 0; iter < POWER_ITER_MAX; iter++) {
            yield* covarianceMultiply(v, w);
            for (const component of components) {
                const projection = dot(w, component);
                for (let d = 0; d < dims; d++) w[d] -= projection * component[d];
            }
            const wNorm = norm(w);
            if (!Number.isFinite(wNorm) || wNorm <= EPSILON) break;
            let diff = 0;
            for (let d = 0; d < dims; d++) {
                w[d] /= wNorm;
                const delta = w[d] - v[d];
                diff += delta * delta;
            }
            [v, w] = [w, v];
            if (diff <= POWER_ITER_TOL * POWER_ITER_TOL) break;
        }
        yield* covarianceMultiply(v, w);
        if (dot(v, w) <= EPSILON) break;
        components.push(v.slice());
    }
    while (components.length < outputCount) components.push(new Float64Array(dims));
    assertPcaActive(signal);
    return { mean, components };
}

/** Reusable PCA basis; working memory is O(D * componentCount). */
export function computePcaBasis(vectors, options = {}) {
    const steps = pcaBasisSteps(vectors, options);
    let step = steps.next();
    while (!step.done) step = steps.next();
    return step.value;
}

/** Async basis calculation with an ~8 ms work slice and cancellation support. */
export async function computePcaBasisAsync(vectors, options = {}) {
    const steps = pcaBasisSteps(vectors, options);
    let deadline = Date.now() + 8;
    let step = steps.next();
    while (!step.done) {
        if (Date.now() >= deadline) {
            await yieldToEventLoop();
            assertPcaActive(options.signal);
            deadline = Date.now() + 8;
        }
        step = steps.next();
    }
    return step.value;
}

/** Project one vector without allocating a centered high-dimensional copy. */
export function projectVectorToPca(vector, basis) {
    if (!isVector(vector) || vector.length !== basis.mean.length) {
        throw new Error('PCA projection requires a vector matching the basis dimensions.');
    }
    const projected = new Array(basis.components.length).fill(0);
    for (let c = 0; c < basis.components.length; c++) {
        const component = basis.components[c];
        for (let d = 0; d < vector.length; d++) projected[c] += (vector[d] - basis.mean[d]) * component[d];
    }
    return projected;
}

/** PCA projection to three dimensions, without allocating a covariance matrix. */
export function pca3D(vectors, options = {}) {
    const basis = computePcaBasis(vectors, { ...options, components: 3 });
    return { projected: vectors.map(vector => projectVectorToPca(vector, basis)), ...basis };
}

/**
 * @param {number} value
 * @returns {number}
 */
function clamp01(value) {
    if (!Number.isFinite(value)) return 0.5;
    return Math.max(0, Math.min(1, value));
}

/**
 * @param {number} value
 * @param {[number, number]} range
 * @returns {number}
 */
function normalizeToUnit(value, range) {
    const min = Number.isFinite(range?.[0]) ? range[0] : -1;
    const max = Number.isFinite(range?.[1]) ? range[1] : 1;
    const span = max - min;
    if (Math.abs(span) <= EPSILON) return 0.5;
    return clamp01((value - min) / span);
}

/**
 * Returns a stable color for a cluster index.
 * @param {number} clusterIdx
 * @returns {string}
 */
export function clusterColor(clusterIdx) {
    const idx = Number.isFinite(clusterIdx) ? Math.floor(clusterIdx) : 0;
    const normalized = ((idx % PALETTE.length) + PALETTE.length) % PALETTE.length;
    return PALETTE[normalized];
}

/**
 * Map 3D PCA coordinates into an HSL color.
 * Optional ranges let callers provide dataset-based normalization per axis.
 * @param {number[]} pca3dVector
 * @param {{ x?: [number, number], y?: [number, number], z?: [number, number] }} [ranges]
 * @returns {string}
 */
export function gradientColor(pca3dVector, ranges = {}) {
    const x = normalizeToUnit(pca3dVector?.[0] ?? 0, ranges.x || [-1, 1]);
    const y = normalizeToUnit(pca3dVector?.[1] ?? 0, ranges.y || [-1, 1]);
    const z = normalizeToUnit(pca3dVector?.[2] ?? 0, ranges.z || [-1, 1]);

    const hue = Math.round(x * 330);
    const saturation = Math.round((55 + (y * 30)) * 10) / 10;
    const lightness = Math.round((42 + (z * 18)) * 10) / 10;
    return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

const YIELD_INTERVAL = 5;
const yieldToEventLoop = () => new Promise(r => setTimeout(r, 0));

/**
 * Async k-means — same logic as kMeans but yields every YIELD_INTERVAL iterations.
 * @param {number[][]} vectors
 * @param {number} k
 * @param {number} [maxIter=50]
 * @returns {Promise<{ labels: number[], centroids: number[][], inertia: number }>}
 */
export async function kMeansAsync(vectors, k, maxIter = 50) {
    const dims = validateVectors(vectors);
    const n = vectors.length;

    if (n === 0 || k <= 0) {
        return { labels: [], centroids: [], inertia: 0 };
    }

    const clusterCount = Math.min(Math.floor(k), n);
    const centroids = initializeKMeansPlusPlus(vectors, clusterCount);
    const labels = new Array(n).fill(0);

    let inertia = 0;
    for (let iter = 0; iter < Math.max(1, Math.floor(maxIter)); iter++) {
        if (iter > 0 && iter % YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }

        inertia = 0;
        const counts = new Array(clusterCount).fill(0);
        const sums = new Array(clusterCount);
        const pointDist = new Float64Array(n);

        for (let c = 0; c < clusterCount; c++) {
            sums[c] = new Float64Array(dims);
        }

        for (let i = 0; i < n; i++) {
            let bestLabel = 0;
            let bestDist = Infinity;
            for (let c = 0; c < clusterCount; c++) {
                const d = squaredEuclideanDistance(vectors[i], centroids[c]);
                if (d < bestDist) {
                    bestDist = d;
                    bestLabel = c;
                }
            }
            labels[i] = bestLabel;
            pointDist[i] = bestDist;
            inertia += bestDist;
            counts[bestLabel] += 1;

            const target = sums[bestLabel];
            const row = vectors[i];
            for (let d = 0; d < dims; d++) {
                target[d] += row[d];
            }
        }

        let maxShiftSq = 0;
        for (let c = 0; c < clusterCount; c++) {
            if (counts[c] === 0) {
                let farthestIndex = 0;
                let farthestDist = -1;
                for (let i = 0; i < n; i++) {
                    if (pointDist[i] > farthestDist) {
                        farthestDist = pointDist[i];
                        farthestIndex = i;
                    }
                }
                centroids[c] = vectors[farthestIndex].slice();
                continue;
            }

            const next = new Array(dims);
            for (let d = 0; d < dims; d++) {
                next[d] = sums[c][d] / counts[c];
            }
            const shiftSq = squaredEuclideanDistance(centroids[c], next);
            if (shiftSq > maxShiftSq) maxShiftSq = shiftSq;
            centroids[c] = next;
        }

        if (maxShiftSq < CONVERGENCE_THRESHOLD * CONVERGENCE_THRESHOLD) {
            break;
        }
    }

    return { labels, centroids, inertia };
}

/**
 * Async findOptimalK — yields between k values.
 * @param {number[][]} vectors
 * @param {number} [maxK=8]
 * @returns {Promise<number>}
 */
export async function findOptimalKAsync(vectors, maxK = 8) {
    const n = Array.isArray(vectors) ? vectors.length : 0;
    if (n <= 1) return 1;

    validateVectors(vectors);

    const lowerK = 2;
    const upperK = Math.max(lowerK, Math.min(Math.floor(maxK), n));
    if (upperK === lowerK) return lowerK;

    const ks = [];
    const inertias = [];
    for (let k = lowerK; k <= upperK; k++) {
        const result = await kMeansAsync(vectors, k, 50);
        ks.push(k);
        inertias.push(result.inertia);
        await yieldToEventLoop();
    }

    if (inertias.length < 3) {
        return ks[0];
    }

    const minInertia = Math.min(...inertias);
    const maxInertia = Math.max(...inertias);
    const span = maxInertia - minInertia;
    if (span <= EPSILON) {
        return Math.min(5, Math.ceil(n / 3));
    }

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 1; i < ks.length - 1; i++) {
        const x = i / (ks.length - 1);
        const y = (inertias[i] - minInertia) / span;
        const score = (1 - x) - y;
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }

    if (bestIdx < 0 || bestScore < 0.02) {
        return Math.min(5, Math.ceil(n / 3));
    }
    return ks[bestIdx];
}

/** Project all points while keeping browser tasks responsive. */
async function projectPcaAsync(vectors, basis, signal) {
    const projected = new Array(vectors.length);
    let deadline = Date.now() + 8;
    const rowsPerCheckpoint = Math.max(1, Math.floor(32768 / Math.max(1, basis.mean.length)));
    for (let i = 0; i < vectors.length; i++) {
        projected[i] = projectVectorToPca(vectors[i], basis);
        if ((i + 1) % rowsPerCheckpoint === 0 && Date.now() >= deadline) {
            await yieldToEventLoop();
            assertPcaActive(signal);
            deadline = Date.now() + 8;
        }
    }
    assertPcaActive(signal);
    return projected;
}

/** Async matrix-free PCA projection to three dimensions. */
export async function pca3DAsync(vectors, options = {}) {
    const basis = await computePcaBasisAsync(vectors, { ...options, components: 3 });
    return { projected: await projectPcaAsync(vectors, basis, options.signal), ...basis };
}

/** Async matrix-free PCA projection to two dimensions. */
export async function pca2DAsync(vectors, options = {}) {
    const basis = await computePcaBasisAsync(vectors, { ...options, components: 2 });
    return { projected: await projectPcaAsync(vectors, basis, options.signal), ...basis };
}

/**
 * Mini-batch k-means optimized for larger datasets.
 * @param {number[][]} vectors
 * @param {number} k
 * @param {{ batchSize?: number, maxIter?: number }} [opts]
 * @returns {Promise<{ labels: number[], centroids: number[][], inertia: number }>}
 */
export async function miniBatchKMeansAsync(vectors, k, opts = {}) {
    const dims = validateVectors(vectors);
    const n = vectors.length;
    if (n === 0 || k <= 0) {
        return { labels: [], centroids: [], inertia: 0 };
    }

    const clusterCount = Math.min(Math.max(1, Math.floor(k)), n);
    const batchSize = Math.max(64, Math.min(n, Math.floor(opts.batchSize ?? 1024)));
    const maxIter = Math.max(1, Math.floor(opts.maxIter ?? 100));
    const rng = mulberry32(seedFromVectors(vectors, clusterCount ^ batchSize));
    const centroids = initializeKMeansPlusPlus(vectors, clusterCount);
    const seenCounts = new Array(clusterCount).fill(0);

    for (let iter = 0; iter < maxIter; iter++) {
        const start = Math.floor(rng() * n);
        for (let b = 0; b < batchSize; b++) {
            const idx = (start + b) % n;
            const row = vectors[idx];
            let bestLabel = 0;
            let bestDist = Infinity;
            for (let c = 0; c < clusterCount; c++) {
                const d = squaredEuclideanDistance(row, centroids[c]);
                if (d < bestDist) {
                    bestDist = d;
                    bestLabel = c;
                }
            }

            seenCounts[bestLabel] += 1;
            const eta = 1 / seenCounts[bestLabel];
            const centroid = centroids[bestLabel];
            for (let d = 0; d < dims; d++) {
                centroid[d] = centroid[d] + eta * (row[d] - centroid[d]);
            }
        }

        if (iter > 0 && iter % YIELD_INTERVAL === 0) {
            await yieldToEventLoop();
        }
    }

    const labels = new Array(n).fill(0);
    let inertia = 0;
    for (let i = 0; i < n; i++) {
        let bestLabel = 0;
        let bestDist = Infinity;
        for (let c = 0; c < clusterCount; c++) {
            const d = squaredEuclideanDistance(vectors[i], centroids[c]);
            if (d < bestDist) {
                bestDist = d;
                bestLabel = c;
            }
        }
        labels[i] = bestLabel;
        inertia += bestDist;
    }

    return { labels, centroids, inertia };
}

/**
 * Normalize a set of scalar values into [0,1] and return min/max metadata.
 * @param {ArrayLike<number>} values
 * @returns {{ normalized: Float32Array, min: number, max: number }}
 */
export function normalizeRange(values) {
    const arr = values || [];
    const len = Number.isFinite(arr.length) ? arr.length : 0;
    const out = new Float32Array(len);
    if (len === 0) {
        return { normalized: out, min: 0, max: 0 };
    }

    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < len; i++) {
        const value = Number(arr[i]);
        if (!Number.isFinite(value)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { normalized: out, min: 0, max: 0 };
    }

    const span = max - min;
    if (Math.abs(span) <= EPSILON) {
        out.fill(1);
        return { normalized: out, min, max };
    }

    for (let i = 0; i < len; i++) {
        const value = Number(arr[i]);
        out[i] = Number.isFinite(value) ? (value - min) / span : 0;
    }
    return { normalized: out, min, max };
}

/**
 * Topic drift scores between consecutive vectors.
 * @param {number[][]} orderedVectors
 * @returns {number[]}
 */
export function topicShiftScores(orderedVectors) {
    validateVectors(orderedVectors);
    if (orderedVectors.length < 2) return [];

    const shifts = new Array(orderedVectors.length - 1);
    for (let i = 0; i < orderedVectors.length - 1; i++) {
        const similarity = cosineSimilarity(orderedVectors[i], orderedVectors[i + 1]);
        const score = 1 - similarity;
        shifts[i] = Math.max(0, Math.min(2, score));
    }
    return shifts;
}
