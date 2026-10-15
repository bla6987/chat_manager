import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { selectTopStable } from '../src/view-efficiency-utils.js';
import { pca3D, pca3DAsync } from '../src/semantic-engine.js';
import { getEmbeddingRecipeKey } from '../src/embedding-service.js';

// Execute production view handlers with synthetic DOM/provider/RAF boundaries.
// The appended accessors expose private state without changing production APIs.
class Element {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.style = {};
        this.children = [];
        this.listeners = new Map();
        this.clientWidth = 500;
        this.clientHeight = 400;
        this.value = '';
    }
    set innerHTML(value) { this.children = []; this.html = value; }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(callback);
    }
    removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
    dispatch(type, event = {}) { for (const callback of this.listeners.get(type) || []) callback(event); }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.className?.split(' ').includes(selector.slice(1))) return child;
            const found = child.querySelector(selector);
            if (found) return found;
        }
        return null;
    }
    getContext() { return null; }
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight }; }
}
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function sourceContext(file, tail, globals = {}) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
        .replace(/^import .*;$/gm, '').replace(/^export /gm, '');
    const context = vm.createContext({
        console: { warn() {} }, Float32Array, Float64Array, Uint16Array, Uint32Array,
        ArrayBuffer, Map, Set, Math, Number, setTimeout, clearTimeout, ...globals,
    });
    vm.runInContext(`${source}\n${tail}`, context, { filename: file });
    return context;
}
function viewContext(kind) {
    const fixture = new Element();
    const requests = [];
    const workers = [];
    const frames = new Map();
    const observers = [];
    const data = { index: {}, settings: {}, configured: true };
    let frameId = 0;
    class Worker {
        constructor() { this.sent = []; workers.push(this); }
        postMessage(message) { this.sent.push(message); }
        terminate() { this.terminated = true; }
        deliver(message) { this.onmessage({ data: message }); }
    }
    class ResizeObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.target = null; }
    }
    const globals = {
        window: Object.assign(new Element('window'), { devicePixelRatio: 1 }),
        document: Object.assign(new Element('document'), { createElement: tag => new Element(tag) }),
        Worker, ResizeObserver,
        requestAnimationFrame: callback => { frames.set(++frameId, callback); return frameId; },
        cancelAnimationFrame: id => frames.delete(id),
        getIndex: () => data.index,
        getEmbeddingSettings: () => data.settings,
        setEmbeddingSettings: patch => Object.assign(data.settings, patch),
        getDisplayName: name => name,
        getMessageActiveSwipeIndex: msg => msg.swipeId || 0,
        getMessageEmbedding: (entry, msg, swipe) => entry.messageEmbeddings.get(`${msg.index}:${swipe}`),
        isEmbeddingConfigured: () => data.configured,
        embedText: query => { const request = { query, ...deferred() }; requests.push(request); return request.promise; },
        clusterColor: () => '#5294E0', selectTopStable, getEmbeddingRecipeKey,
    };
    const tail = kind === 'map' ? `
        globalThis.api = {mount:mountSemanticMap,unmount:unmountSemanticMap,update:updateSemanticMapData,query:runSemanticQuery,invalidate:invalidateSemanticMapEmbeddings,
            state:()=>({mounted,canvasWidth,canvasHeight,canvas,scoreValues,queryText,messageRefs,info:infoEl?.textContent}),
            clear:()=>clearBtnEl.dispatch('click'),
            setPoints:(points,nextBounds,size,nextCamera)=>{
                points2d=new Float32Array(points);messageRefs=Array.from({length:points.length/2},()=>({}));
                bounds=nextBounds;canvasWidth=size[0];canvasHeight=size[1];Object.assign(camera,nextCamera);buildGridIndex();
            },hit:hitTestPoint};` : `
        globalThis.api = {mount:mountGraphView,unmount:unmountGraphView,update:updateGraphViewData,
            addTerm:addSearchTermPin,addMessage:addMessagePin,scope:setGraphScope,invalidate:invalidateGraphEmbeddings,
            clear:()=>clearBtnEl.dispatch('click'),
            state:()=>({mounted,canvasWidth,canvasHeight,canvas,pins,simNodes,simRunning,messageRefs,pending:pendingTermPins.size}),
            settle:()=>{simRunning=false;rafId=null;},
            draw:(context,zoom)=>{ctx=context;camera.zoom=zoom;drawEdges();drawNeighborNodes();drawNodeHighlight(1);}
        };`;
    const context = sourceContext(kind === 'map' ? 'semantic-map-view.js' : 'graph-view.js', tail, globals);
    return { api: context.api, fixture, requests, workers, data, observers, context };
}
function entry(texts, vectors) {
    const messages = texts.map((text, index) => ({ index, text, role: 'assistant', swipeId: 0 }));
    return { isLoaded: true, messages, messageEmbeddings: new Map(vectors.map((vector, index) => [`${index}:0`, vector])) };
}
function finishMap(worker) {
    const build = worker.sent.findLast(message => message.type === 'buildMapData');
    const n = build.vectorsFlatBuffer.byteLength / (build.dims * 4);
    worker.deliver({ type: 'mapDataReady', jobId: build.jobId,
        points2dBuffer: new Float32Array(n * 2).buffer, labelsBuffer: new Uint16Array(n).buffer,
        centroids2dBuffer: new Float32Array(2).buffer, clusterSizesBuffer: new Uint32Array([n]).buffer,
        bounds: { minX: -1, maxX: 1, minY: -1, maxY: 1 } });
}

