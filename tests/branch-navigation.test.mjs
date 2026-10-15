import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { timestampMs } from '../src/timestamps.js';
import { buildIcicleData, reLayoutSubtree, sharesActiveThread } from '../src/icicle-data.js';

const viewSource = await readFile(new URL('../src/icicle-view.js', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
};

function entry(branch, length = 30) {
    return {
        isLoaded: true,
        messages: Array.from({ length }, (_, index) => ({
            text: index < 2 ? `shared ${index}` : `${branch} message ${index}`,
            role: index % 2 ? 'assistant' : 'user', timestamp: null,
        })),
        messageEmbeddings: new Map(),
    };
}

// Execute the production module with controlled build/animation timing. Only
// rendering is omitted; data construction, navigation and refresh code are real.
async function viewHarness() {
    const index = { a: entry('left'), b: entry('right') };
    let active = 'a';
    let buildGate = null;
    let embeddingGate = null;
    let builds = 0;
    const frames = new Map();
    let nextFrame = 1;
    const dependencies = {
        buildIcicleData: async (...args) => {
            builds++;
            const result = await buildIcicleData(...args);
            const gate = buildGate;
            buildGate = null;
            if (gate) await gate.promise;
            return result;
        },
        reLayoutSubtree, sharesActiveThread, timestampMs,
        getIndex: () => index,
        getMessageEmbedding: () => [1, 0],
        getDisplayName: file => file,
        getEmbeddingSettings: () => ({}),
        embedText: () => embeddingGate.promise,
        captureEmbeddingOperation: () => ({}), isEmbeddingOperationCurrent: () => true,
        cosineSimilarity: () => 1,
        requestAnimationFrame: fn => { const id = nextFrame++; frames.set(id, fn); return id; },
        cancelAnimationFrame: id => frames.delete(id),
        performance, console, setTimeout, clearTimeout,
    };
    const source = viewSource.replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];\s*/gm, '')
        .replace(/^export /gm, '');
    const api = new Function(...Object.keys(dependencies), `${source}
        return {
            updateIcicleData, onWheel, onMouseDown, onMouseMove, exploreThread,
            executeSearch, navigateMatch, startInertia, animateViewportTo,
            seed(data, getActive) {
                mounted = true; lifecycleGeneration++;
                canvas = { style: {}, getBoundingClientRect: () => ({left:0,top:0}) };
                canvasWidth = 600; canvasHeight = 400;
                icicleRoot = data.root; flatNodes = data.flatNodes; maxDepth = data.maxDepth;
                getActiveChatFile = getActive; rebuildDepthIndex();
            },
            setView(x, y0, y1) { viewX=x; viewY0=y0; viewY1=y1; },
            setZoom(node) { zoomRoot=node; zoomStack=[flatNodes[0]]; },
            setSemantic() { searchModeSemantic=true; },
            unmountDuringBuild() { mounted=false; lifecycleGeneration++; canvas=null; },
            snapshot() { return {x:viewX,y0:viewY0,y1:viewY1,flatNodes,
                zoomRoot,zoomStack,exploreRoot,exploreDepthOffset,isDragging,
                viewAnimId,inertiaAnimId,searchMatchIndex,searchMatches,dataUpdateInFlight}; }
        };`)(...Object.values(dependencies));
    api.seed(await buildIcicleData(index, active, { threadFocus: true }), () => active);
    return {
        api, index, frames,
        setActive: value => { active = value; },
        delayBuild: () => { buildGate = deferred(); return buildGate; },
        delayEmbedding: () => { embeddingGate = deferred(); return embeddingGate; },
        get builds() { return builds; },
    };
}

function wheel(api, deltaY = 0, options = {}) {
    api.onWheel({ preventDefault() {}, clientX: 300, clientY: 200, deltaX: 0, deltaY, ...options });
}

function sameViewport(actual, expected) {
    for (const key of ['x', 'y0', 'y1']) {
        assert.ok(Math.abs(actual[key] - expected[key]) < 1e-10, `${key}: ${actual[key]} != ${expected[key]}`);
    }
}

