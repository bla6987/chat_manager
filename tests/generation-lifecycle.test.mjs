import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { initEmbeddingGenerationLifecycle } from '../src/generation-lifecycle.js';
import { setEmbeddingGenerationActive, scheduleEmbeddingBootstrap, scheduleIncrementalEmbedding } from '../src/ui-controller.js';
import { getEmbeddingSettings, setEmbeddingSettings } from '../src/metadata-store.js';
import { getEmbeddingRecipeKey } from '../src/embedding-service.js';

const names = ['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'MESSAGE_RECEIVED'];
function fixture() {
    const timers = new Map();
    let nextTimer = 0;
    const handlers = new Map();
    const eventTypes = Object.fromEntries(names.map(name => [name, name]));
    const eventSource = { on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); } };
    const emit = (name, ...args) => { for (const handler of handlers.get(name) || []) handler(...args); };
    const original = { setTimeout, clearTimeout, MutationObserver: globalThis.MutationObserver, window: globalThis.window, document: globalThis.document, AudioContext: globalThis.AudioContext, SillyTavern: globalThis.SillyTavern };
    globalThis.setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    globalThis.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
    const body = { dataset: {} };
    const observers = [];
    globalThis.document = { body, addEventListener() {} };
    globalThis.MutationObserver = class {
        constructor(fn) { this.fn = fn; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
        disconnect() { this.disconnected = true; }
    };
    const context = { extensionSettings: {}, characters: [{ avatar: 'fixture.png' }], characterId: 0, streamingProcessor: null, saveSettingsDebounced() {} };
    globalThis.SillyTavern = { getContext: () => context };
    const run = delay => {
        for (const [id, timer] of [...timers]) if (timer.delay === delay && timers.delete(id)) timer.fn();
    };
    return { eventTypes, eventSource, emit, context, body, observers, timers, run, restore() { for (const [key, value] of Object.entries(original)) globalThis[key] = value; } };
}

test('command-only starts and pre-request exits release real deferred embedding jobs', () => {
    const f = fixture();
    let cleanup;
    try {
        setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'fixture', embeddingLevels: { chat: true, message: false, query: false } });
        cleanup = initEmbeddingGenerationLifecycle({ ...f, setActive: setEmbeddingGenerationActive, getContext: () => f.context });
        // Host Generate: STARTED -> interruptedByCommand -> unblockGeneration,
        // with stop already hidden, so AFTER_COMMANDS/ENDED never occur.
        f.emit('GENERATION_STARTED', 'normal', {}, false);
        scheduleEmbeddingBootstrap('fixture.jsonl');
        assert.ok(f.timers.size > 0, 'a command-only exit never suspends automatic work');
        f.timers.clear();
        f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        scheduleEmbeddingBootstrap('fixture.jsonl');
        scheduleIncrementalEmbedding('fixture.jsonl');
        assert.equal(f.timers.size, 1, 'only the reconciliation timer runs during preparation');
        f.run(250);
        assert.equal(f.timers.size, 2, 'both deferred queues resume without ENDED');
    } finally { cleanup?.(); f.restore(); }
});

test('body lifecycle follows a delayed request and releases without terminal events', () => {
    const f = fixture();
    const active = [];
    try {
        const cleanup = initEmbeddingGenerationLifecycle({ ...f, setActive: value => active.push(value), getContext: () => f.context });
        f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        f.run(250);
        assert.equal(active.at(-1), false);
        f.body.dataset.generating = 'true';
        f.observers[0].fn();
        assert.equal(active.at(-1), true);
        delete f.body.dataset.generating;
        f.observers[0].fn();
        assert.equal(active.at(-1), false);
        assert.deepEqual(f.observers[0].options, { attributes: true, attributeFilter: ['data-generating'] });
        cleanup();
        assert.equal(f.timers.size, 0);
        assert.equal(f.observers[0].disconnected, true);
    } finally { f.restore(); }
});

