/** Fit a bounded sample, then assign every cached chat without retaining a corpus matrix. */
import { iterateCachedChatVectors, throwIfAborted } from './archive-data.js';
import { getIndex, getIndexVersion, getIndexCharacterAvatar } from './chat-reader.js';
import { captureEmbeddingOperation, isEmbeddingOperationCurrent } from './embedding-service.js';
import { getRepresentativeEmbeddingText } from './embedding-text.js';
import { findOptimalKAsync, kMeansAsync } from './semantic-engine.js';
import { toFloat32Vector } from './vector-utils.js';

export const ARCHIVE_CLUSTER_SAMPLE_LIMIT = 1024;
export const ARCHIVE_CLUSTER_SAMPLE_BYTES = 8 * 1024 * 1024;

function seededRandom() {
    let state = 0x4d595df4;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let value = Math.imul(state ^ (state >>> 15), 1 | state);
        value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

/** Includes summary edits that do not necessarily replace a catalog entry. */
function contentSignature(fileNames) {
    let a = 0x811c9dc5, b = 0x9e3779b9;
    for (const fileName of fileNames) {
        const entry = getIndex()[fileName];
        const part = JSON.stringify([fileName, entry?.isLoaded, entry?.needsHydration, getRepresentativeEmbeddingText(entry)]);
        for (let i = 0; i < part.length; i++) {
            const code = part.charCodeAt(i);
            a = Math.imul(a ^ code, 0x01000193);
            b = Math.imul(b ^ code, 0x85ebca6b);
        }
    }
    return `${a >>> 0}:${b >>> 0}`;
}

function nearestCentroid(vector, centroids) {
    let label = 0;
    let bestDistance = Infinity;
    for (let cluster = 0; cluster < centroids.length; cluster++) {
        let distance = 0;
        const centroid = centroids[cluster];
        for (let dimension = 0; dimension < vector.length; dimension++) {
            const difference = vector[dimension] - centroid[dimension];
            distance += difference * difference;
        }
        if (distance < bestDistance) { bestDistance = distance; label = cluster; }
    }
    return label;
}

/**
 * Requires a stable catalog while running. Any content/recipe/character change
 * rejects the result; callers may retry after pending indexing settles.
 * Sample payload is at most 8 MiB and 1,024 vectors. The only archive-sized
 * result is a filename-to-integer Map; vectors are never promoted into residency.
 */
export async function computeArchiveClusters({ fileNames, fixedK, signal, embeddingOperation } = {}) {
    const operation = embeddingOperation || captureEmbeddingOperation();
    const names = [...new Set(Array.isArray(fileNames) ? fileNames : Object.keys(getIndex()))];
    const avatar = getIndexCharacterAvatar();
    const version = getIndexVersion();
    const signature = contentSignature(names);
    const assertCurrent = (checkContent = false) => {
        throwIfAborted(signal);
        if (!isEmbeddingOperationCurrent(operation)) throw new DOMException('Embedding settings changed', 'AbortError');
        const context = globalThis.SillyTavern?.getContext?.();
        if (getIndexVersion() !== version || getIndexCharacterAvatar() !== avatar
            || (avatar && context?.characters?.[context.characterId]?.avatar !== avatar)
            || (checkContent && contentSignature(names) !== signature)) {
            throw new DOMException('Chat content changed during clustering', 'AbortError');
        }
    };
    assertCurrent();
    const random = seededRandom();
    const sample = [];
    let dimensions = null;
    let sampleCapacity = ARCHIVE_CLUSTER_SAMPLE_LIMIT;
    let seen = 0;
    let deadline = Date.now() + 8;

    for await (const item of iterateCachedChatVectors({ fileNames: names, signal, embeddingOperation: operation })) {
        assertCurrent();
        if (dimensions === null) {
            dimensions = item.vector.length;
            sampleCapacity = Math.min(ARCHIVE_CLUSTER_SAMPLE_LIMIT,
                Math.floor(ARCHIVE_CLUSTER_SAMPLE_BYTES / (dimensions * Float32Array.BYTES_PER_ELEMENT)));
            if (sampleCapacity < 1) throw new RangeError('One chat vector exceeds the clustering sample memory budget');
        } else if (item.vector.length !== dimensions) {
            throw new Error('Chat embeddings have inconsistent dimensions');
        }
        seen++;
        if (sample.length < sampleCapacity) sample.push(toFloat32Vector(item.vector));
        else {
            // Algorithm R with a fixed seed is deterministic for the catalog's
            // stable traversal order and samples the entire archive uniformly.
            const slot = Math.floor(random() * seen);
            if (slot < sampleCapacity) sample[slot] = toFloat32Vector(item.vector);
        }
        if (seen % 64 === 0 && Date.now() >= deadline) {
            await new Promise(resolve => setTimeout(resolve, 0));
            assertCurrent(); deadline = Date.now() + 8;
        }
    }
    assertCurrent(true);
    const sampleCount = sample.length;
    if (!sampleCount) return { labelsByFile: new Map(), k: null, clusterCount: 0, embeddedCount: 0, sampleCount: 0 };

    let k = Number.isFinite(fixedK) && fixedK > 0
        ? Math.floor(fixedK) : await findOptimalKAsync(sample, 8);
    assertCurrent(true);
    if (!Number.isFinite(k) || k < 1) k = Math.min(5, Math.ceil(sampleCount / 3));
    k = Math.max(1, Math.min(k, sampleCount));
    const { centroids } = await kMeansAsync(sample, k, 50);
    assertCurrent(true);
    sample.length = 0;

    const labelsByFile = new Map();
    deadline = Date.now() + 8;
    for await (const item of iterateCachedChatVectors({ fileNames: names, signal, embeddingOperation: operation })) {
        assertCurrent();
        if (item.vector.length !== dimensions) throw new DOMException('Embedding dimensions changed', 'AbortError');
        labelsByFile.set(item.fileName, nearestCentroid(item.vector, centroids));
        if (labelsByFile.size % 64 === 0 && Date.now() >= deadline) {
            await new Promise(resolve => setTimeout(resolve, 0));
            assertCurrent(); deadline = Date.now() + 8;
        }
    }
    assertCurrent(true);
    if (labelsByFile.size !== seen) throw new DOMException('Cached chat vectors changed during clustering', 'AbortError');
    return { labelsByFile, k, clusterCount: new Set(labelsByFile.values()).size,
        embeddedCount: labelsByFile.size, sampleCount };
}