for (const kind of ['map', 'graph']) {
    test(`${kind} initializes canvas input and sizing on empty mount before data arrives`, async () => {
        const view = viewContext(kind);
        await view.api.mount(view.fixture);
        const initial = view.api.state();
        assert.equal(initial.canvasWidth, 500);
        assert.equal(initial.canvasHeight, 400);
        assert.equal(initial.canvas.listeners.get(kind === 'map' ? 'mousedown' : 'pointerdown').size, 1);
        assert.equal(initial.canvas.listeners.get('wheel').size, 1);
        if (kind === 'graph') assert.equal(view.observers[0].target, view.fixture);
        view.data.index.a = entry(['loaded'], [[1, 0]]);
        await view.api.update();
        if (kind === 'map') finishMap(view.workers[0]);
        assert.equal(view.api.state().canvasWidth, 500);
        assert.equal(initial.canvas.listeners.get('wheel').size, 1, 'refresh does not duplicate listeners');
        view.api.unmount();
        assert.equal(initial.canvas.listeners.get('wheel').size, 0);
    });
}

test('map invalidates posted scores and embedding completions on Clear, newer query and remount', async () => {
    const view = viewContext('map');
    view.data.index.a = entry(['one'], [[1, 0]]);
    await view.api.mount(view.fixture);
    const worker = view.workers[0];
    finishMap(worker);
    const first = view.api.query('first');
    view.requests[0].resolve([1, 0]); await first;
    const oldScore = worker.sent.at(-1);
    const next = view.api.query('new query');
    worker.deliver({ type: 'queryScoresReady', jobId: oldScore.jobId, scoresBuffer: new Float32Array([0.9]).buffer });
    assert.equal(view.api.state().scoreValues, null, 'new query invalidates old scores before its embedding resolves');
    view.api.clear();
    view.requests[1].resolve([1, 0]); await next;
    assert.equal(worker.sent.at(-1), oldScore, 'Clear discards pending embedding without posting a score');
    assert.equal(view.api.state().queryText, '');
    worker.deliver({ type: 'queryScoresReady', jobId: oldScore.jobId, scoresBuffer: new Float32Array([0.9]).buffer });
    assert.equal(view.api.state().scoreValues, null);
    const staleError = view.api.query('stale failure');
    const fresh = view.api.query('fresh query');
    view.requests[3].resolve([0, 1]); await fresh;
    const info = view.api.state().info;
    view.requests[2].reject(new Error('late error')); await staleError;
    assert.equal(view.api.state().info, info, 'stale error cannot replace current status');
    const beforeUnmount = view.api.query('same query');
    view.api.unmount(); await view.api.mount(view.fixture); finishMap(view.workers[1]);
    const afterMount = view.api.query('same query');
    view.requests[4].resolve([1, 0]); await beforeUnmount;
    assert.equal(view.workers[1].sent.filter(message => message.type === 'scoreQuery').length, 0);
    view.requests[5].resolve([0, 1]); await afterMount;
    assert.equal(view.workers[1].sent.filter(message => message.type === 'scoreQuery').length, 1);
    view.api.unmount();
});