test('background refresh preserves the viewport and remaps zoom breadcrumbs', async () => {
    const { api } = await viewHarness();
    api.setView(400, 0.1, 0.35);
    api.setZoom(api.snapshot().flatNodes.find(n => n.depth === 4 && n.chatFiles.includes('a')));
    const before = api.snapshot();
    await api.updateIcicleData();
    const after = api.snapshot();
    sameViewport(after, before);
    assert.equal(after.zoomRoot.depth, before.zoomRoot.depth);
    assert.notEqual(after.zoomRoot, before.zoomRoot, 'breadcrumbs reference the newly built data');
    assert.equal(after.zoomStack.length, 1);
});

test('scrolling and dragging during an asynchronous rebuild use the latest viewport', async () => {
    const harness = await viewHarness();
    const { api } = harness;
    api.setView(400, 0.1, 0.35);
    const gate = harness.delayBuild();
    const update = api.updateIcicleData();
    wheel(api, 60, { shiftKey: true });
    api.onMouseDown({ button: 0, clientX: 100, clientY: 100 });
    api.onMouseMove({ clientX: 120, clientY: 120 });
    const before = api.snapshot();
    gate.resolve();
    await update;
    sameViewport(api.snapshot(), before);
    assert.equal(api.snapshot().isDragging, true);
    api.onMouseMove({ clientX: 130, clientY: 130 });
    assert.equal(api.snapshot().x, before.x - 10, 'drag continues without snapping to its old origin');
});

test('newly hydrated branches keep the viewed message at the same screen position and size', async () => {
    const { api, index } = await viewHarness();
    api.setView(400, 0.6, 0.85);
    const before = api.snapshot();
    const oldNode = before.flatNodes.find(n => n.depth === 5 && n.chatFiles.includes('b'));
    index.c = entry('third');
    await api.updateIcicleData();
    const after = api.snapshot();
    const node = after.flatNodes.find(n => n.depth === 5 && n.chatFiles.includes('b'));
    const position = (n, v) => (n.y0 - v.y0) / (v.y1 - v.y0);
    const size = (n, v) => (n.y1 - n.y0) / (v.y1 - v.y0);
    assert.ok(Math.abs(position(node, after) - position(oldNode, before)) < 1e-10);
    assert.ok(Math.abs(size(node, after) - size(oldNode, before)) < 1e-10);
    assert.equal(after.x, before.x);
});

test('switching active threads does not reorder existing branches or recenter the chart', async () => {
    const { api, setActive } = await viewHarness();
    api.setView(400, 0.6, 0.85);
    const before = api.snapshot();
    setActive('b');
    await api.updateIcicleData();
    sameViewport(api.snapshot(), before);
    const branches = api.snapshot().flatNodes.filter(n => n.depth === 2);
    assert.deepEqual(branches.map(n => n.normalizedText), ['left message 2', 'right message 2']);
});

test('exploring a subtree survives refresh and wheel zoom without a delayed coordinate reset', async () => {
    const { api } = await viewHarness();
    api.exploreThread(api.snapshot().flatNodes.find(n => n.depth === 4 && n.chatFiles.includes('b')));
    api.setView(400, 0.2, 0.6);
    await api.updateIcicleData();
    const before = api.snapshot();
    assert.equal(before.exploreRoot.depth, 4);
    assert.equal(before.exploreDepthOffset, 4);
    sameViewport(before, { x: 400, y0: 0.2, y1: 0.6 });
    wheel(api, -10, { ctrlKey: true });
    assert.equal(api.snapshot().exploreDepthOffset, 4);
    assert.ok(api.snapshot().y1 - api.snapshot().y0 < 0.4);
});

