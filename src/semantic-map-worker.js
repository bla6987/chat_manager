const EPSILON = 1e-12;

const state = {
    dims: 0,
    count: 0,
    vectorsFlat: null,
    norms: null,
    points2d: null,
    labels: null,
};

self.onmessage = async (event) => {
    const msg = event.data || {};
    const { type, jobId } = msg;

    try {
        if (type === 'buildMapData') {
            handleBuildMapData(msg);
            return;
        }
        if (type === 'scoreQuery') {
            handleScoreQuery(msg);
            return;
        }
    } catch (err) {
        self.postMessage({
            type: 'error',
            jobId,
            message: err instanceof Error ? err.message : String(err),
        });
    }
};

function handleBuildMapData(msg) {
    const { jobId, vectorsFlatBuffer, dims, fixedK = null, maxK = 8 } = msg;
    const vectorsFlat = new Float32Array(vectorsFlatBuffer);
    const n = dims > 0 ? Math.floor(vectorsFlat.length / dims) : 0;

    state.dims = dims;
    state.count = n;
    state.vectorsFlat = vectorsFlat;

    if (!dims || n <= 0) {
        state.norms = new Float32Array(0);
        state.points2d = new Float32Array(0);
        state.labels = new Uint16Array(0);
        self.postMessage({
            type: 'mapDataReady',
            jobId,
            points2dBuffer: state.points2d.buffer,
            labelsBuffer: state.labels.buffer,
            centroids2dBuffer: new Float32Array(0).buffer,
            clusterSizesBuffer: new Uint32Array(0).buffer,
            bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
            k: 0,
        }, [state.points2d.buffer, state.labels.buffer]);
        return;
    }

    state.norms = computeVectorNorms(vectorsFlat, n, dims);

    const { points2d, bounds } = projectPca2D(vectorsFlat, n, dims);
    state.points2d = points2d;

    const k = chooseK(points2d, n, fixedK, maxK);
    const { labels, centroids, clusterSizes } = kMeans2D(points2d, n, k);
    state.labels = labels;

    self.postMessage({
        type: 'mapDataReady',
        jobId,
        points2dBuffer: points2d.buffer,
        labelsBuffer: labels.buffer,
        centroids2dBuffer: centroids.buffer,
        clusterSizesBuffer: clusterSizes.buffer,
        bounds,
        k,
    }, [points2d.buffer, labels.buffer, centroids.buffer, clusterSizes.buffer]);
}

function handleScoreQuery(msg) {
    const { jobId, queryVector = [] } = msg;
    if (!state.vectorsFlat || !state.norms || !state.dims || state.count <= 0) {
        const empty = new Float32Array(0);
        self.postMessage({ type: 'queryScoresReady', jobId, scoresBuffer: empty.buffer, min: 0, max: 0 }, [empty.buffer]);
        return;
    }

    if (!Array.isArray(queryVector) || queryVector.length !== state.dims) {
        throw new Error(`Query vector dimension mismatch. Expected ${state.dims}, received ${queryVector?.length || 0}.`);
    }

    const qNorm = Math.sqrt(queryVector.reduce((acc, v) => acc + (v * v), 0));
    if (!Number.isFinite(qNorm) || qNorm <= EPSILON) {
        const emptyScores = new Float32Array(state.count);
        self.postMessage({ type: 'queryScoresReady', jobId, scoresBuffer: emptyScores.buffer, min: 0, max: 0 }, [emptyScores.buffer]);
        return;
    }

    const scores = new Float32Array(state.count);
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < state.count; i++) {
        const vNorm = state.norms[i];
        if (!Number.isFinite(vNorm) || vNorm <= EPSILON) {
            scores[i] = 0;
            if (0 < min) min = 0;
            if (0 > max) max = 0;
            continue;
        }

        const offset = i * state.dims;
        let dot = 0;
        for (let d = 0; d < state.dims; d++) {
            dot += state.vectorsFlat[offset + d] * queryVector[d];
        }
        const sim = dot / (vNorm * qNorm);
        const clamped = Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : 0;
        scores[i] = clamped;
        if (clamped < min) min = clamped;
        if (clamped > max) max = clamped;
    }

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
        min = 0;
        max = 0;
    }

    self.postMessage({
        type: 'queryScoresReady',
        jobId,
        scoresBuffer: scores.buffer,
        min,
        max,
    }, [scores.buffer]);
}

function computeVectorNorms(vectorsFlat, n, dims) {
    const norms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const offset = i * dims;
        let sum = 0;
        for (let d = 0; d < dims; d++) {
            const value = vectorsFlat[offset + d];
            sum += value * value;
        }
        norms[i] = Math.sqrt(sum);
    }
    return norms;
}