test('graph reserves pin capacity, coalesces duplicate terms and cancels pending work on Clear/remount', async () => {
    const view = viewContext('graph');
    view.data.index.a = entry(['one'], [[1, 0]]);
    await view.api.mount(view.fixture);
    const duplicate = [view.api.addTerm(' same term '), view.api.addTerm('SAME TERM')];
    assert.equal(view.requests.length, 1);
    view.api.clear(); view.requests[0].resolve([1, 0]); await Promise.all(duplicate);
    assert.equal(view.api.state().pins.length, 0);
    const terms = Array.from({ length: 10 }, (_, i) => view.api.addTerm(`term ${i}`));
    assert.equal(view.requests.length, 9, 'only eight requests reserve the eight available slots');
    view.api.addMessage(0);
    assert.equal(view.api.state().pins.length, 0, 'message pins respect slots reserved by pending terms');
    for (const request of view.requests.slice(1)) request.resolve([1, 0]);
    await Promise.all(terms);
    assert.equal(view.api.state().pins.length, 8);
    view.api.clear();
    const stale = view.api.addTerm('same query');
    const staleRequest = view.requests.at(-1);
    view.api.unmount(); await view.api.mount(view.fixture);
    const current = view.api.addTerm('same query');
    staleRequest.resolve([1, 0]); await stale;
    assert.equal(view.api.state().pins.length, 0);
    assert.equal(view.api.state().pending, 1, 'old completion cannot release new mount reservation');
    view.requests.at(-1).resolve([0, 1]); await current;
    assert.equal(view.api.state().pins.length, 1);
    view.api.unmount();
});

test('message pins remap stable filename/message/swipe identity and refresh their vector', async () => {
    const view = viewContext('graph');
    view.data.index = { a: entry(['Alpha'], [[1, 0]]), b: entry(['Beta'], [[0, 1]]), c: entry(['Gamma'], [[1, 1]]) };
    await view.api.mount(view.fixture);
    view.api.addMessage(1);
    view.api.scope(() => new Set(['b', 'c'])); view.api.update();
    let state = view.api.state();
    assert.equal(state.pins[0].msgRefIndex, 0);
    assert.equal(state.messageRefs[state.pins[0].msgRefIndex].text, 'Beta');
    assert.deepEqual(Array.from(state.simNodes.filter(node => !node.isPin), node => state.messageRefs[node.msgRefIndex].text), ['Gamma']);
    view.data.index.b.messageEmbeddings.set('0:0', [1, 0]); view.api.update();
    assert.deepEqual(view.api.state().pins[0].vector, [1, 0]);
    view.api.scope(() => new Set(['c'])); view.api.update();
    assert.equal(view.api.state().pins.length, 0, 'out-of-scope message pins are removed instead of pointing to another message');
    view.api.unmount();
});

test('graph preserves settled positions on unchanged refresh and resumes after topology changes', async () => {
    const view = viewContext('graph');
    view.data.index = { a: entry(['one', 'two'], [[1, 0], [0, 1]]) };
    await view.api.mount(view.fixture);
    const pin = view.api.addTerm('anchor'); view.requests[0].resolve([1, 0]); await pin;
    let state = view.api.state();
    const neighbor = state.simNodes.find(node => !node.isPin);
    neighbor.x = 123; neighbor.y = 456; neighbor.vx = 0; neighbor.vy = 0;
    view.api.settle(); view.api.update();
    state = view.api.state();
    assert.equal(state.simRunning, false, 'unchanged data leaves a settled simulation asleep');
    assert.equal(state.simNodes.find(node => node.key === neighbor.key).x, 123);
    assert.equal(state.simNodes.find(node => node.key === neighbor.key).y, 456);
    view.data.index.b = entry(['new neighbor'], [[1, 1]]); view.api.update();
    state = view.api.state();
    assert.equal(state.simRunning, true);
    assert.equal(state.simNodes.find(node => node.key === neighbor.key).x, 123);
    assert.equal(state.simNodes.filter(node => !node.isPin).length, 3);
    view.api.unmount();
});

