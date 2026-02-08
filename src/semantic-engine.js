/**
 * Semantic Engine — pure vector math for clustering, dimensionality reduction, and coloring.
 */

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
    const dims = Array.isArray(vectors[0]) ? vectors[0].length : 0;
    if (dims === 0) throw new Error('Vectors must contain at least one dimension.');
    for (let i = 0; i < vectors.length; i++) {
        const v = vectors[i];
        if (!Array.isArray(v) || v.length !== dims) {
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
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
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

/**
 * @param {number[][]} matrix
 * @param {number[]} vector
 * @returns {number[]}
 */
function matrixVectorMultiply(matrix, vector) {
    const out = new Array(matrix.length).fill(0);
    for (let i = 0; i < matrix.length; i++) {
        let sum = 0;
        const row = matrix[i];
        for (let j = 0; j < row.length; j++) {
            sum += row[j] * vector[j];
        }
        out[i] = sum;
    }
    return out;
}

/**
 * @param {number[]} vector
 * @returns {number}
 */
function vectorNorm(vector) {
    return Math.sqrt(dot(vector, vector));
}

/**
 * PCA projection to 3 dimensions using covariance + power iteration.
 * @param {number[][]} vectors
 * @returns {{ projected: number[][], mean: number[], components: number[][] }}
 */
export function pca3D(vectors) {
    const dims = validateVectors(vectors);
    const n = vectors.length;
    if (n === 0) {
        return { projected: [], mean: [], components: [] };
    }

    // Center data.
    const mean = new Array(dims).fill(0);
    for (let i = 0; i < n; i++) {
        const row = vectors[i];
        for (let d = 0; d < dims; d++) {
            mean[d] += row[d];
        }
    }
    for (let d = 0; d < dims; d++) {
        mean[d] /= n;
    }

    const centered = new Array(n);
    for (let i = 0; i < n; i++) {
        const row = new Array(dims);
        for (let d = 0; d < dims; d++) {
            row[d] = vectors[i][d] - mean[d];
        }
        centered[i] = row;
    }

    // Covariance matrix.
    const cov = new Array(dims);
    for (let i = 0; i < dims; i++) {
        cov[i] = new Array(dims).fill(0);
    }

    for (let r = 0; r < n; r++) {
        const row = centered[r];
        for (let i = 0; i < dims; i++) {
            const vi = row[i];
            for (let j = i; j < dims; j++) {
                cov[i][j] += vi * row[j];
            }
        }
    }

    const scale = 1 / Math.max(1, n - 1);
    for (let i = 0; i < dims; i++) {
        for (let j = i; j < dims; j++) {
            const value = cov[i][j] * scale;
            cov[i][j] = value;
            cov[j][i] = value;
        }
    }

    // Power iteration for top 3 principal components.
    const componentCount = Math.min(3, dims);
    const components = [];

    for (let c = 0; c < componentCount; c++) {
        const init = new Array(dims).fill(0);
        init[c % dims] = 1;
        let v = init;

        for (let iter = 0; iter < POWER_ITER_MAX; iter++) {
            let w = matrixVectorMultiply(cov, v);

            // Orthogonalize against already found eigenvectors.
            for (let p = 0; p < components.length; p++) {
                const u = components[p];
                const projection = dot(w, u);
                for (let d = 0; d < dims; d++) {
                    w[d] -= projection * u[d];
                }
            }

            const wNorm = vectorNorm(w);
            if (wNorm <= EPSILON) break;

            for (let d = 0; d < dims; d++) {
                w[d] /= wNorm;
            }

            let diff = 0;
            for (let d = 0; d < dims; d++) {
                const delta = w[d] - v[d];
                diff += delta * delta;
            }
            v = w;
            if (Math.sqrt(diff) <= POWER_ITER_TOL) {
                break;
            }
        }

        // Reject near-zero eigenvalue components.
        const Av = matrixVectorMultiply(cov, v);
        const eigenvalue = dot(v, Av);
        if (eigenvalue <= EPSILON) {
            break;
        }
        components.push(v.slice());
    }

    while (components.length < 3) {
        components.push(new Array(dims).fill(0));
    }

    const projected = centered.map(row => {
        const out = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
            out[c] = dot(row, components[c]);
        }
        return out;
    });

    return { projected, mean, components };
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
