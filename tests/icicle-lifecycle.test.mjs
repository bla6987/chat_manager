import { isVector } from '../src/vector-utils.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timestampMs } from '../src/timestamps.js';
import { buildIcicleData, reLayoutSubtree, sharesActiveThread, clearIcicleSemanticCache } from '../src/icicle-data.js';
import { createMessageDescriptor } from '../src/message-descriptors.js';
import { gradientColor, clusterColor, topicShiftScores } from '../src/semantic-engine.js';

const raw = (await readFile(new URL('../src/icicle-view.js', import.meta.url), 'utf8'))
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '').replace(/^export /gm, '');
const entry = (prefix, length = 20) => ({ isLoaded: true,
    messages: Array.from({ length }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `${prefix}${i}` })),
});

// DOM and frame boundaries are synthetic; mount, rebuild, render, navigation,
// semantic annotation and every data traversal execute the production source.
function harness(index = {}, options = {}) {
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
        }, reLayoutSubtree, sharesActiveThread, clearIcicleSemanticCache, isVector, timestampMs, gradientColor, clusterColor, topicShiftScores,
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
        getIndex: () => index, getDisplayName: file => file, getEmbeddingSettings: () => options.settings || {},
        isEmbeddingConfigured: () => false, document,
        window: { devicePixelRatio: 1, addEventListener() {}, removeEventListener() {} },
        requestAnimationFrame: fn => { const id = ++frameId; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id), setTimeout, clearTimeout, performance, console,
    };
    if (options.bodies) deps.iterateChatBodies = options.bodies;
    if (options.vectors) deps.iterateCachedMessageVectors = options.vectors;
    if (options.chatVectors) deps.iterateCachedChatVectors = options.chatVectors;
    const api = new Function(...Object.keys(deps), `${raw}; return {
        mountIcicle, unmountIcicle, updateIcicleData, isIcicleMounted,
        startMomentum: (vx, vy) => { inertiaVx = vx; inertiaVy = vy; startInertia(); },
        momentum: () => ({ vx: inertiaVx, vy: inertiaVy, frame: inertiaAnimId }),
        focusMessageInIcicle, setIcicleCallbacks, exploreThread, invalidateIcicleEmbeddings,
        executeSearch, showTooltip, setSemantic: () => { searchModeSemantic = true; },
        setView: (x, y0, y1) => { viewX = x; viewY0 = y0; viewY1 = y1; },
        snapshot: () => ({canvas, flatNodes, zoomRoot, pendingFocusRequest, exploreRoot,
            exploreDepthOffset, threadFocusActive, emptyStateEl, dataUpdateInFlight,
            x:viewX, y0:viewY0, y1:viewY1, semanticQueryCache, semanticSearchActive, semanticSearchScores,
            searchMatches, searchMatchIndex, pcaRanges, viewAnimId, tooltipEl, topicDriftCache,
            keywordSearchController,buildAbortController,topicDriftRequest,activeTopicDrift,pendingFrames:pendingFrameIds.size}),
    };`)(...Object.values(deps));
    api.setIcicleCallbacks({ getActive: () => active, onThreadFocusChanged: value => scopeChanges.push(value) });
    return { api, index, scopeChanges, momentInputs, frames, fixture: new Element('div'),
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

test('icicle keyword search reads evicted bodies beyond previews and cancels stale scans', async () => {
    const messages = [
        { index: 0, role: 'user', text: 'shared start' },
        { index: 1, role: 'assistant', text: 'filler '.repeat(100) + 'hidden archive needle' },
        { index: 2, role: 'user', text: 'different result' },
    ];
    const chat = { fileName: 'a', isLoaded: true, bodyResident: false, messages: messages.map(createMessageDescriptor) };
    let gate = null;
    const signals = [];
    const view = harness({ a: chat }, { bodies: async function* ({ fileNames, signal }) {
        signals.push(signal);
        const pending = gate; gate = null;
        if (pending) await pending.promise;
        if (fileNames.includes('a')) yield { entry: chat, messages };
    } });
    await view.api.mountIcicle(view.fixture, 'mini');
    await view.api.executeSearch('hidden archive needle', { navigate: false });
    assert.equal(view.api.snapshot().searchMatches.length, 1);
    assert.equal(view.api.snapshot().searchMatches[0].depth, 1);
    assert.ok(chat.messages.every(message => message.isDescriptor && message.text === ''), 'search does not promote all bodies back into residency');
    assert.ok(view.api.snapshot().flatNodes.every(node => node.representative.text.length <= 160));
    gate = deferred(); const delayed = gate;
    const stale = view.api.executeSearch('hidden archive needle', { navigate: false });
    const oldSignal = signals.at(-1);
    await view.api.executeSearch('different result', { navigate: false });
    assert.equal(oldSignal.aborted, true);
    delayed.resolve(); await stale;
    assert.equal(view.api.snapshot().searchMatches[0].depth, 2, 'late archived results cannot overwrite the newer search');
    view.api.unmountIcicle();
    assert.equal(view.frames.size, 0);
});

test('icicle semantic search includes nonresident vectors and teardown clears caches and frames', async () => {
    const messages = [0, 1, 2].map(index => ({ index, role: 'assistant', text: `message ${index}` }));
    const chat = { fileName: 'a', isLoaded: true, bodyResident: false, messages: messages.map(createMessageDescriptor), messageEmbeddings: new Map() };
    const view = harness({ a: chat }, { vectors: async function* ({ fileNames, signal, mode }) {
        assert.deepEqual(fileNames, ['a']); assert.equal(mode, 'active');
        for (const message of messages) {
            if (signal.aborted) return;
            yield { fileName: 'a', msgIndex: message.index, vector: new Float32Array(message.index === 1 ? [1, 0] : [0, 1]) };
        }
    } });
    await view.api.mountIcicle(view.fixture, 'mini');
    await view.settle();
    assert.equal(view.api.snapshot().activeTopicDrift.scoresByDepth.size, 2, 'topic drift includes adjacent persisted vectors after eviction');
    assert.equal(view.api.snapshot().activeTopicDrift.scoresByDepth.get(1), 1);
    view.api.setSemantic(); view.api.executeSearch('archive query'); await view.settle();
    let state = view.api.snapshot();
    assert.equal(state.semanticSearchScores.size, 3);
    assert.equal(state.searchMatches[0].depth, 1);
    assert.equal(state.semanticQueryCache.size, 1);
    const canvas = state.canvas;
    view.api.unmountIcicle(); state = view.api.snapshot();
    assert.equal(state.semanticQueryCache.size, 0); assert.equal(state.topicDriftCache.size, 0);
    assert.equal(state.keywordSearchController, null); assert.equal(state.buildAbortController, null);
    assert.equal(state.topicDriftRequest, null);
    assert.equal(state.pendingFrames, 0); assert.equal(view.frames.size, 0);
    assert.equal(state.flatNodes.length, 0); assert.equal(state.searchMatches.length, 0);
    assert.equal(canvas.width, 0); assert.equal(canvas.height, 0);
});

test('icicle completes its first mount if gradient work is invalidated while archive reads are pending', async () => {
    const gate = deferred();
    const signals = [];
    const view = harness({ a: entry('chat', 3) }, { settings: { colorMode: 'gradient' },
        chatVectors: async function* ({ signal }) {
            signals.push(signal);
            if (signals.length === 1) await gate.promise;
            yield { fileName: 'a', vector: new Float32Array([1, 0]), hash: 'representative', recipeKey: 'current', epoch: 1 };
        },
    });
    const mount = view.api.mountIcicle(view.fixture, 'mini');
    await view.settle();
    view.api.invalidateIcicleEmbeddings();
    assert.equal(signals[0].aborted, true);
    gate.resolve(); await mount;
    assert.equal(view.api.isIcicleMounted(), true);
    assert.equal(view.api.snapshot().flatNodes.length, 3);
    assert.ok(signals.length >= 3, 'the current recipe rebuilds both sampled basis and coordinates');
    view.api.unmountIcicle();
});

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
    const first = await buildIcicleData(index, 'a', { colorMode: 'gradient' });
    assert.equal(first.maxDepth, 11999);
    assert.equal(first.flatNodes.length, 13000);
    assert.equal(first.flatNodes.at(-1).clusterLabel, 2);
    assert.ok(first.flatNodes.every(node => node.y1 > node.y0 && node.pca3d?.every(Number.isFinite)));
    assert.equal(first.flatNodes[200].chatFiles, first.flatNodes[0].chatFiles,
        'shared prefixes retain membership compaction');
    const next = await buildIcicleData(index, 'b', { previousRoot: first.root, colorMode: 'gradient' });
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

test('touch momentum preserves release velocity, moves on a frame, and stops on unmount', async () => {
    const view = harness({ a: entry('shared', 30) });
    await view.api.mountIcicle(view.fixture, 'mini');
    view.api.setView(300, 0.2, 0.7);
    view.api.startMomentum(10, 0.01);
    const before = view.api.momentum();
    assert.equal(before.vx, 10);
    assert.equal(before.vy, 0.01);
    const frame = view.frames.get(before.frame);
    assert.equal(typeof frame, 'function');
    view.frames.delete(before.frame); frame();
    assert.ok(view.api.snapshot().x < 300, 'momentum changes horizontal viewport');
    assert.ok(view.api.momentum().vx > 0 && view.api.momentum().vx < 10, 'velocity decays');
    const oldFrame = view.api.momentum().frame;
    view.api.startMomentum(5, 0.005);
    assert.equal(view.frames.has(oldFrame), false, 'a new release replaces the previous momentum frame');
    assert.equal(view.api.momentum().vx, 5);
    view.api.unmountIcicle();
    assert.equal(view.api.momentum().vx, 0);
    assert.equal(view.api.momentum().vy, 0);
    assert.equal(view.api.momentum().frame, null);
});
