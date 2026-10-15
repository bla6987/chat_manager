import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timestampMs } from '../src/timestamps.js';
import { buildIcicleData, reLayoutSubtree, sharesActiveThread } from '../src/icicle-data.js';

const raw = (await readFile(new URL('../src/icicle-view.js', import.meta.url), 'utf8'))
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/^export /gm, '');
const entry = (prefix, length = 20) => ({ isLoaded: true,
    messages: Array.from({ length }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${prefix}${i}` })),
});

// DOM and frame boundaries are synthetic; mount, rebuild, render, navigation,
// semantic annotation and every data traversal execute the production source.
function harness(index = {}) {
    const frames = new Map();
    let frameId = 0;
    const context = new Proxy({ measureText: text => ({ width: text.length * 6 }) }, {
        get: (target, key) => key in target ? target[key] : () => {},
    });
    class Element {
        constructor(tag) {
            this.tagName = tag; this.children = []; this.style = {}; this.dataset = {};
            this.offsetHeight = 0; this.clientWidth = 600; this.clientHeight = 400;
            this.classList = { toggle() {}, add() {}, remove() {} };
        }
        set innerHTML(value) { this.html = value; this.children = []; }
        get innerHTML() { return this.html || ''; }
        get firstChild() { return this.children[0] || null; }
        appendChild(child) { child.parent = this; this.children.push(child); }
        insertBefore(child) { child.parent = this; this.children.unshift(child); }
        remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
        addEventListener() {}
        removeEventListener() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
        getContext() { return context; }
        getBoundingClientRect() { return { left: 0, top: 0 }; }
    }
    const document = { createElement: tag => new Element(tag), body: new Element('body'),
        addEventListener() {}, removeEventListener() {} };
    const scopeChanges = [];
    const momentInputs = [];
    let recipe = 'endpoint-a/model-a';
    let operationEpoch = 0;
    let embeddingCalls = 0;
    let embeddingGate = null;
    let buildGate = null;
    let active = 'a';
    const deps = {
        buildIcicleData: async (...args) => {
            const result = await buildIcicleData(...args);
            const gate = buildGate;
            buildGate = null;
            if (gate) await gate.promise;
            return result;
        }, reLayoutSubtree, sharesActiveThread, timestampMs,
        SillyTavern: { libs: { moment: value => {
            momentInputs.push(value);
            return { format: () => new Date(value).toISOString() };
        } } },
        captureEmbeddingOperation: () => ({ recipe, epoch: operationEpoch }),
        isEmbeddingOperationCurrent: operation => operation.recipe === recipe && operation.epoch === operationEpoch,
        embedText: async () => {
            embeddingCalls++;
            const gate = embeddingGate;
            embeddingGate = null;
            if (gate) return gate.promise;
            return recipe.endsWith('model-a') ? [1, 0] : [0, 1];
        },
        getMessageEmbedding: () => [1, 0], cosineSimilarity: (a, b) => a[0] * b[0] + a[1] * b[1],
        getIndex: () => index, getDisplayName: file => file, getEmbeddingSettings: () => ({}),
        isEmbeddingConfigured: () => false, document,
        window: { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} },
        requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id), setTimeout, clearTimeout, performance, console,
    };
    const api = new Function(...Object.keys(deps), `${raw}; return {
        mountIcicle, unmountIcicle, updateIcicleData, isIcicleMounted,
        focusMessageInIcicle, setIcicleCallbacks, exploreThread, invalidateIcicleEmbeddings,
        executeSearch, showTooltip, setSemantic: () => { searchModeSemantic = true; },
        setView: (x, y0, y1) => { viewX = x; viewY0 = y0; viewY1 = y1; },
        snapshot: () => ({canvas, flatNodes, zoomRoot, pendingFocusRequest, exploreRoot,
            exploreDepthOffset, threadFocusActive, emptyStateEl, dataUpdateInFlight,
            x:viewX, y0:viewY0, y1:viewY1, semanticQueryCache, semanticSearchActive, semanticSearchScores,
            searchMatches, searchMatchIndex, pcaRanges, viewAnimId, tooltipEl}),
    };`)(...Object.values(deps));
    api.setIcicleCallbacks({ getActive: () => active, onThreadFocusChanged: value => scopeChanges.push(value) });
    return { api, index, scopeChanges, momentInputs, fixture: new Element('div'),
        setActive: value => { active = value; },
        setRecipe: value => { recipe = value; operationEpoch++; },
        get embeddingCalls() { return embeddingCalls; },
        delayEmbedding: () => { embeddingGate = deferred(); return embeddingGate; },
        delayBuild: () => { buildGate = deferred(); return buildGate; },
        settle: async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); },
    };
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

test('empty cold mount recovers as hydration arrives and removes its empty overlay', async () => {
    const { api, index, fixture } = harness();
    await api.mountIcicle(fixture, 'mini');
    assert.equal(api.isIcicleMounted(), true);
    const canvas = api.snapshot().canvas;
    assert.ok(canvas);
    assert.ok(api.snapshot().emptyStateEl);
    index.a = entry('alpha');
    await api.updateIcicleData();
    assert.equal(api.snapshot().canvas, canvas, 'hydration uses the existing mounted view');
    assert.equal(api.snapshot().flatNodes.length, 20);
    assert.equal(api.snapshot().emptyStateEl, null);
    api.unmountIcicle();
    index.a = undefined;
    assert.equal(api.isIcicleMounted(), false);
});

test('focus reveals loaded targets excluded by the current-thread filter', async () => {
    const { api, scopeChanges, fixture, settle } = harness({ a: entry('alpha'), b: entry('beta') });
    await api.mountIcicle(fixture, 'mini');
    assert.ok(api.snapshot().flatNodes.every(node => node.chatFiles.includes('a')));
    assert.equal(api.focusMessageInIcicle('b', 5, { openPopup: false, persistIfMissing: false }), false);
    assert.ok(api.snapshot().pendingFocusRequest, 'loaded target survives the asynchronous scope rebuild');
    await settle();
    assert.equal(api.snapshot().pendingFocusRequest, null);
    assert.ok(api.snapshot().zoomRoot.chatFiles.includes('b'));
    assert.equal(api.snapshot().zoomRoot.depth, 5);
    assert.deepEqual(scopeChanges, [false]);
    api.unmountIcicle();
});

test('focus requested before mount resolves even when the target begins outside the filter', async () => {
    const { api, fixture, settle } = harness({ a: entry('alpha'), b: entry('beta') });
    api.focusMessageInIcicle('b', 7, { openPopup: false, persistIfMissing: false });
    await api.mountIcicle(fixture, 'mini');
    await settle();
    assert.equal(api.snapshot().zoomRoot.depth, 7);
    assert.ok(api.snapshot().zoomRoot.chatFiles.includes('b'));
    api.unmountIcicle();
});

test('pending focus survives an empty mount and hydration without widening the same thread', async () => {
    const { api, index, fixture, settle, scopeChanges } = harness();
    api.focusMessageInIcicle('a', 4, { openPopup: false });
    await api.mountIcicle(fixture, 'mini');
    assert.ok(api.snapshot().pendingFocusRequest);
    index.a = entry('alpha');
    await api.updateIcicleData();
    await settle();
    assert.equal(api.snapshot().zoomRoot.depth, 4);
    assert.deepEqual(scopeChanges, []);
    assert.equal(api.snapshot().threadFocusActive, true);
    api.unmountIcicle();
});

test('focus outside Explore exits the subtree and retains current-thread mode', async () => {
    const a = entry('shared');
    const b = entry('shared');
    for (let i = 2; i < b.messages.length; i++) b.messages[i].text = `branch${i}`;
    const { api, fixture, settle, scopeChanges } = harness({ a, b });
    await api.mountIcicle(fixture, 'mini');
    api.exploreThread(api.snapshot().flatNodes.find(node => node.depth === 4 && node.chatFiles.includes('a')));
    assert.ok(api.snapshot().exploreRoot);
    api.focusMessageInIcicle('b', 6, { openPopup: false, persistIfMissing: false });
    await settle();
    assert.equal(api.snapshot().exploreRoot, null);
    assert.equal(api.snapshot().exploreDepthOffset, 0);
    assert.equal(api.snapshot().zoomRoot.depth, 6);
    assert.ok(api.snapshot().zoomRoot.chatFiles.includes('b'));
    assert.deepEqual(scopeChanges, []);
    api.unmountIcicle();
});

test('a truly missing nonpersistent focus clears without widening or rebuilding', async () => {
    const { api, fixture, scopeChanges, settle } = harness({ a: entry('alpha') });
    await api.mountIcicle(fixture, 'mini');
    assert.equal(api.focusMessageInIcicle('a', 99, { openPopup: false, persistIfMissing: false }), false);
    await settle();
    assert.equal(api.snapshot().pendingFocusRequest, null);
    assert.equal(api.snapshot().dataUpdateInFlight, false);
    assert.deepEqual(scopeChanges, []);
    assert.equal(api.snapshot().zoomRoot, null);
    api.unmountIcicle();
});

test('all trie passes and Explore handle 12000 messages with semantic fields and stable branch order', async () => {
    const a = { ...entry('deep', 12000), chatEmbedding: [1, 0, 0], clusterLabel: 1 };
    const b = { ...entry('deep', 12000), chatEmbedding: [0, 1, 0], clusterLabel: 2 };
    b.messages[11000].text = 'divergent';
    const index = { a, b };
    const first = await buildIcicleData(index, 'a');
    assert.equal(first.maxDepth, 11999);
    assert.equal(first.flatNodes.length, 13000);
    assert.equal(first.flatNodes.at(-1).clusterLabel, 2);
    assert.ok(first.flatNodes.every(node => node.y1 > node.y0 && node.pca3d?.every(Number.isFinite)));
    assert.equal(first.flatNodes[200].chatFiles, first.flatNodes[0].chatFiles,
        'shared prefixes retain membership compaction');
    const next = await buildIcicleData(index, 'b', { previousRoot: first.root });
    assert.deepEqual(next.flatNodes.filter(node => node.depth === 11000).map(node => node.normalizedText),
        ['deep11000', 'divergent']);
    const subtree = reLayoutSubtree(next.flatNodes[100], 'b', { preserveOrder: true });
    assert.equal(subtree.maxDepth, 11999);
    assert.equal(subtree.depthOffset, 100);
    assert.equal(subtree.flatNodes.length, 12900);
    assert.equal(subtree.flatNodes[0].y0, 0);
    assert.equal(subtree.flatNodes[0].y1, 1);
});


test('same-dimension endpoint/model recipe changes cannot reuse cached icicle query vectors', async () => {
    const h = harness({ a: { ...entry('alpha'), messageEmbeddings: new Map() } });
    await h.api.mountIcicle(h.fixture, 'mini');
    h.api.setSemantic();
    h.api.executeSearch('alpha', { navigate: false });
    await h.settle();
    assert.equal(h.embeddingCalls, 1);
    assert.equal(h.api.snapshot().semanticSearchScores.values().next().value, 1);
    h.setRecipe('endpoint-b/model-b');
    h.api.executeSearch('alpha', { navigate: false });
    await h.settle();
    assert.equal(h.embeddingCalls, 2);
    assert.equal(h.api.snapshot().semanticSearchScores.values().next().value, 0);
    h.api.unmountIcicle();
});

test('explicit embedding invalidation retires pending queries, cached vectors and held semantic fields without navigation', async () => {
    const h = harness({ a: { ...entry('alpha'), chatEmbedding: [1, 0], clusterLabel: 2,
        messageEmbeddings: new Map() } });
    await h.api.mountIcicle(h.fixture, 'mini');
    h.api.setSemantic();
    h.api.executeSearch('alpha', { navigate: false });
    await h.settle();
    assert.equal(h.api.snapshot().semanticQueryCache.size, 1);
    const pending = h.delayEmbedding();
    h.api.executeSearch('other', { navigate: false });
    h.api.setView(250, 0.2, 0.6);
    h.api.invalidateIcicleEmbeddings();
    let snapshot = h.api.snapshot();
    assert.equal(snapshot.semanticQueryCache.size, 0);
    assert.equal(snapshot.semanticSearchActive, false);
    assert.equal(snapshot.searchMatches.length, 0);
    assert.equal(snapshot.searchMatchIndex, -1);
    assert.equal(snapshot.pcaRanges, null);
    assert.ok(snapshot.flatNodes.every(node => node.clusterLabel === null
        && node.chatEmbedding === null && node.pca3d === null));
    pending.resolve([1, 0]);
    await h.settle();
    snapshot = h.api.snapshot();
    assert.equal(snapshot.semanticQueryCache.size, 0, 'late completion cannot refill the cleared cache');
    assert.equal(snapshot.semanticSearchActive, false);
    assert.deepEqual([snapshot.x, snapshot.y0, snapshot.y1], [250, 0.2, 0.6]);
    h.api.executeSearch('alpha', { navigate: false });
    await h.settle();
    assert.equal(h.embeddingCalls, 3, 'same query embeds afresh after an explicit clear');
    h.api.unmountIcicle();
});

test('clearing embeddings during a data rebuild cannot republish its captured semantic fields', async () => {
    const h = harness({ a: { ...entry('alpha'), chatEmbedding: [1, 0], clusterLabel: 2 } });
    await h.api.mountIcicle(h.fixture, 'mini');
    const gate = h.delayBuild();
    const update = h.api.updateIcicleData();
    await Promise.resolve();
    h.api.invalidateIcicleEmbeddings();
    gate.resolve();
    await update;
    assert.ok(h.api.snapshot().flatNodes.every(node => node.clusterLabel === null && node.chatEmbedding === null));
    assert.equal(h.api.snapshot().pcaRanges, null);
    h.api.unmountIcicle();
});


test('embedding invalidation cancels the old semantic-result animation at its current viewport', async () => {
    const h = harness({ a: { ...entry('alpha'), messageEmbeddings: new Map() } });
    await h.api.mountIcicle(h.fixture, 'mini');
    h.api.setSemantic();
    h.api.executeSearch('alpha');
    await h.settle();
    assert.ok(h.api.snapshot().viewAnimId);
    h.api.setView(250, 0.2, 0.6);
    h.api.invalidateIcicleEmbeddings();
    const snapshot = h.api.snapshot();
    assert.equal(snapshot.viewAnimId, null);
    assert.deepEqual([snapshot.x, snapshot.y0, snapshot.y1], [250, 0.2, 0.6]);
    h.api.unmountIcicle();
});


test('historical host timestamps retain recency ordering and format tooltips from normalized milliseconds', async () => {
    const chat = entry('alpha');
    chat.messages[0].timestamp = '2024-07-12@01h31m37s123ms';
    chat.messages[1].timestamp = '2024-07-11T01:31:37.123Z';
    chat.messages[2].timestamp = '2024-07-13 @01h 31m 37s 123ms';
    const h = harness({ a: chat });
    await h.api.mountIcicle(h.fixture, 'mini');
    h.api.executeSearch('alpha', { navigate: false });
    assert.deepEqual(h.api.snapshot().searchMatches.slice(0, 3).map(node => node.depth), [2, 0, 1]);
    const historical = h.api.snapshot().flatNodes[0];
    h.api.showTooltip(20, 20, historical);
    assert.deepEqual(h.momentInputs, [Date.parse('2024-07-12T01:31:37.123Z')]);
    assert.ok(h.api.snapshot().tooltipEl.innerHTML.includes('2024-07-12T01:31:37.123Z'));
    h.api.showTooltip(20, 20, { ...historical, representative: { ...historical.representative, timestamp: 'invalid' } });
    assert.equal(h.momentInputs.length, 1, 'invalid timestamps never reach the date formatter');
    assert.ok(!h.api.snapshot().tooltipEl.innerHTML.includes('chat-manager-timeline-tooltip-time'));
    h.api.unmountIcicle();
});
