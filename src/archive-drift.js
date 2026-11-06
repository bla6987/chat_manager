/** Topic-shift summaries for persisted chats without retaining their vector corpus. */
import { iterateCachedMessageVectors, throwIfAborted } from './archive-data.js';
import { getIndex, getIndexCharacterAvatar } from './chat-reader.js';
import { captureEmbeddingOperation, isEmbeddingOperationCurrent } from './embedding-service.js';
import { cosineSimilarity } from './semantic-engine.js';
import { isVector } from './vector-utils.js';

/**
 * Return the same major-first card summary as the resident topic-shift path.
 * Missing embeddings are skipped; consecutive available active vectors define
 * each transition. Only one previous vector and ten candidate positions remain
 * live while the archive iterator supplies bounded batches.
 */
export async function computeArchiveDriftSummary(fileName, { signal, embeddingOperation } = {}) {
    const operation = embeddingOperation || captureEmbeddingOperation();
    const entry = getIndex()[fileName];
    const avatar = getIndexCharacterAvatar();
    const assertCurrent = () => {
        throwIfAborted(signal);
        if (!isEmbeddingOperationCurrent(operation)) throw new DOMException('Embedding settings changed', 'AbortError');
        if (getIndex()[fileName] !== entry) throw new DOMException('Chat content changed', 'AbortError');
        const context = globalThis.SillyTavern?.getContext?.();
        if (getIndexCharacterAvatar() !== avatar
            || (avatar && context?.characters?.[context.characterId]?.avatar !== avatar)) {
            throw new DOMException('The selected character changed', 'AbortError');
        }
    };
    assertCurrent();
    if (!entry) return null;

    let previousVector = null;
    let majorCount = 0;
    let moderateCount = 0;
    const majorPositions = [];
    const moderatePositions = [];
    try {
        for await (const item of iterateCachedMessageVectors({
            fileNames: [fileName], signal, embeddingOperation: operation,
            settings: operation.settings, mode: 'active',
        })) {
            assertCurrent();
            if (item.fileName !== fileName || !isVector(item.vector)) continue;
            if (item.entry && item.entry !== entry) throw new DOMException('Chat content changed', 'AbortError');
            const vector = item.vector;
            if (previousVector) {
                // Identical to topicShiftScores: preserve strict thresholds and
                // account for opposed as well as orthogonal/zero vectors.
                const score = Math.max(0, Math.min(2, 1 - cosineSimilarity(previousVector, vector)));
                if (score > 0.4) {
                    majorCount++;
                    if (majorPositions.length < 5) majorPositions.push(item.msgIndex);
                } else if (score > 0.3) {
                    moderateCount++;
                    if (moderatePositions.length < 5) moderatePositions.push(item.msgIndex);
                }
            }
            previousVector = vector;
        }
        assertCurrent();
        const count = majorCount + moderateCount;
        if (!count) return null;
        const positions = [...majorPositions, ...moderatePositions].slice(0, 5);
        return { count, majorCount, positions, firstMsgIndex: positions[0] };
    } finally {
        previousVector = null;
    }
}