test('negative cosine neighbors draw finite positive radii and valid alpha at dot/text zooms', async () => {
    const view = viewContext('graph');
    view.data.index.a = entry(['opposed'], [[-1, 0]]);
    await view.api.mount(view.fixture);
    const pin = view.api.addTerm('anchor'); view.requests[0].resolve([1, 0]); await pin;
    assert.equal(view.api.state().simNodes[1].similarity, -1);
    const radii = [], styles = [];
    const context = new Proxy({
        arc(_x, _y, radius) { assert.ok(Number.isFinite(radius) && radius > 0); radii.push(radius); },
    }, {
        get: (target, property) => target[property] || (() => {}),
        set(target, property, value) { if (property === 'fillStyle' || property === 'strokeStyle') styles.push(value); target[property] = value; return true; },
    });
    for (const zoom of [0.1, 0.5, 0.7, 1]) assert.doesNotThrow(() => view.api.draw(context, zoom));
    assert.ok(radii.length > 0);
    for (const style of styles.filter(style => style.startsWith('rgba('))) {
        const alpha = Number(style.match(/,\s*([\d.-]+)\)$/)[1]);
        assert.ok(alpha >= 0 && alpha <= 1);
    }
    view.api.unmount();
});

test('worker PCA preserves varying axes with constant/diagonal coordinates and handles zero variance', () => {
    const output = [];
    const worker = sourceContext('semantic-map-worker.js', '', { self: { postMessage: message => output.push(message) } });
    const project = rows => {
        worker.self.onmessage({ data: { type: 'buildMapData', jobId: 1, vectorsFlatBuffer: new Float32Array(rows.flat()).buffer, dims: rows[0].length, fixedK: 2 } });
        assert.equal(output.at(-1).type, 'mapDataReady');
        return Array.from(new Float32Array(output.at(-1).points2dBuffer));
    };
    for (const rows of [
        [[0, -2, -1], [0, -2, 1], [0, 2, -1], [0, 2, 1]],
        [[-2, -1], [-2, 1], [2, -1], [2, 1]],
    ]) {
        const points = project(rows);
        assert.equal(new Set(Array.from({ length: 4 }, (_, i) => points.slice(i * 2, i * 2 + 2).join(','))).size, 4);
        let xy = 0, xx = 0, yy = 0;
        for (let i = 0; i < points.length; i += 2) { xy += points[i] * points[i + 1]; xx += points[i] ** 2; yy += points[i + 1] ** 2; }
        assert.ok(xx > 0 && yy > 0);
        assert.ok(Math.abs(xy) < 1e-6, 'principal axes are orthogonal rather than duplicated');
    }
    assert.ok(project([[7, 7], [7, 7], [7, 7]]).every(value => value === 0));
    const rankOne = project([[-2, -2], [-1, -1], [1, 1], [2, 2]]);
    assert.ok(rankOne.every(Number.isFinite));
    assert.ok(rankOne.filter((_, i) => i % 2).every(value => Math.abs(value) < 1e-6));
    assert.ok(project([[3], [3]]).every(value => value === 0));
});

test('map grid hit testing covers its tolerance across multiple cells and zoom levels', () => {
    const view = viewContext('map');
    const bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1 };
    view.api.setPoints([0.4999, 0.5], bounds, [500, 500], { x: 0, y: 0, w: 1, h: 1 });
    assert.equal(view.api.hit(259.5, 250), 0, '9.55px distance spans two cells but stays within 10px tolerance');
    assert.equal(view.api.hit(261, 250), -1, 'point outside tolerance is rejected');
    view.api.setPoints([0.5, 0.5], bounds, [500, 500], { x: -4.5, y: -4.5, w: 10, h: 10 });
    assert.equal(view.api.hit(259, 250), 0, 'zoomed-out tolerance spans many grid cells');
    view.api.setPoints([0.5, 0.5], bounds, [500, 500], { x: 0.45, y: 0.45, w: 0.1, h: 0.1 });
    assert.equal(view.api.hit(259, 250), 0, 'zoomed-in tolerance remains accurate');
    view.api.setPoints([0.5, 0.5], bounds, [500, 500], { x: -4.5, y: 0.45, w: 10, h: 0.1 });
    assert.equal(view.api.hit(250, 275), -1, 'anisotropic camera uses screen pixels instead of the larger world-space radius');
    assert.equal(view.api.hit(259, 250), 0);
});