function sampleIndices(n, sampleSize) {
    if (sampleSize >= n) {
        const all = new Uint32Array(n);
        for (let i = 0; i < n; i++) all[i] = i;
        return all;
    }

    const step = n / sampleSize;
    const out = new Uint32Array(sampleSize);
    let cursor = 0;
    for (let i = 0; i < sampleSize; i++) {
        out[i] = Math.min(n - 1, Math.floor(cursor));
        cursor += step;
    }
    return out;
}

function projectPca2D(vectorsFlat, n, dims) {
    const sampleSize = Math.min(n, 4096);
    const sample = sampleIndices(n, sampleSize);
    const mean = new Float64Array(dims);

    for (let i = 0; i < sample.length; i++) {
        const idx = sample[i];
        const offset = idx * dims;
        for (let d = 0; d < dims; d++) {
            mean[d] += vectorsFlat[offset + d];
        }
    }
    for (let d = 0; d < dims; d++) {
        mean[d] /= Math.max(1, sample.length);
    }

    const compA = powerIterComponent(vectorsFlat, sample, dims, mean, null);
    const compB = powerIterComponent(vectorsFlat, sample, dims, mean, compA);

    const points = new Float32Array(n * 2);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < n; i++) {
        const offset = i * dims;
        let x = 0;
        let y = 0;
        for (let d = 0; d < dims; d++) {
            const centered = vectorsFlat[offset + d] - mean[d];
            x += centered * compA[d];
            y += centered * compB[d];
        }

        points[(i * 2)] = x;
        points[(i * 2) + 1] = y;

        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
        minX = -1;
        maxX = 1;
        minY = -1;
        maxY = 1;
    }

    return {
        points2d: points,
        bounds: { minX, maxX, minY, maxY },
    };
}

function powerIterComponent(vectorsFlat, sample, dims, mean, orthogonalTo = null) {
    const v = new Float64Array(dims);
    v[0] = 1;

    const w = new Float64Array(dims);
    const sampleLen = Math.max(1, sample.length - 1);

    for (let iter = 0; iter < 14; iter++) {
        w.fill(0);

        for (let s = 0; s < sample.length; s++) {
            const idx = sample[s];
            const offset = idx * dims;

            let dot = 0;
            for (let d = 0; d < dims; d++) {
                dot += (vectorsFlat[offset + d] - mean[d]) * v[d];
            }

            for (let d = 0; d < dims; d++) {
                w[d] += (vectorsFlat[offset + d] - mean[d]) * dot;
            }
        }

        for (let d = 0; d < dims; d++) {
            w[d] /= sampleLen;
        }

        if (orthogonalTo) {
            let proj = 0;
            for (let d = 0; d < dims; d++) {
                proj += w[d] * orthogonalTo[d];
            }
            for (let d = 0; d < dims; d++) {
                w[d] -= proj * orthogonalTo[d];
            }
        }

        let norm = 0;
        for (let d = 0; d < dims; d++) {
            norm += w[d] * w[d];
        }
        norm = Math.sqrt(norm);
        if (!Number.isFinite(norm) || norm <= EPSILON) {
            break;
        }

        for (let d = 0; d < dims; d++) {
            v[d] = w[d] / norm;
        }
    }

    return v;
}

