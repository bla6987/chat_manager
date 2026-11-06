import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/ui-controller.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');

function fixture({ complete = true } = {}) {
    const timers = new Map(), requests = [], paints = [];
    const input = { value: 'needle' };
    let hydrationListener, nextTimer = 0;
    const sandbox = vm.createContext({
        Map, Set, WeakMap, WeakSet, console,
        document: { getElementById: id => id === 'chat-manager-search' ? input : {} },
        setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
        clearTimeout: id => timers.delete(id),
        onEmbeddingDimensionsInvalidated() {},
        onHydrationUpdate: callback => { hydrationListener = callback; },
        isHydrationComplete: () => complete,
        paints,
        scan: (query, requestId) => new Promise(resolve => requests.push({ query, requestId, resolve })),
    });
    vm.runInContext(source, sandbox);
    vm.runInContext(`
        panelOpen = true;
        shouldUseSemanticSearch = () => true;
        setSearchModeBadge = () => {};
        renderThreadCards = () => paints.push('cards');
        performSemanticSearch = async (query, requestId) => {
            await scan(query, requestId);
            if (requestId === latestSearchRequestId) paints.push(query);
        };
        ensureHydrationSubscription();
    `, sandbox);
    return {
        sandbox, timers, requests, paints, input,
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

test('background indexing lets a pending search finish before one coalesced refresh', async () => {
    const f = fixture();
    const search = f.start();
    for (let i = 0; i < 8; i++) {
        f.hydrate();
        await f.runTimers();
        assert.equal(f.requests.length, 1);
    }
    f.requests[0].resolve();
    await search;
    assert.deepEqual(f.paints, ['needle']);
    assert.equal(f.timers.size, 1);
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve();
});

test('indexing batches wait for completion even when no scan is running', async () => {
    const f = fixture({ complete: false });
    const search = f.start();
    f.hydrate(false);
    f.requests[0].resolve();
    await search;
    await f.runTimers();
    assert.equal(f.requests.length, 1);
    f.hydrate(true);
    f.hydrate(true);
    assert.equal(f.timers.size, 1);
    await f.runTimers();
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve();
});

test('a new query consumes queued refreshes and supersedes old search work', async () => {
    const f = fixture();
    f.hydrate();
    const first = f.start();
    await f.runTimers();
    assert.equal(f.requests.length, 1);
    f.hydrate();
    const second = f.start('changed query');
    f.hydrate();
    f.requests[0].resolve();
    await first;
    await f.runTimers();
    assert.equal(f.requests.length, 2, 'an old completion cannot release the new scan guard');
    assert.deepEqual(f.paints, []);
    f.requests[1].resolve();
    await second;
    assert.deepEqual(f.paints, ['changed query']);
    await f.runTimers();
    assert.equal(f.requests[2].query, 'changed query');
    f.requests[2].resolve();
});

for (const transition of ['reset', 'clear query', 'close', 'alternate view']) {
    test(`queued indexing work cannot revive search after ${transition}`, async () => {
        const f = fixture();
        const search = f.start();
        f.hydrate();
        if (transition === 'clear query') await f.start('');
        else {
            f.sandbox.resetSearchState();
            if (transition === 'close') vm.runInContext('panelOpen = false;', f.sandbox);
            if (transition === 'alternate view') vm.runInContext('timelineActive = true;', f.sandbox);
        }
        f.requests[0].resolve();
        await search;
        await f.runTimers();
        assert.equal(f.requests.length, 1);
        assert.equal(f.paints.includes('needle'), false);
    });
}

test('an already scheduled refresh respects a view switch before its timer fires', async () => {
    const f = fixture();
    f.hydrate();
    vm.runInContext('statsActive = true;', f.sandbox);
    await f.runTimers();
    assert.equal(f.requests.length, 0);
});