for (const [name, project] of [['sync', pca3D], ['async', pca3DAsync]]) {
    test(`${name} PCA recovers variance beyond constant leading coordinates`, async () => {
        const result = await project([[0, 0, -2, -1], [0, 0, -2, 1], [0, 0, 2, -1], [0, 0, 2, 1]]);
        assert.equal(new Set(result.projected.map(point => point.join(','))).size, 4);
        assert.ok(result.projected.some(point => point[0] !== 0));
        assert.ok(result.projected.some(point => point[1] !== 0));
        const [a, b] = result.components;
        assert.ok(Math.abs(a.reduce((sum, value, i) => sum + value * b[i], 0)) < 1e-6);
        const identical = await project([[1, 1], [1, 1]]);
        assert.ok(identical.projected.flat().every(value => value === 0));
        const rankOne = await project([[-2, -2], [-1, -1], [1, 1], [2, 2]]);
        assert.ok(rankOne.projected.flat().every(Number.isFinite));
        assert.ok(rankOne.projected.every(point => Math.abs(point[1]) < 1e-6 && Math.abs(point[2]) < 1e-6));
    });
}

test('map recipe swaps and explicit cache clear discard cached queries, worker scores and hydration fallbacks', async () => {
    const view = viewContext('map');
    view.data.settings = { provider: 'ollama', model: 'same-model', ollamaUrl: 'http://endpoint-a' };
    view.data.index.a = entry(['one'], [[1, 0]]);
    await view.api.mount(view.fixture); finishMap(view.workers[0]);
    const first = view.api.query('same query'); view.requests[0].resolve([1, 0]); await first;
    const oldScore = view.workers[0].sent.at(-1);
    view.data.settings.ollamaUrl = 'http://endpoint-b';
    view.data.index.a = entry(['one'], [[0, 1]]);
    await view.api.update();
    assert.equal(view.workers[0].terminated, true);
    finishMap(view.workers[1]);
    const current = view.api.query('same query');
    assert.equal(view.requests.length, 2, 'same-dimensional endpoint swap does not reuse query cache');
    view.requests[1].resolve([0, 1]); await current;
    view.data.index = { hydrating: { isLoaded: false } };
    view.api.invalidate();
    view.workers[0].deliver({ type: 'queryScoresReady', jobId: oldScore.jobId, scoresBuffer: new Float32Array([1]).buffer });
    await view.api.update();
    assert.equal(view.api.state().messageRefs.length, 0, 'explicit clear cannot retain old points during hydration');
    assert.equal(view.api.state().scoreValues, null);
    view.data.index.a = entry(['new'], [[0, 1]]); await view.api.update(); finishMap(view.workers.at(-1));
    const afterClear = view.api.query('same query');
    assert.equal(view.requests.length, 3, 'explicit clear invalidates query cache even for unchanged recipe');
    view.requests[2].resolve([0, 1]); await afterClear; view.api.unmount();
});

test('graph endpoint changes and explicit cache clear cannot retain pending pins or old hydration vectors', async () => {
    const view = viewContext('graph');
    view.data.settings = { provider: 'ollama', model: 'same-model', ollamaUrl: 'http://endpoint-a' };
    view.data.index.a = entry(['one'], [[1, 0]]);
    await view.api.mount(view.fixture);
    const pending = view.api.addTerm('same query');
    view.data.settings.ollamaUrl = 'http://endpoint-b';
    view.requests[0].resolve([1, 0]); await pending;
    assert.equal(view.api.state().pins.length, 0);
    assert.equal(view.api.state().messageRefs.length, 0);
    view.data.index.a = entry(['one'], [[0, 1]]); view.api.update();
    const current = view.api.addTerm('same query'); view.requests[1].resolve([0, 1]); await current;
    assert.equal(view.api.state().pins.length, 1);
    const beforeClear = view.api.addTerm('pending clear');
    view.data.index = { hydrating: { isLoaded: false } }; view.api.invalidate(); view.api.update();
    view.requests[2].resolve([0, 1]); await beforeClear;
    assert.equal(view.api.state().messageRefs.length, 0);
    assert.equal(view.api.state().pins.length, 0);
    assert.equal(view.api.state().simNodes.length, 0); view.api.unmount();
});
