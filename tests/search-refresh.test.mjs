import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { searchArchivePage } from '../src/archive-search.js';

const source = readFileSync(new URL('../src/ui-controller.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((r, j) => { resolve = r; reject = j; });
    return { promise, resolve, reject };
};
const emptyPage = { results: [], scanned: 2000, pageReferences: [], hasMore: false };

async function until(predicate) {
    for (let i = 0; i < 30; i++) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail('Expected search work did not start');
}

function fixture({ complete = true, semantic = false, queryEmbedding = async () => [1], scan } = {}) {
    const index = {};
    const timers = new Map();
    const requests = [];
    const paints = [];
    const input = { value: 'needle' };
    const status = { textContent: '' };
    let nextTimer = 0;
    let hydrationListener;
    const sandbox = vm.createContext({
        console: { warn() {} }, AbortController, DOMException, Map, Set, WeakMap, WeakSet,
        document: { getElementById: id => id === 'chat-manager-search' ? input : id === 'chat-manager-status' ? status : {} },
        setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        onEmbeddingDimensionsInvalidated() {},
        onHydrationUpdate: callback => { hydrationListener = callback; },
        isHydrationComplete: () => complete,
        getIndex: () => index, hashEmbeddingText: text => text,
        getQueryEmbeddingKey: query => query, getEmbeddingOption: (_settings, _key, fallback) => fallback,
        getIndexVersion: () => 1,
        getEmbeddingSettings: () => ({}),
        captureEmbeddingOperation: () => ({}),
        isEmbeddingOperationCurrent: () => true,
        semantic,
        queryEmbedding,
        paints,
        searchArchivePage: options => {
            if (scan) {
                requests.push(options);
                return scan(options);
            }
            const pending = deferred();
            requests.push({ ...options, ...pending });
            return pending.promise;
        },
    });
    vm.runInContext(source, sandbox);
    vm.runInContext(`
        panelOpen = true;
        shouldUseSemanticSearch = () => semantic;
        getSemanticQueryEmbedding = () => queryEmbedding();
        setSearchModeBadge = () => {};
        renderThreadCards = () => paints.push('cards');
        renderSearchState = (_container, _status, query) => paints.push(query);
        ensureHydrationSubscription();
    `, sandbox);
    return {
        sandbox, timers, requests, paints, input, status,
        hydrate(done = complete) { complete = done; hydrationListener(); },
        async runTimers() {
            const callbacks = [...timers.values()];
            timers.clear();
            for (const callback of callbacks) callback();
            await Promise.resolve();
        },
        start(query = 'needle') { input.value = query; return sandbox.performSearch(query); },
    };
}

test('a real archive scan checks all 2000 messages while indexing notifications arrive', async () => {
    const progress = [];
    const f = fixture({ scan: options => searchArchivePage({
        ...options,
        sourceFactory: async function* () {
            for (let i = 0; i < 2000; i++) yield { text: 'unmatched message', msgIndex: i };
        },
        onProgress: count => {
            options.onProgress(count);
            progress.push(count);
            f.hydrate();
            assert.equal(f.timers.size, 0, 'no restart is queued during the real scan');
        },
    }) });
    await f.start();
    assert.deepEqual(progress, [250, 500, 750, 1000, 1250, 1500, 1750, 2000]);
    assert.equal(f.requests.length, 1);
    assert.deepEqual(f.paints, ['needle']);
    assert.equal(f.timers.size, 1);
});

test('indexing updates preserve an active scan past 750 and produce one later refresh', async () => {
    const f = fixture();
    const search = f.start();
    const scan = f.requests[0];
    for (const count of [250, 500, 750, 1000, 1250]) {
        scan.onProgress(count);
        f.hydrate();
        await f.runTimers();
        assert.equal(scan.signal.aborted, false);
        assert.equal(f.requests.length, 1);
        assert.match(f.status.textContent, new RegExp(count.toLocaleString() + ' messages checked'));
    }
    scan.resolve(emptyPage);
    await search;
    assert.deepEqual(f.paints, ['needle'], 'the original scan publishes results');
    assert.equal(f.timers.size, 1, 'all updates coalesce after the scan finishes');
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve(emptyPage);
    await Promise.resolve();
});

test('indexing batches wait until indexing is complete even after the scan finishes', async () => {
    const f = fixture({ complete: false });
    const search = f.start();
    for (let i = 0; i < 10; i++) f.hydrate(false);
    f.requests[0].resolve(emptyPage);
    await search;
    await f.runTimers();
    assert.equal(f.requests.length, 1);
    f.hydrate(true);
    f.hydrate(true);
    assert.equal(f.timers.size, 1);
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve(emptyPage);
});

test('an explicit new search consumes an already queued indexing refresh', async () => {
    const f = fixture();
    f.hydrate();
    assert.equal(f.timers.size, 1);
    const search = f.start('new query');
    await f.runTimers();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].signal.aborted, false);
    f.requests[0].resolve(emptyPage);
    await search;
    assert.equal(f.timers.size, 0);
});

