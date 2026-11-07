/** Full-archive search with bounded result text and no retained body collection. */
import { iterateMessageVariants, iterateCachedMessageVectors, throwIfAborted } from './archive-data.js';
import { readChatMessages } from './chat-reader.js';
import { textFingerprint, messagePreview } from './message-descriptors.js';
import { cosineSimilarity } from './semantic-engine.js';
import { captureEmbeddingOperation, isEmbeddingOperationCurrent } from './embedding-service.js';
import { timestampMs } from './timestamps.js';

const IDENTITY_TEXT_LIMIT = 4096;

function compareResults(a, b) {
    return (b.combinedScore - a.combinedScore)
        || (b.time - a.time)
        || a.reference.fileName.localeCompare(b.reference.fileName)
        || (b.reference.msgIndex - a.reference.msgIndex)
        || (a.matchedSwipeIndex - b.matchedSwipeIndex);
}

async function resolveIdentity(reference, options) {
    if (typeof reference.identity === 'string') return reference.identity;
    if (options.resolveIdentity) return options.resolveIdentity(reference);
    const messages = await readChatMessages(reference.fileName, { signal: options.signal });
    const message = messages.find(item => item.index === reference.msgIndex);
    return typeof message?.text === 'string' ? message.text.toLowerCase() : null;
}

async function findSameIdentity(groups, identity, options) {
    for (const group of groups || []) {
        if (await resolveIdentity(group.reference || group, options) === identity) return group;
    }
    return null;
}

function excerpt(text, query) {
    const match = text.toLowerCase().indexOf(query);
    const start = match < 0 ? 0 : Math.max(0, match - 80);
    const size = Math.max(240, Math.min(2048, query.length + 160));
    const snippet = messagePreview(text.slice(start, start + size), size);
    return `${start ? '…' : ''}${snippet}${start + size < text.length ? '…' : ''}`;
}

/**
 * Retain at most limit+1 candidate groups. A second bounded scan fills duplicate
 * thread links for the winners, including duplicates encountered before a winner
 * entered the top set. Exclusions contain compact references from earlier pages.
 */
export async function searchArchivePage(options) {
    const query = String(options.query || '').trim().toLowerCase();
    const semantic = options.mode === 'semantic';
    // Both scans belong to one recipe. A new token for the duplicate-link pass
    // would allow results from two models/endpoints to be silently mixed.
    const embeddingOperation = semantic ? (options.embeddingOperation || captureEmbeddingOperation()) : null;
    const assertCurrent = () => {
        throwIfAborted(options.signal);
        if (semantic && !isEmbeddingOperationCurrent(embeddingOperation)) {
            throw new DOMException('Embedding settings changed', 'AbortError');
        }
    };
    assertCurrent();
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    // Failure to narrow is not failure to search: no answer reads every chat.
    const fileNames = options.fileNames ?? (await options.narrowFileNames?.()) ?? undefined;
    assertCurrent();
    const source = options.sourceFactory || (() => (semantic ? iterateCachedMessageVectors : iterateMessageVariants)({
        fileNames, signal: options.signal, settings: options.settings,
        embeddingOperation,
        mode: semantic && options.settings?.showAlternateSwipesInResults === true ? 'all' : 'active',
    }));
    const excluded = options.excluded || new Map();
    const top = [];
    let scanned = 0;

    async function candidate(item) {
        const lower = item.text.toLowerCase();
        const matchIndex = lower.indexOf(query);
        if (!semantic && matchIndex < 0) return null;
        const identity = String(item.activeText ?? item.text).toLowerCase();
        const hash = `${item.msgIndex}:${(options.fingerprint || textFingerprint)(identity)}`;
        if (excluded.has(hash) && await findSameIdentity(excluded.get(hash), identity, options)) return null;
        let semanticScore = 0;
        if (semantic) {
            try { semanticScore = cosineSimilarity(options.queryVector, item.vector); } catch { return null; }
        }
        const matchedText = excerpt(item.text, query);
        return {
            hash, identity,
            reference: { fileName: item.fileName, msgIndex: item.msgIndex,
                identity: identity.length <= IDENTITY_TEXT_LIMIT ? messagePreview(identity, IDENTITY_TEXT_LIMIT) : undefined },
            item: { filename: item.fileName, index: item.msgIndex, role: item.role,
                timestamp: item.timestamp, timestampMs: item.timestampMs, text: matchedText },
            matchedText, matchIndex: matchedText.toLowerCase().indexOf(query),
            matchedSwipeIndex: item.swipeIndex, activeSwipeIndex: item.activeSwipeIndex,
            isActiveSwipeMatch: item.isActive,
            semanticScore, combinedScore: semantic ? (0.7 * semanticScore) + (matchIndex >= 0 ? 0.3 : 0) : 0,
            time: Number.isFinite(item.timestampMs) ? item.timestampMs : (timestampMs(item.timestamp) || 0),
            otherFiles: [],
        };
    }

    for await (const item of source()) {
        assertCurrent();
        const result = await candidate(item);
        scanned++;
        if (scanned % 250 === 0) {
            options.onProgress?.(scanned);
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!result) continue;
        const same = await findSameIdentity(top.filter(group => group.hash === result.hash), result.identity, options);
        delete result.identity;
        if (same) {
            if (compareResults(result, same) < 0) top.splice(top.indexOf(same), 1, result);
        } else if (top.length < limit + 1 || compareResults(result, top[top.length - 1]) < 0) {
            top.push(result);
        } else continue;
        top.sort(compareResults);
        if (top.length > limit + 1) top.length = limit + 1;
    }
    assertCurrent();
    const hasMore = top.length > limit;
    const winners = top.slice(0, limit);
    const winningHashes = new Set(winners.map(item => item.hash));
    const ranks = new Map(winners.map(item => [item, new Map()]));
    if (winners.length) for await (const item of source()) {
        assertCurrent();
        const identity = String(item.activeText ?? item.text).toLowerCase();
        const hash = `${item.msgIndex}:${(options.fingerprint || textFingerprint)(identity)}`;
        if (!winningHashes.has(hash)) continue;
        const winner = await findSameIdentity(winners.filter(group => group.hash === hash), identity, options);
        if (!winner) continue;
        const result = await candidate(item);
        if (!result) continue;
        const files = ranks.get(winner);
        const prior = files.get(item.fileName);
        if (!prior || compareResults(result, prior) < 0) {
            files.set(item.fileName, { combinedScore: result.combinedScore, time: result.time,
                reference: { fileName: item.fileName, msgIndex: item.msgIndex }, matchedSwipeIndex: item.swipeIndex });
        }
    }
    assertCurrent();
    const pageReferences = [];
    for (const winner of winners) {
        winner.otherFiles = [...ranks.get(winner).values()].sort(compareResults)
            .map(value => value.reference.fileName).filter(file => file !== winner.item.filename);
        pageReferences.push({ hash: winner.hash, reference: { fileName: winner.reference.fileName, msgIndex: winner.reference.msgIndex } });
        delete winner.reference;
        delete winner.hash;
        delete winner.time;
    }
    return { results: winners, hasMore, pageReferences, scanned };
}