test('a long valid foreground generation stays deferred while the host remains busy', () => {
    const f = fixture();
    const active = [];
    try {
        const cleanup = initEmbeddingGenerationLifecycle({ ...f, setActive: value => active.push(value), getContext: () => f.context });
        f.body.dataset.generating = 'true';
        f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        f.run(250);
        assert.equal(active.at(-1), true);
        f.run(15 * 60 * 1000);
        assert.equal(active.at(-1), true, 'elapsed time does not override actual host generation');
        assert.equal(f.timers.size, 0, 'busy foreground needs no permanent polling timer');
        delete f.body.dataset.generating;
        f.observers[0].fn();
        assert.equal(active.at(-1), false);
        cleanup();
    } finally { f.restore(); }
});

test('actual host command-only Generate preamble returns without leaving embeddings suspended', async t => {
    const hostPath = process.env.SILLYTAVERN_SCRIPT || new URL('../../../../source_projects/SillyTavern/public/script.js', import.meta.url);
    let hostSource;
    try { hostSource = await fs.readFile(hostPath, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') { t.skip('optional local SillyTavern source checkout unavailable'); return; }
        throw error;
    }
    const preamble = hostSource.match(/export async function Generate\([\s\S]*?(?=    if \(main_api == 'kobold')/);
    assert.ok(preamble, 'verified host generation preamble is available');
    const f = fixture();
    const active = [];
    try {
        const cleanup = initEmbeddingGenerationLifecycle({ ...f, setActive: value => active.push(value), getContext: () => f.context });
        f.eventSource.emit = async (name, ...args) => f.emit(name, ...args);
        let unblocked = false;
        const Generate = new Function('fixture', `
            const { eventSource, event_types, processCommands, unblockGeneration } = fixture;
            const console = { log() {} }, setGenerationProgress = () => {}, unshallowCharacter = async () => {};
            const this_chid = 0, power_user = { instruct: { enabled: false } }, main_api = 'openai';
            const $ = () => ({ val: () => '/echo command-only' });
            let generation_started, abortController;
            ${preamble[0].replace('export ', '')}
            return 'after-commands'; }
            return Generate;
        `)({ eventSource: f.eventSource, event_types: f.eventTypes, processCommands: async () => true, unblockGeneration: () => { unblocked = true; } });
        await Generate('normal');
        assert.equal(unblocked, true);
        assert.deepEqual(active, [false]);
        assert.equal(f.timers.size, 0);
        cleanup();
    } finally { f.restore(); }
});

test('dry runs do not suspend embeddings and manual stops cancel reconciliation', () => {
    const f = fixture();
    const active = [];
    try {
        const cleanup = initEmbeddingGenerationLifecycle({ ...f, setActive: value => active.push(value), getContext: () => f.context });
        f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, true);
        assert.deepEqual(active, [false]);
        f.emit('GENERATION_AFTER_COMMANDS', 'normal', {}, false);
        f.emit('GENERATION_STOPPED');
        assert.equal(active.at(-1), false);
        assert.equal(f.timers.size, 0);
        cleanup();
    } finally { f.restore(); }
});

test('alerts require an unsuccessful termination, ignore unrelated toasts, and clean attempt timers', async () => {
    const f = fixture();
    let toneCount = 0;
    let enabled = true;
    const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
    globalThis.AudioContext = class {
        state = 'running'; currentTime = 0; destination = {};
        createGain() { return { gain: param, connect() {}, disconnect() {} }; }
        createOscillator() { return { frequency: param, connect() {}, start() { toneCount++; }, stop() {} }; }
    };
    try {
        const { initGenerationFailureAlert } = await import(`../src/generation-failure-alert.js?test=${Date.now()}`);
        initGenerationFailureAlert({ ...f, getContext: () => f.context, isEnabled: () => enabled });
        const start = () => { f.emit('GENERATION_STARTED', 'normal'); f.emit('GENERATION_AFTER_COMMANDS', 'normal'); };
        start();
        // An unrelated extension's error can arrive during any successful reply.
        for (const observer of f.observers) observer.fn([{ addedNodes: [{ className: 'toast-error' }] }]);
        assert.equal(toneCount, 0);
        assert.equal(f.observers.length, 0, 'alerts do not observe unrelated DOM mutations');
        f.emit('MESSAGE_RECEIVED');
        f.emit('GENERATION_ENDED');
        f.run(180);
        assert.equal(f.timers.size, 0, 'successful settle cancels its expiry timer');
        assert.equal(toneCount, 0);

        start();
        f.emit('GENERATION_ENDED');
        f.emit('GENERATION_STOPPED');
        f.run(180);
        assert.equal(f.timers.size, 0);
        assert.equal(toneCount, 0, 'ENDED before STOPPED is a manual stop');

        start();
        f.emit('GENERATION_ENDED');
        f.run(180);
        await Promise.resolve(); await Promise.resolve();
        assert.equal(toneCount, 2, 'missing-response failure schedules the two-tone cue');
        f.run(650);
        assert.equal(f.timers.size, 0);

        start();
        f.emit('MESSAGE_RECEIVED');
        f.context.streamingProcessor = { isStopped: true, isFinished: false };
        f.emit('GENERATION_ENDED');
        f.run(180);
        await Promise.resolve(); await Promise.resolve();
        assert.equal(toneCount, 4, 'a failed stream alerts even after a partial response');
        f.run(650);
        f.context.streamingProcessor = null;

        start();
        start();
        assert.equal(f.timers.size, 1, 'replacement cancels the previous expiry');
        f.run(15 * 60 * 1000);
        f.emit('GENERATION_ENDED');
        assert.equal(f.timers.size, 0, 'expiry clears an abandoned attempt without alerting');
        assert.equal(toneCount, 4);
        enabled = false;
        start();
        assert.equal(f.timers.size, 0, 'disabled alerts allocate no attempt timers');
    } finally { f.restore(); }
});

test('entry point invalidates local edits before optional display/embedding updates', async () => {
    const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    const match = source.match(/const onMessageUpdate = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
    assert.ok(match);
    const f = fixture();
    const dirty = [];
    try {
        const callback = new Function('SillyTavern', 'getActiveChatFile', 'getIndexCharacterAvatar', 'markChatDirty', `${match[0]}; return onMessageUpdate;`)(
            globalThis.SillyTavern, () => 'fixture.jsonl', () => 'fixture.png', file => dirty.push(file),
        );
        callback();
        assert.deepEqual(dirty, ['fixture.jsonl'], 'cache invalidation is synchronous before the optional debounce');
        f.context.characters[0].avatar = 'other.png';
        callback();
        assert.deepEqual(dirty, ['fixture.jsonl'], 'another character cannot invalidate a same-named indexed thread');
    } finally { f.restore(); }
});

test('branch injection refreshes the live edited snapshot with panel and embeddings off', async () => {
    const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    const match = source.match(/const onMessageUpdate = \(\(\) => \{[\s\S]*?\n\}\)\(\);/);
    const f = fixture();
    const operations = [];
    try {
        const fixtureValues = {
            SillyTavern: globalThis.SillyTavern, getActiveChatFile: () => 'fixture.jsonl', getIndexCharacterAvatar: () => 'fixture.png',
            markChatDirty: () => operations.push('dirty'), isEmbeddingGenerationEnabled: () => false, isPanelOpen: () => false,
            isBranchContextActive: () => true, updateActiveChat: async () => { operations.push('update'); return true; },
            updateBranchContextInjection: () => operations.push('inject'), clearBranchContextInjection() {},
        };
        const callback = new Function(...Object.keys(fixtureValues), `${match[0]}; return onMessageUpdate;`)(...Object.values(fixtureValues));
        callback();
        const scheduled = [...f.timers.values()].find(timer => timer.delay === 250);
        await scheduled.fn();
        assert.deepEqual(operations, ['dirty', 'update', 'inject']);
    } finally { f.restore(); }
});

test('endpoint-only settings changes invalidate in-flight work, dimensions, and live vectors', async () => {
    const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    const match = source.match(/    const persistForm = \(\) => \{[\s\S]*?\n    \};/);
    assert.ok(match);
    const f = fixture();
    try {
        setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'fixture', ollamaUrl: 'http://server-a:11434', dimensions: 3 });
        const fields = {
            enabledEl: { checked: true }, levelChatEl: { checked: true }, levelMessageEl: { checked: true }, levelQueryEl: { checked: true },
            providerEl: { value: 'ollama' }, apiKeyEl: { value: '' }, ollamaUrlEl: { value: 'http://server-b:11434/' }, modelEl: { value: 'fixture' },
            colorModeEl: { value: 'cluster' }, scopeModeEl: { value: 'all' }, includeAltSwipesEl: { checked: false }, showAltResultsEl: { checked: false },
            maxSwipesEl: { value: '8' }, swipeBatchEl: { value: '24' }, swipeDelayEl: { value: '650' },
        };
        let invalidations = 0, vectorClears = 0;
        const fixtureNames = [...Object.keys(fields), 'getEmbeddingSettings', 'setEmbeddingSettings', 'getEmbeddingRecipeKey', 'invalidateEmbeddingOperations', 'clearInMemoryEmbeddings'];
        const persist = new Function(...fixtureNames, `${match[0]}; return persistForm;`)(
            ...Object.values(fields), getEmbeddingSettings, setEmbeddingSettings, getEmbeddingRecipeKey, () => invalidations++, () => vectorClears++,
        );
        persist();
        assert.equal(invalidations, 1);
        assert.equal(vectorClears, 1);
        assert.equal(getEmbeddingSettings().dimensions, null);
        fields.ollamaUrlEl.value = 'http://server-b:11434';
        persist();
        assert.equal(invalidations, 1, 'normalization-equivalent endpoint does not discard vectors');
        assert.equal(vectorClears, 1);
    } finally { f.restore(); }
});

test('explicit reopen revalidates cached files while host chat switching keeps default refresh', async () => {
    const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    const open = source.match(/async function openChatManager\(event\) \{[\s\S]*?\n\}/);
    assert.ok(open);
    const calls = [];
    const run = new Function('getDisplayMode', 'ensureUI', 'isPanelOpen', 'refreshPanel', 'togglePanel', 'document', `${open[0]}; return openChatManager;`)(
        () => 'panel', async () => true, () => true, async options => calls.push(options), async () => assert.fail('already open'), { getElementById: () => null },
    );
    assert.equal(await run(), true);
    assert.deepEqual(calls, [{ forceRevalidate: true }]);
    const switched = source.match(/async function onChatChanged\(\) \{[\s\S]*$/);
    assert.ok(switched[0].includes('void refreshPanel().catch('), 'host switch keeps nonblocking incremental refresh');
});

test('settings generate action reports superseded runs without a success toast', async () => {
    const source = await fs.readFile(new URL('../index.js', import.meta.url), 'utf8');
    const match = source.match(/    generateBtn\.addEventListener\('click', async \(\) => \{[\s\S]*?\n    \}\);/);
    assert.ok(match);
    let handler;
    const messages = [];
    const buttonStates = [];
    const timers = [];
    let result = { superseded: true };
    const fixtureValues = {
        generateBtn: { addEventListener(_name, callback) { handler = callback; } }, persistForm() {},
        getEmbeddingSettings: () => ({ embeddingLevels: { chat: true } }),
        setEmbeddingActionButtonsDisabled: value => buttonStates.push(value), setProgress() {},
        generateEmbeddingsForCurrentIndex: async () => result, refreshCacheStats: async () => {},
        toastr: { info: text => messages.push(['info', text]), success: text => messages.push(['success', text]), error: text => messages.push(['error', text]) },
        setTimeout: (_fn, delay) => timers.push(delay), hideProgress() {}, MODULE_NAME: 'chat_manager',
    };
    new Function(...Object.keys(fixtureValues), match[0])(...Object.values(fixtureValues));
    await handler();
    assert.deepEqual(messages.map(([level]) => level), ['info']);
    assert.match(messages[0][1], /changed/);
    assert.deepEqual(buttonStates, [true, false], 'finally restores action buttons after early return');
    assert.deepEqual(timers, [800]);
    messages.length = 0;
    result = { updated: 2, messageVectors: 3, clusters: 1 };
    await handler();
    assert.deepEqual(messages.map(([level]) => level), ['success']);
    assert.match(messages[0][1], /2 chats, 3 messages/);
});