test('a new query cancels the old scan without losing the new scan refresh guard', async () => {
    const f = fixture();
    const first = f.start();
    f.hydrate();
    const second = f.start('new query');
    assert.equal(f.requests[0].signal.aborted, true);
    f.hydrate();
    f.requests[0].resolve(emptyPage);
    await first;
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].signal.aborted, false);
    assert.deepEqual(f.paints, []);
    f.requests[1].resolve(emptyPage);
    await second;
    assert.deepEqual(f.paints, ['new query']);
    await f.runTimers();
    assert.equal(f.requests[2].query, 'new query');
    f.requests[2].resolve(emptyPage);
});

for (const transition of ['reset', 'clear query', 'close', 'alternate view']) {
    test(`deferred indexing refresh cannot revive search after ${transition}`, async () => {
        const f = fixture();
        const search = f.start();
        f.hydrate();
        if (transition === 'clear query') await f.start('');
        else {
            f.sandbox.resetSearchState();
            if (transition === 'close') vm.runInContext('panelOpen = false;', f.sandbox);
            if (transition === 'alternate view') vm.runInContext('timelineActive = true;', f.sandbox);
        }
        assert.equal(f.requests[0].signal.aborted, true);
        f.requests[0].resolve(emptyPage);
        await search;
        await f.runTimers();
        assert.equal(f.requests.length, 1);
        assert.equal(f.paints.includes('needle'), false);
    });
}

test('queued refresh respects a view change before its timer fires', async () => {
    const f = fixture();
    f.hydrate();
    vm.runInContext('statsActive = true;', f.sandbox);
    await f.runTimers();
    assert.equal(f.requests.length, 0);
});

test('a failed scan releases the guard so a deferred refresh can retry', async () => {
    const f = fixture();
    const search = f.start();
    f.hydrate();
    f.requests[0].reject(new Error('Synthetic archive failure'));
    await search;
    assert.match(f.status.textContent, /could not finish/);
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve(emptyPage);
});

test('background indexing also waits for an in-flight results page', async () => {
    const f = fixture();
    const search = f.start();
    f.requests[0].resolve({ ...emptyPage, hasMore: true });
    await search;
    const requestId = vm.runInContext('latestSearchRequestId', f.sandbox);
    const page = f.sandbox.performArchiveSearch('needle', requestId, 'keyword', 1);
    f.hydrate();
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].signal.aborted, false);
    f.requests[1].resolve(emptyPage);
    await page;
    assert.equal(vm.runInContext('searchState.pageIndex', f.sandbox), 1);
    assert.equal(f.timers.size, 1);
});

test('semantic query embedding remains in flight through indexing updates', async () => {
    const embedding = deferred();
    const f = fixture({ semantic: true, queryEmbedding: () => embedding.promise });
    const search = f.start();
    f.hydrate();
    await f.runTimers();
    assert.equal(f.requests.length, 0, 'no duplicate embedding or archive request starts');
    embedding.resolve([1]);
    await until(() => f.requests.length === 1);
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve(emptyPage);
    await search;
    assert.deepEqual(f.paints, ['needle']);
    assert.equal(f.timers.size, 1);
});

test('empty semantic search falls back without a refresh interrupting the keyword scan', async () => {
    const f = fixture({ semantic: true });
    const search = f.start();
    await until(() => f.requests.length === 1);
    f.hydrate();
    f.requests[0].resolve({ ...emptyPage, scanned: 0 });
    await until(() => f.requests.length === 2);
    assert.equal(f.requests[1].mode, 'keyword');
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].signal.aborted, false);
    f.requests[1].resolve(emptyPage);
    await search;
    assert.deepEqual(f.paints, ['needle']);
    assert.equal(f.timers.size, 1);
});