test('refreshing search results retains the selected match without starting a pan animation', async () => {
    const { api } = await viewHarness();
    api.executeSearch('message');
    api.navigateMatch(1);
    const selected = api.snapshot().searchMatches[1];
    wheel(api, 60, { shiftKey: true });
    api.setView(400, 0.6, 0.85);
    const before = api.snapshot();
    await api.updateIcicleData();
    const after = api.snapshot();
    sameViewport(after, before);
    assert.equal(after.viewAnimId, null);
    assert.equal(after.searchMatches[after.searchMatchIndex].normalizedText, selected.normalizedText);
});

test('late semantic search results cannot move the view after the user scrolls', async () => {
    const { api, delayEmbedding } = await viewHarness();
    const gate = delayEmbedding();
    api.setSemantic();
    api.executeSearch('message');
    wheel(api, 60, { shiftKey: true });
    const before = api.snapshot();
    gate.resolve([1, 0]);
    await Promise.resolve();
    sameViewport(api.snapshot(), before);
    assert.equal(api.snapshot().viewAnimId, null);
    assert.ok(api.snapshot().searchMatches.length > 0, 'search still updates its results');
});

test('wheel and explicit navigation stop older touch momentum', async () => {
    const { api } = await viewHarness();
    api.startInertia();
    wheel(api, 30, { shiftKey: true });
    assert.equal(api.snapshot().inertiaAnimId, null);
    api.startInertia();
    api.animateViewportTo(200, 0.2, 0.4);
    assert.equal(api.snapshot().inertiaAnimId, null);
});

test('queued refreshes coalesce and a completed build cannot revive an unmounted view', async () => {
    const harness = await viewHarness();
    const gate = harness.delayBuild();
    const update = harness.api.updateIcicleData();
    await Promise.all([harness.api.updateIcicleData(), harness.api.updateIcicleData()]);
    assert.equal(harness.builds, 1);
    harness.api.unmountDuringBuild();
    gate.resolve();
    await update;
    assert.equal(harness.builds, 1);
});

test('explicit reset requests survive a queued background refresh', async () => {
    const harness = await viewHarness();
    harness.api.setView(400, 0.6, 0.85);
    const gate = harness.delayBuild();
    const update = harness.api.updateIcicleData();
    await harness.api.updateIcicleData({ resetView: true });
    await harness.api.updateIcicleData();
    gate.resolve();
    await update;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.builds, 2, 'burst produces only one follow-up build');
    sameViewport(harness.api.snapshot(), { x: 3000, y0: 0, y1: 1 });
});

test('a chat switch during a build discards the obsolete snapshot and rebuilds for the latest chat', async () => {
    const harness = await viewHarness();
    harness.index.c = entry('separate');
    harness.index.c.messages[0].text = 'different greeting';
    const gate = harness.delayBuild();
    const update = harness.api.updateIcicleData();
    harness.setActive('c');
    gate.resolve();
    await update;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(harness.builds, 2);
    assert.ok(harness.api.snapshot().flatNodes.every(node => node.chatFiles.includes('c')));
});

test('CHAT_CHANGED finishes while archive refresh is still pending', async () => {
    const refresh = deferred();
    let refreshStarted = false;
    const dependencies = {
        mountTopBarToggleButton() {}, syncTopBarToggleDisabledState() {},
        SillyTavern: { getContext: () => ({ characterId: 0, characters: [{ avatar: 'test.png' }] }) },
        getIndexCharacterAvatar: () => 'test.png', isPanelOpen: () => true,
        refreshPanel: () => { refreshStarted = true; return refresh.promise; },
        resetSearchState() {}, document: { getElementById: () => null },
        getBranchContextEnabled: () => false, isEmbeddingGenerationEnabled: () => false,
        console,
    };
    const handler = new Function(...Object.keys(dependencies),
        `const MODULE_NAME='test'; ${indexSource.slice(indexSource.indexOf('async function onChatChanged()'))}; return onChatChanged;`)(
        ...Object.values(dependencies));
    let completed = false;
    const result = handler().then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(refreshStarted, true);
    assert.equal(completed, true, 'host navigation is independent of archive network/cache work');
    refresh.resolve();
    await result;
});
