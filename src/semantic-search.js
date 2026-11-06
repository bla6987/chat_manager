/** Exact, cooperative ranking. Only shortlisted groups retain per-file ranks. */
export async function rankSemanticCandidates({ candidates, queryVector, isCurrent = () => true,
    yieldControl = () => new Promise(resolve => setTimeout(resolve, 0)), chunkSize = 65536, limit = 100, timeBudgetMs = 8,
    now = () => globalThis.performance?.now() ?? Date.now() }) {
    const groups = new Map();
    let queryNorm = 0;
    if (Array.isArray(queryVector)) for (const value of queryVector) queryNorm += value * value;
    const querySquared = queryNorm;
    queryNorm = Math.sqrt(queryNorm);
    let norms = new WeakMap();
    let work = 0;
    let chunkStarted = now();
    // Time is the primary budget; the large count guard avoids timer churn on
    // cheap rows while retaining an injectable deterministic test boundary.
    function needsYield() {
        return ++work % chunkSize === 0 || now() - chunkStarted >= timeBudgetMs;
    }
    async function pause() {
        await yieldControl();
        // Vectors are externally owned and may be edited in place while yielding.
        norms = new WeakMap();
        chunkStarted = now();
        return isCurrent();
    }
    if (!isCurrent()) return null;
    function score(vector) {
        if (!Array.isArray(queryVector) || queryVector.length !== vector.length || !vector.length) return 0;
        let norm = norms.get(vector);
        let dot = 0;
        let squared = 0;
        for (let i = 0; i < vector.length; i++) {
            dot += queryVector[i] * vector[i];
            if (norm === undefined) squared += vector[i] * vector[i];
        }
        if (norm === undefined) {
            norm = squared;
            norms.set(vector, norm);
        }
        if (querySquared <= 1e-12 || norm <= 1e-12) return 0;
        return dot / (queryNorm * Math.sqrt(norm));
    }
    let order = 0;
    for (const candidate of candidates()) {
        if (needsYield() && !await pause()) return null;
        if (!candidate.vector) continue;
        let semanticScore = 0;
        try { semanticScore = score(candidate.vector); } catch { /* Match legacy score errors. */ }
        const combinedScore = .7 * semanticScore + .3 * candidate.keywordScore;
        const prior = groups.get(candidate.key);
        if (!prior || combinedScore > prior.combinedScore) {
            groups.set(candidate.key, { ...candidate, semanticScore, combinedScore, _semanticOrder: order });
        }
        order++;
    }
    const compare = (a, b) => (b.combinedScore - a.combinedScore) || (a._semanticOrder - b._semanticOrder);
    let selected = [];
    // Nonfinite input preserves the legacy Array.sort comparator behavior exactly.
    let nonfinite = false;
    for (const value of groups.values()) if (!Number.isFinite(value.combinedScore)) nonfinite = true;
    if (nonfinite) {
        selected = [...groups.values()].sort(compare).slice(0, limit);
    } else {
        for (const value of groups.values()) {
            if (needsYield() && !await pause()) return null;
            let low = 0;
            let high = selected.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (compare(value, selected[middle]) < 0) high = middle;
                else low = middle + 1;
            }
            const position = low;
            if (position < limit) {
                selected.splice(position, 0, value);
                if (selected.length > limit) selected.pop();
            }
        }
    }
    const totalMatches = groups.size;
    groups.clear();
    const retained = new Map(selected.map(value => [value.key, value]));
    for (const value of selected) value.fileRanks = new Map();
    order = 0;
    for (const candidate of candidates()) {
        if (needsYield() && !await pause()) return null;
        if (!candidate.vector) continue;
        const winner = retained.get(candidate.key);
        if (winner) {
            let semanticScore = 0;
            try { semanticScore = score(candidate.vector); } catch { /* Legacy behavior. */ }
            const combinedScore = .7 * semanticScore + .3 * candidate.keywordScore;
            const prior = winner.fileRanks.get(candidate.item.filename);
            if (!prior || combinedScore > prior.score) winner.fileRanks.set(candidate.item.filename, { score: combinedScore, order });
        }
        order++;
    }
    if (!isCurrent()) return null;
    return { totalMatches, results: selected.map(value => ({
        item: value.item, matchedText: value.text, matchIndex: value.matchIndex,
        combinedScore: value.combinedScore, semanticScore: value.semanticScore,
        matchedSwipeIndex: value.swipeIndex, activeSwipeIndex: value.activeSwipeIndex,
        isActiveSwipeMatch: value.swipeIndex === value.activeSwipeIndex,
        otherFiles: [...value.fileRanks].filter(([name]) => name !== value.item.filename)
            .sort((a, b) => (b[1].score - a[1].score) || (a[1].order - b[1].order)).map(([name]) => name),
    })) };
}
