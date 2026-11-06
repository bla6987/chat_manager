import test from 'node:test';
import assert from 'node:assert/strict';
import { rankSemanticCandidates } from '../src/semantic-search.js';
import { cosineSimilarity } from '../src/semantic-engine.js';

function baseline(rows, query) {
    const groups = new Map();
    let order = 0;
    for (const c of rows) {
        if (!c.vector) continue;
        let semanticScore = 0;
        try { semanticScore = cosineSimilarity(query, c.vector); } catch {}
        const combinedScore = .7 * semanticScore + .3 * c.keywordScore;
        const result = { item: c.item, matchedText: c.text, matchIndex: c.matchIndex,
            combinedScore, semanticScore, matchedSwipeIndex: c.swipeIndex, activeSwipeIndex: c.activeSwipeIndex,
            isActiveSwipeMatch: c.swipeIndex === c.activeSwipeIndex, order: order++ };
        const prior = groups.get(c.key);
        const ranks = prior?.ranks || new Map();
        const file = ranks.get(c.item.filename);
        if (!file || combinedScore > file.score) ranks.set(c.item.filename, { score: combinedScore, order: result.order });
        if (!prior || combinedScore > prior.combinedScore) groups.set(c.key, { ...result, ranks });
    }
    return { totalMatches: groups.size, results: [...groups.values()]
        .sort((a,b) => (b.combinedScore-a.combinedScore)||(a.order-b.order)).slice(0,100).map(r => {
            r.otherFiles = [...r.ranks].filter(([f]) => f !== r.item.filename)
                .sort((a,b) => (b[1].score-a[1].score)||(a[1].order-b[1].order)).map(([f])=>f);
            delete r.order; delete r.ranks; return r;
        }) };
}
function makeRows(seed) {
    let state = seed;
    const random = n => { state = (1664525 * state + 1013904223) >>> 0; return state % n; };
    return Array.from({ length: 1800 }, (_, i) => ({ key: `${random(270)}:active`,
        item: { filename: `file${random(8)}`, index: i }, text: `swipe${i}`,
        vector: [null, [], [0,0], [1], [1,0], [-1,0], [1,1], [2,-3]][random(8)],
        keywordScore: random(2), matchIndex: random(5)-1, swipeIndex: random(3), activeSwipeIndex: 1 }));
}
test('two-pass ranking exactly matches legacy duplicate, swipe, tie and invalid-dimension results', async () => {
    for (let seed = 1; seed <= 30; seed++) {
        const rows = makeRows(seed);
        assert.deepEqual(await rankSemanticCandidates({ candidates: () => rows, queryVector: [1,0], yieldControl: async()=>{} }), baseline(rows,[1,0]));
    }
});
test('nonfinite scores preserve legacy sort and winner semantics', async () => {
    const rows = makeRows(14);
    rows[0].vector = [NaN,1]; rows[30].vector = [Infinity,1];
    assert.deepEqual(await rankSemanticCandidates({ candidates: () => rows, queryVector: [1,0], yieldControl: async()=>{} }), baseline(rows,[1,0]));
});
test('cancellation yields no partial result and stops in a bounded chunk', async () => {
    let current = true, seen = 0;
    function* rows() { for (const row of makeRows(3)) { seen++; yield row; } }
    const result = await rankSemanticCandidates({ candidates: rows, queryVector: [1,0], chunkSize: 32,
        isCurrent: () => current, yieldControl: async()=> { current = false; } });
    assert.equal(result,null); assert.equal(seen,32);
});
test('large input remains capped and cooperatively yields through both passes', async () => {
    const rows = makeRows(7); let yields = 0;
    const result = await rankSemanticCandidates({ candidates: () => rows, queryVector: [1,0], chunkSize: 32,
        yieldControl: async()=> { yields++; } });
    assert.equal(result.results.length,100); assert.ok(yields >= 110);
});
test('cancellation during file-rank reconstruction also discards every result', async () => {
    const rows = makeRows(9); let passes = 0; let current = true;
    function* candidates() {
        passes++;
        for (const row of rows) yield row;
    }
    const result = await rankSemanticCandidates({ candidates, queryVector: [1,0], chunkSize: 16,
        isCurrent: () => current, yieldControl: async()=> { if (passes === 2) current = false; } });
    assert.equal(passes,2); assert.equal(result,null);
});
test('vector norms expire across yields for externally owned mutable vectors', async () => {
    const vector = [1,0];
    const rows = Array.from({length:4}, (_, i) => ({key:String(i), item:{filename:String(i)},
        vector, keywordScore:0, text:'x', matchIndex:-1, swipeIndex:0, activeSwipeIndex:0}));
    let yields = 0;
    const ranked = await rankSemanticCandidates({ candidates:()=>rows, queryVector:[1,0], chunkSize:2,
        yieldControl:async()=> { if (++yields === 1) vector[1] = 1; } });
    assert.equal(ranked.results.find(r=>r.item.filename==='0').semanticScore,1);
    assert.equal(ranked.results.find(r=>r.item.filename==='1').semanticScore,1/Math.sqrt(2));
});
test('elapsed-time budget yields before the candidate-count budget', async () => {
    let clock = 0, firstYieldAt = 0, seen = 0;
    const rows = makeRows(2).slice(0,20);
    function* candidates() { for (const row of rows) { seen++; yield row; } }
    await rankSemanticCandidates({ candidates, queryVector:[1,0], chunkSize:256, timeBudgetMs:8,
        now:()=> clock += 3, yieldControl:async()=> { firstYieldAt ||= seen; } });
    assert.ok(firstYieldAt > 0 && firstYieldAt < 20);
});