function chooseK(points2d, n, fixedK, maxK) {
    if (Number.isFinite(fixedK) && fixedK > 0) {
        return Math.max(1, Math.min(n, Math.floor(fixedK)));
    }
    if (n <= 1) return 1;

    const upper = Math.max(2, Math.min(Math.floor(maxK || 8), n));
    if (upper <= 2) return upper;

    const sampleCount = Math.min(n, 20000);
    const sampleIdx = sampleIndices(n, sampleCount);
    const samplePoints = new Float32Array(sampleCount * 2);
    for (let i = 0; i < sampleCount; i++) {
        const idx = sampleIdx[i];
        samplePoints[i * 2] = points2d[idx * 2];
        samplePoints[(i * 2) + 1] = points2d[(idx * 2) + 1];
    }

    const inertias = [];
    const ks = [];
    for (let k = 2; k <= upper; k++) {
        const result = kMeans2D(samplePoints, sampleCount, k, { assignOnlyInertia: true });
        ks.push(k);
        inertias.push(result.inertia);
    }

    if (inertias.length < 3) return ks[0];

    let min = Infinity;
    let max = -Infinity;
    for (const value of inertias) {
        if (value < min) min = value;
        if (value > max) max = value;
    }

    const span = max - min;
    if (!Number.isFinite(span) || span <= EPSILON) {
        return Math.min(5, Math.ceil(n / 3));
    }

    let bestIdx = -1;
    let bestScore = -Infinity;
    for (let i = 1; i < ks.length - 1; i++) {
        const x = i / (ks.length - 1);
        const y = (inertias[i] - min) / span;
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

function kMeans2D(points2d, n, k, opts = {}) {
    const clusterCount = Math.max(1, Math.min(n, Math.floor(k)));
    const rng = mulberry32(seedFromPoints(points2d, n, clusterCount));
    const { centroidsX, centroidsY } = initKMeansPlusPlus(points2d, n, clusterCount, rng);
    const labels = new Uint16Array(n);
    const maxIter = Math.max(1, Math.floor(opts.maxIter || 30));

    let inertia = 0;
    for (let iter = 0; iter < maxIter; iter++) {
        const sumsX = new Float64Array(clusterCount);
        const sumsY = new Float64Array(clusterCount);
        const counts = new Uint32Array(clusterCount);
        const dist = new Float64Array(n);
        inertia = 0;

        for (let i = 0; i < n; i++) {
            const px = points2d[i * 2];
            const py = points2d[(i * 2) + 1];

            let bestLabel = 0;
            let bestDist = Infinity;
            for (let c = 0; c < clusterCount; c++) {
                const dx = px - centroidsX[c];
                const dy = py - centroidsY[c];
                const d = dx * dx + dy * dy;
                if (d < bestDist) {
                    bestDist = d;
                    bestLabel = c;
                }
            }

            labels[i] = bestLabel;
            dist[i] = bestDist;
            inertia += bestDist;
            counts[bestLabel] += 1;
            sumsX[bestLabel] += px;
            sumsY[bestLabel] += py;
        }

        let maxShift = 0;
        for (let c = 0; c < clusterCount; c++) {
            if (counts[c] === 0) {
                const randomIndex = Math.floor(rng() * n);
                centroidsX[c] = points2d[randomIndex * 2];
                centroidsY[c] = points2d[(randomIndex * 2) + 1];
                continue;
            }

            const nextX = sumsX[c] / counts[c];
            const nextY = sumsY[c] / counts[c];
            const dx = nextX - centroidsX[c];
            const dy = nextY - centroidsY[c];
            const shift = (dx * dx) + (dy * dy);
            if (shift > maxShift) maxShift = shift;
            centroidsX[c] = nextX;
            centroidsY[c] = nextY;
        }

        if (maxShift <= 1e-8) break;
    }

    if (opts.assignOnlyInertia) {
        return { inertia, labels: new Uint16Array(0), centroids: new Float32Array(0), clusterSizes: new Uint32Array(0) };
    }

    const centroids = new Float32Array(clusterCount * 2);
    const clusterSizes = new Uint32Array(clusterCount);
    for (let c = 0; c < clusterCount; c++) {
        centroids[c * 2] = centroidsX[c];
        centroids[(c * 2) + 1] = centroidsY[c];
    }
    for (let i = 0; i < n; i++) {
        clusterSizes[labels[i]] += 1;
    }

    return { labels, centroids, clusterSizes, inertia };
}

function initKMeansPlusPlus(points2d, n, k, rng) {
    const centroidsX = new Float64Array(k);
    const centroidsY = new Float64Array(k);
    const minDist = new Float64Array(n);
    minDist.fill(Infinity);

    const first = Math.floor(rng() * n);
    centroidsX[0] = points2d[first * 2];
    centroidsY[0] = points2d[(first * 2) + 1];

    for (let c = 1; c < k; c++) {
        const prevX = centroidsX[c - 1];
        const prevY = centroidsY[c - 1];

        let total = 0;
        for (let i = 0; i < n; i++) {
            const dx = points2d[i * 2] - prevX;
            const dy = points2d[(i * 2) + 1] - prevY;
            const d = dx * dx + dy * dy;
            if (d < minDist[i]) minDist[i] = d;
            total += minDist[i];
        }

        let pick = -1;
        if (total <= EPSILON) {
            pick = Math.floor(rng() * n);
        } else {
            const target = rng() * total;
            let cumulative = 0;
            for (let i = 0; i < n; i++) {
                cumulative += minDist[i];
                if (cumulative >= target) {
                    pick = i;
                    break;
                }
            }
            if (pick < 0) pick = n - 1;
        }

        centroidsX[c] = points2d[pick * 2];
        centroidsY[c] = points2d[(pick * 2) + 1];
    }

    return { centroidsX, centroidsY };
}

function seedFromPoints(points2d, n, k) {
    let hash = (0x811c9dc5 ^ k ^ n) >>> 0;
    const limit = Math.min(n, 128);
    for (let i = 0; i < limit; i++) {
        const x = Math.round(points2d[i * 2] * 1e4) | 0;
        const y = Math.round(points2d[(i * 2) + 1] * 1e4) | 0;
        hash ^= x;
        hash = Math.imul(hash, 0x01000193) >>> 0;
        hash ^= y;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function mulberry32(seed) {
    let t = seed >>> 0;
    return function () {
        t += 0x6D2B79F5;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}
