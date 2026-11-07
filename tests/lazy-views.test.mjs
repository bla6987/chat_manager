import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const VIEW_MODULES = ['icicle-view', 'icicle-data', 'semantic-map-view', 'graph-view', 'stats-view', 'stats-engine'];

test('nothing the page loads at startup imports a view module directly', () => {
    const seen = new Set();
    const visit = (file, base) => {
        const path = `${base}${file}`;
        if (seen.has(path)) return;
        seen.add(path);
        const text = source(path);
        // Only static imports count; lazy-views.js uses import().
        for (const [, dependency] of text.matchAll(/^import\s[^;]*?from\s+'\.\/([^']+)'/gms)) {
            const [nextBase, nextFile] = dependency.startsWith('src/') ? ['src/', dependency.slice(4)] : [base, dependency];
            visit(nextFile, nextBase);
        }
    };
    visit('index.js', '');
    for (const view of VIEW_MODULES) assert.equal(seen.has(`src/${view}.js`), false, view);
    assert.ok(seen.has('src/lazy-views.js'));
});

test('every view export the controller uses exists on the module it loads', async () => {
    const lazy = source('src/lazy-views.js');
    const modules = new Map();
    for (const [, variable, file] of lazy.matchAll(/const (\w+) = lazyView\(\(\) => import\('\.\/([\w-]+\.js)'\)/g)) modules.set(variable, source(`src/${file}`));
    assert.equal(modules.size, 4);
    let checked = 0;
    for (const [, variable, name] of lazy.matchAll(/export const \w+ = (\w+)\.\w+\('(\w+)'/g)) {
        assert.match(modules.get(variable), new RegExp(`export (async )?function ${name}\\b`), name);
        checked++;
    }
    assert.ok(checked >= 25);
});

// Exercise the loading behaviour with the real facade and a stand-in for one view.
const calls = [];
let releaseImport;
const facadeSource = source('src/lazy-views.js')
    .replace(/import\('\.\/stats-view\.js'\)/, 'globalThis.loadStatsView()');
const lazy = await import(`data:text/javascript;base64,${Buffer.from(facadeSource).toString('base64')}`);
const statsModule = {
    mountStatsView: (...args) => { calls.push(['mount', ...args]); },
    unmountStatsView: () => { calls.push(['unmount']); },
    updateStatsView: () => { calls.push(['update']); },
    isStatsMounted: () => true,
    setStatsCallbacks: (...args) => { calls.push(['callbacks', ...args]); },
};

test('an unloaded view reports unmounted and ignores updates without loading', () => {
    let imports = 0;
    globalThis.loadStatsView = () => { imports++; return Promise.resolve(statsModule); };
    assert.equal(lazy.isStatsMounted(), false);
    lazy.updateStatsView();
    lazy.unmountStatsView();
    assert.equal(imports, 0);
    assert.deepEqual(calls, []);
    delete globalThis.loadStatsView;
});

test('a teardown cancels a mount still loading, a retry after failure works, then it mounts once', async () => {
    const consoleError = console.error; console.error = () => {};
    globalThis.toastr = { error: message => calls.push(['toast', message]) };
    try {
        globalThis.loadStatsView = () => Promise.reject(new Error('offline'));
        await lazy.mountStatsView('failed');
        assert.deepEqual(calls.pop(), ['toast', 'Could not load the stats view.']);

        globalThis.loadStatsView = () => new Promise(resolve => { releaseImport = () => resolve(statsModule); });
        lazy.setStatsCallbacks('old');
        lazy.setStatsCallbacks('new');
        const cancelled = lazy.mountStatsView('cancelled');
        lazy.unmountStatsView();
        releaseImport();
        await cancelled;
        assert.deepEqual(calls, [['callbacks', 'new']], 'only the latest settings are applied, and no mount ran');

        calls.length = 0;
        await lazy.mountStatsView('container');
        assert.deepEqual(calls, [['mount', 'container']]);
        assert.equal(lazy.isStatsMounted(), true);
        calls.length = 0;
        lazy.updateStatsView();
        lazy.setStatsCallbacks('direct');
        assert.deepEqual(calls, [['update'], ['callbacks', 'direct']], 'once loaded, calls go straight through');
    } finally {
        console.error = consoleError; delete globalThis.toastr; delete globalThis.loadStatsView;
    }
});
