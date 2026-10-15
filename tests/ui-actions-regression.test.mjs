import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as meta from '../src/metadata-store.js';
import * as reader from '../src/chat-reader.js';
import { timestampMs } from '../src/timestamps.js';

const source = fs.readFileSync(new URL('../src/ui-controller.js', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };

class Element {
    constructor(tag = 'div') {
        this.tag = tag; this.className = ''; this.dataset = {}; this.children = [];
        this.listeners = {}; this.style = {}; this.value = ''; this.isConnected = true;
        this.classList = {
            add: (...names) => { this.className = [...new Set([...this.className.split(' '), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(' ').filter(n => !names.includes(n)).join(' '); },
            contains: name => this.className.split(' ').includes(name),
            toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
        };
    }
    addEventListener(kind, fn) { (this.listeners[kind] ??= []).push(fn); }
    appendChild(el) { el.parent = this; this.children.push(el); return el; }
    matches(selector) { return selector[0] === '.' && this.classList.contains(selector.slice(1)); }
    closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
    querySelector(selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child;
            const nested = child.querySelector(selector); if (nested) return nested;
        }
        return null;
    }
    querySelectorAll() { return []; }
    replaceWith(el) { const parent = this.parent; parent.children[parent.children.indexOf(this)] = el; el.parent = parent; this.parent = null; }
    focus() {} select() {}
    blur() { this.dispatch('blur', false); }
    dispatch(kind, bubbles = true, detail = {}) {
        let stopped = false;
        const event = { target: this, stopPropagation() { stopped = true; }, preventDefault() {}, ...detail };
        for (let el = this; el; el = bubbles && !stopped ? el.parent : null) {
            event.currentTarget = el;
            for (const fn of el.listeners[kind] || []) fn(event);
        }
    }
}

function setup(overrides = {}) {
    const context = {
        characterId: 0, characters: [{ avatar: 'alpha.png' }, { avatar: 'beta.png' }], name2: 'Alpha',
        extensionSettings: {}, chat: [], saveSettingsDebounced() {},
    };
    const nodes = new Map([['chat-manager-content', new Element()], ['chat-manager-status', new Element()]]);
    const toasts = [];
    const timers = [];
    const index = {};
    const settings = { enabled: true, provider: 'ollama', model: 'synthetic', embeddingLevels: { chat: false, message: true, query: true }, includeAlternateSwipes: true };
    let currentOperation = true;
    const token = { settings };
    const globals = {
        console, Map, Set, WeakMap, WeakSet, Promise, Symbol, CSS: { escape: x => x },
        SillyTavern: { getContext: () => context, libs: { DOMPurify: { sanitize: x => x } } },
        document: { createElement: tag => new Element(tag), getElementById: id => nodes.get(id) || null, querySelector: () => null, removeEventListener() {} },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, requestAnimationFrame() {},
        toastr: Object.fromEntries(['success', 'warning', 'error', 'info'].map(kind => [kind, message => toasts.push({ kind, message })])),
        ...meta,
        timestampMs,
        persistThreadFocus: meta.setThreadFocus,
        getIndex: () => index, getIndexVersion: () => 1, getEmbeddingSettings: () => settings,
        getHydrationProgress: () => ({ loaded: 0, total: 0 }), isHydrationComplete: () => true,
        getSearchableMessages: () => [], isEmbeddingConfigured: () => true,
        getMessageActiveSwipeIndex: reader.getMessageActiveSwipeIndex,
        getMessageEmbedding: reader.getMessageEmbedding, setMessageEmbedding: reader.setMessageEmbedding,
        ensureMessageEmbeddingMap: reader.ensureMessageEmbeddingMap, makeMessageEmbeddingKey: reader.makeMessageEmbeddingKey,
        hashEmbeddingText: text => text,
        captureEmbeddingOperation: () => token, isEmbeddingOperationCurrent: operation => currentOperation && operation === token,
        invalidateEmbeddingOperations: () => { currentOperation = false; }, isStaleEmbeddingOperationError: () => false,
        onEmbeddingDimensionsInvalidated() {},
        getCachedEmbeddingsForTexts: async texts => texts.map(() => null), embedTexts: async texts => texts.map(() => [1, 0]),
        setStatsCallbacks() {}, mountStatsView() {}, unmountStatsView() {}, isStatsMounted: () => false,
        setIcicleCallbacks() {}, setIcicleThreadFocus() {}, unmountIcicle() {},
        setSemanticMapCallbacks() {}, unmountSemanticMap() {}, isSemanticMapMounted: () => false,
        setGraphViewCallbacks() {}, setGraphScope() {}, unmountGraphView() {}, isGraphViewMounted: () => false,
        invalidateIcicleEmbeddings() {}, invalidateSemanticMapEmbeddings() {}, invalidateGraphEmbeddings() {},
        navigateToChat: async () => true,
        ...overrides,
    };
    globalThis.SillyTavern = globals.SillyTavern;
    const sandbox = vm.createContext(globals);
    vm.runInContext(source, sandbox);
    vm.runInContext("setSearchModeBadge = () => {}; getActiveFilename = () => 'active.jsonl'; getSummarySiblingContextText = () => '';", sandbox);
    return { sandbox, context, nodes, toasts, index, settings, timers, invalidate: () => { currentOperation = false; } };
}

function editableCard(sandbox) {
    const container = new Element(); sandbox.bindCardEvents(container);
    const card = container.appendChild(new Element()); card.className = 'chat-manager-card';
    const name = card.appendChild(new Element('span')); name.className = 'chat-manager-display-name'; name.dataset.filename = 'target.jsonl';
    const button = card.appendChild(new Element('i')); button.dataset.filename = 'target.jsonl';
    sandbox.handleEditDisplayName({ currentTarget: button, stopPropagation() {} });
    return { card, input: card.children[0] };
}

test('clearing/reverting edited titles persists the reset and replacement title has one delegated navigation handler', async () => {
    let opens = 0;
    const { sandbox } = setup({ navigateToChat: async () => { opens++; return true; } });
    for (const value of ['', 'target.jsonl']) {
        meta.setDisplayName('target.jsonl', 'Old title');
        const { card, input } = editableCard(sandbox);
        input.value = value; input.blur();
        assert.equal(meta.getDisplayName('target.jsonl'), '');
        assert.equal(card.children[0].textContent, 'target.jsonl');
        const before = opens; card.children[0].dispatch('click');
        assert.equal(opens, before + 1);
    }
    meta.setDisplayName('target.jsonl', 'Original');
    const { card, input } = editableCard(sandbox);
    input.value = 'Cancelled'; input.dispatch('keydown', false, { key: 'Escape' });
    assert.equal(meta.getDisplayName('target.jsonl'), 'Original');
    const before = opens; card.children[0].dispatch('click'); assert.equal(opens, before + 1);
});

for (const transition of ['clear-input', 'short-direct-query', 'stats', 'timeline', 'semantic-map', 'graph', 'close']) {
    test(`pending semantic response cannot overwrite ${transition}`, async () => {
        const { sandbox } = setup(); const pending = deferred(); const paints = [];
        sandbox.pending = pending.promise; sandbox.paints = paints;
        vm.runInContext("shouldUseSemanticSearch = () => true; getSemanticQueryEmbedding = () => pending; renderThreadCards = () => paints.push('cards'); renderSearchState = () => paints.push('stale-results');", sandbox);
        const request = sandbox.performSearch('swords');
        if (transition === 'clear-input') sandbox.onSearchInput('');
        if (transition === 'short-direct-query') await sandbox.performSearch('x');
        if (transition === 'stats') sandbox.toggleStats();
        if (transition === 'timeline') sandbox.toggleTimeline();
        if (transition === 'semantic-map') sandbox.toggleSemanticMap();
        if (transition === 'graph') sandbox.toggleGraphView();
        if (transition === 'close') sandbox.closeSidePanel();
        pending.resolve([1]); await request;
        assert.equal(paints.includes('stale-results'), false);
    });
}

for (const handler of ['handleAITitle', 'handleRegenSummary', 'handleAISummaryAndTitle']) {
    test(`${handler} keeps click-time messages and writes only the original character`, async () => {
        const pending = deferred(); const calls = [];
        const { sandbox, context, index } = setup({
            generateTitleForChat: async (messages, name) => { calls.push({ kind: 'title', messages: structuredClone(messages), name }); return handler === 'handleAITitle' ? pending.promise : 'Alpha title'; },
            generateSummaryForChat: async (messages, name) => { calls.push({ kind: 'summary', messages: structuredClone(messages), name }); return pending.promise; },
        });
        vm.runInContext("getActiveFilename = () => 'target.jsonl';", sandbox);
        index['target.jsonl'] = { isLoaded: true, fileName: 'target.jsonl', branchPoint: null, messages: [{ role: 'user', text: 'old indexed content' }] };
        context.chat = [{ is_user: true, mes: 'clicked content' }];
        meta.setChatMeta('target.jsonl', { displayName: 'Beta original', summary: 'Beta original' }, 'beta.png');
        const btn = new Element('i'); btn.dataset.filename = 'target.jsonl';
        const request = sandbox[handler]({ currentTarget: btn, stopPropagation() {} });
        context.chat[0].mes = 'changed during request'; context.characterId = 1; context.name2 = 'Beta';
        pending.resolve(handler === 'handleAITitle' ? 'Alpha title' : 'Alpha summary'); await request;
        const alpha = meta.getChatMeta('target.jsonl', 'alpha.png'); const beta = meta.getChatMeta('target.jsonl', 'beta.png');
        assert.equal(beta.displayName, 'Beta original'); assert.equal(beta.summary, 'Beta original');
        assert.equal(handler === 'handleRegenSummary' ? alpha.summary : alpha.displayName, handler === 'handleRegenSummary' ? 'Alpha summary' : 'Alpha title');
        for (const call of calls) { assert.deepEqual(call.messages, [{ role: 'user', text: 'clicked content' }]); assert.equal(call.name, 'Alpha'); }
    });
}

function renameSetup({ confirmed = true, switchAfter = false, popupResult = 'new name' } = {}) {
    const listeners = new Map(); let renameCalls = 0;
    const env = setup(); const { context, sandbox } = env;
    context.POPUP_TYPE = { INPUT: 2 };
    context.Popup = class { constructor(_html, type, defaultValue) { assert.equal(type, 2); assert.equal(defaultValue, 'target'); } async show() { return popupResult; } };
    context.eventTypes = { CHAT_RENAMED: 'renamed' };
    context.eventSource = { on: (type, fn) => listeners.set(type, fn), removeListener: type => listeners.delete(type) };
    context.renameChat = async () => {
        renameCalls++;
        if (switchAfter) context.characterId = 1;
        if (confirmed) listeners.get('renamed')({ avatarId: 'alpha.png', oldFileName: 'target.jsonl', newFileName: 'new_name.jsonl' });
    };
    vm.runInContext('refreshPanel = async () => {};', sandbox);
    meta.setChatMeta('target.jsonl', { summary: 'Alpha' }, 'alpha.png');
    meta.setChatMeta('target.jsonl', { summary: 'Beta' }, 'beta.png');
    return { ...env, listeners, renamed: () => renameCalls };
}

test('native input rename survives dialog removal and migrates only confirmed original-character metadata', async () => {
    const { sandbox, listeners, renamed } = renameSetup({ switchAfter: true });
    await sandbox.handleRenameFile({ stopPropagation() {}, currentTarget: { dataset: { filename: 'target.jsonl' } } });
    assert.equal(renamed(), 1); assert.equal(listeners.size, 0);
    assert.equal(meta.getChatMeta('new_name.jsonl', 'alpha.png').summary, 'Alpha');
    assert.equal(meta.getChatMeta('target.jsonl', 'beta.png').summary, 'Beta');
});

test('resolved host rename failure neither migrates metadata nor reports success', async () => {
    const { sandbox, listeners, toasts } = renameSetup({ confirmed: false });
    await sandbox.handleRenameFile({ stopPropagation() {}, currentTarget: { dataset: { filename: 'target.jsonl' } } });
    assert.equal(meta.getChatMeta('target.jsonl', 'alpha.png').summary, 'Alpha');
    assert.equal(meta.getChatMeta('new_name.jsonl', 'alpha.png').summary, undefined);
    assert.equal(toasts.some(t => t.kind === 'success'), false); assert.equal(listeners.size, 0);
});

test('cancelled native input does not rename', async () => {
    const { sandbox, renamed } = renameSetup({ popupResult: false });
    await sandbox.handleRenameFile({ stopPropagation() {}, currentTarget: { dataset: { filename: 'target.jsonl' } } });
    assert.equal(renamed(), 0);
});

test('alternate-only missing coverage queues work, stays incomplete until fulfilled, then reports full', async () => {
    const { sandbox, settings, index } = setup();
    const msg = { index: 0, text: 'active', swipes: ['active', 'alternate'], swipeId: 0 };
    const entry = index['target.jsonl'] = { fileName: 'target.jsonl', isLoaded: true, messages: [msg], messageEmbeddings: new Map() };
    reader.setMessageEmbedding(entry, 0, 0, [1, 0]);
    assert.equal(sandbox.threadNeedsEmbeddings(entry.fileName), true);
    const result = await sandbox.runEmbeddingGeneration([entry.fileName], { rerender: false, incremental: true });
    assert.equal(result.queuedSwipeVectors, 1); assert.equal(result.skipped, undefined);
    await sandbox.flushBackgroundSwipeEmbeddings(settings);
    assert.deepEqual(reader.getMessageEmbedding(entry, msg, 1), [1, 0]);
    assert.equal(sandbox.threadNeedsEmbeddings(entry.fileName), false);
    assert.equal(sandbox.getEmbeddingStatus(entry), 'full');
});

test('late cached or provider embedding results never attach after clear/settings invalidation', async () => {
    for (const cached of [true, false]) {
        const pending = deferred();
        const { sandbox, index, invalidate } = setup({
            getCachedEmbeddingsForTexts: cached ? () => pending.promise : async texts => texts.map(() => null),
            embedTexts: cached ? async () => assert.fail('unexpected provider') : () => pending.promise,
        });
        const msg = { index: 0, text: 'active', swipes: ['active'], swipeId: 0 };
        const entry = index['target.jsonl'] = { fileName: 'target.jsonl', isLoaded: true, messages: [msg], messageEmbeddings: new Map() };
        const request = sandbox.runEmbeddingGeneration([entry.fileName], { rerender: false, incremental: true });
        await Promise.resolve(); await Promise.resolve(); invalidate(); pending.resolve([[1, 0]]);
        const result = await request;
        assert.equal(result.superseded, true); assert.equal(entry.messageEmbeddings.size, 0);
    }
});

test('semantic results retain the matched alternate text and render its excerpt', async () => {
    const { sandbox, index, nodes } = setup();
    const msg = { filename: 'target.jsonl', index: 0, role: 'assistant', text: 'active unrelated prose', swipes: ['active unrelated prose', 'alternate swords'], swipeId: 0 };
    const entry = index[msg.filename] = { fileName: msg.filename, isLoaded: true, messages: [msg], messageEmbeddings: new Map() };
    reader.setMessageEmbedding(entry, 0, 0, [0, 1]); reader.setMessageEmbedding(entry, 0, 1, [1, 0]);
    sandbox.getSearchableMessages = () => [msg]; sandbox.cosineSimilarity = (a, b) => a[0] * b[0] + a[1] * b[1];
    sandbox.settings = sandbox.getEmbeddingSettings(); sandbox.settings.showAlternateSwipesInResults = true;
    vm.runInContext('getSemanticQueryEmbedding = async () => [1, 0]; renderSearchState = () => {};', sandbox);
    await sandbox.performSemanticSearch('swords', 0);
    const result = vm.runInContext('searchState.results[0]', sandbox);
    assert.equal(result.item, msg); assert.equal(result.matchedText, 'alternate swords'); assert.equal(result.matchedSwipeIndex, 1);
    const excerpts = [];
    sandbox.excerpts = excerpts;
    vm.runInContext('buildHighlightedExcerpt = text => { excerpts.push(text); return text; };', sandbox);
    sandbox.SillyTavern.libs.moment = () => ({ isValid: () => false });
    sandbox.renderSearchPage(nodes.get('chat-manager-content'), 0);
    assert.deepEqual(excerpts, ['alternate swords']);
});

test('thread cards and timeline/search jumps use the same navigation operation with the message inside it', async () => {
    const calls = [];
    const { sandbox, context } = setup({ navigateToChat: async (...args) => { calls.push(args); return true; } });
    context.POPUP_TYPE = { CONFIRM: 1 }; context.POPUP_RESULT = { AFFIRMATIVE: 1 };
    context.Popup = class { async show() { return 1; } };
    await sandbox.handleSwitchThread({ currentTarget: { dataset: { filename: 'target.jsonl' } } });
    await sandbox.handleTimelineJumpToMessage('target.jsonl', 7);
    await sandbox.handleJumpToMessage({ currentTarget: { dataset: { filename: 'target.jsonl', msgIndex: '9' } } });
    assert.deepEqual(calls.map(([file, index]) => [file, index]), [['target.jsonl', null], ['target.jsonl', 7], ['target.jsonl', 9]]);
    for (const [, , options] of calls) { assert.equal(typeof options.beforeScroll, 'function'); assert.equal(typeof options.onError, 'function'); }
});

test('search-jump confirmation cannot switch an identically named thread under a newly selected character', async () => {
    let opens = 0; const pending = deferred();
    const { sandbox, context } = setup({ navigateToChat: async () => { opens++; return true; } });
    context.POPUP_TYPE = { CONFIRM: 1 }; context.POPUP_RESULT = { AFFIRMATIVE: 1 };
    context.Popup = class { show() { return pending.promise; } };
    const request = sandbox.handleJumpToMessage({ currentTarget: { dataset: { filename: 'target.jsonl', msgIndex: '9' } } });
    context.characterId = 1; pending.resolve(1); await request;
    assert.equal(opens, 0);
});

test('explicit refresh forwards force revalidation to both thread and alternate-view index builds', async () => {
    for (const stats of [false, true]) {
        const calls = [];
        const { sandbox, settings } = setup({ buildIndex: async (...args) => { calls.push(args); return { changed: false }; }, prioritizeInQueue() {} });
        settings.enabled = false;
        vm.runInContext(`statsActive = ${stats}; ensureHydrationSubscription = () => {}; ensureSearchModeBadge = () => {}; updateSearchModeBadgeDisplay = () => {}; renderLoading = () => {}; renderThreadCards = () => {}; getCurrentSearchQuery = () => '';`, sandbox);
        await sandbox.refreshPanel({ forceRevalidate: true });
        assert.equal(calls.length, 1); assert.equal(calls[0][2].forceRevalidate, true);
    }
});

test('fresh alternate work drains after a cleared in-flight flush and its already-fired timer', async () => {
    const oldRequest = deferred(); const started = deferred(); let calls = 0;
    const { sandbox, settings, index, timers } = setup({
        embedTexts: async () => { calls++; if (calls === 1) { started.resolve(); return oldRequest.promise; } return [[2, 0]]; },
    });
    const msg = { index: 0, text: 'active', swipes: ['active', 'alternate'], swipeId: 0 };
    const oldEntry = index['target.jsonl'] = { fileName: 'target.jsonl', isLoaded: true, messages: [msg], messageEmbeddings: new Map() };
    const first = { entry: oldEntry, key: '0:1', msgIndex: 0, swipeIndex: 1, text: 'alternate' };
    const oldToken = sandbox.captureEmbeddingOperation();
    sandbox.queueBackgroundSwipeCandidates([first], settings, oldToken);
    const oldFlush = sandbox.flushBackgroundSwipeEmbeddings(settings);
    await started.promise;
    sandbox.clearInMemoryEmbeddings({ rerender: false });
    const freshToken = { settings }; sandbox.captureEmbeddingOperation = () => freshToken;
    sandbox.isEmbeddingOperationCurrent = token => token === freshToken;
    const freshEntry = index['target.jsonl'] = { ...oldEntry, messageEmbeddings: new Map() };
    sandbox.queueBackgroundSwipeCandidates([{ ...first, entry: freshEntry }], settings, freshToken);
    // The fresh timer fires, but the obsolete flush still owns the active flag.
    const timer = timers.at(-1); timer(); await Promise.resolve();
    const timerCount = timers.length;
    oldRequest.reject(new Error('obsolete request'));
    await assert.rejects(oldFlush, /obsolete request/);
    assert.ok(timers.length > timerCount, 'ending obsolete flush schedules a successor for still-pending fresh work');
    timers.at(-1)(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(reader.getMessageEmbedding(freshEntry, msg, 1), [2, 0]);
    assert.equal(calls, 2);
});

test('silent vector clear invalidates every view cache even without rerendering', () => {
    const cleared = [];
    const { sandbox } = setup({
        invalidateIcicleEmbeddings: () => cleared.push('icicle'),
        invalidateSemanticMapEmbeddings: () => cleared.push('map'),
        invalidateGraphEmbeddings: () => cleared.push('graph'),
    });
    sandbox.clearInMemoryEmbeddings({ rerender: false });
    assert.deepEqual(cleared, ['icicle', 'map', 'graph']);
});

test('dimension recovery clears old vectors and retries a foreground run once, without retrying explicit clears', async () => {
    let providerCalls = 0;
    const dimensionError = Object.assign(new Error('dimension drift'), { reason: 'dimensions' });
    const { sandbox, index, settings } = setup({
        isStaleEmbeddingOperationError: error => error === dimensionError,
        embedTexts: async texts => { providerCalls++; if (providerCalls === 1) throw dimensionError; return texts.map(() => [1, 0, 0]); },
    });
    const entry = index['target.jsonl'] = { fileName: 'target.jsonl', isLoaded: true, messages: [{ index: 0, text: 'fresh', swipes: ['fresh'], swipeId: 0 }], messageEmbeddings: new Map([['99:0', [1, 0]]]) };
    // Model the service's recaptured post-clear operation token.
    let token = { settings };
    sandbox.captureEmbeddingOperation = () => token;
    sandbox.isEmbeddingOperationCurrent = candidate => candidate === token;
    sandbox.invalidateEmbeddingOperations = () => { token = { settings }; };
    const result = await sandbox.runEmbeddingGeneration([entry.fileName], { rerender: false, incremental: true });
    assert.equal(result.superseded, undefined); assert.equal(providerCalls, 2);
    assert.deepEqual(reader.getMessageEmbedding(entry, entry.messages[0]), [1, 0, 0]);
    assert.equal(entry.messageEmbeddings.has('99:0'), false);
});

test('historical host timestamps are normalized before card and search date formatting', () => {
    const { sandbox } = setup(); const values = [];
    const moment = value => { values.push(value); return { isValid: () => true, format: () => 'Jul 12', fromNow: () => '2 years ago' }; };
    const legacy = '2024-07-12@01h31m37s123ms';
    assert.equal(sandbox.formatDateOrFallback(moment, legacy), 'Jul 12');
    assert.equal(sandbox.formatFromNowOrFallback(moment, legacy), '2 years ago');
    assert.deepEqual(values, [Date.parse('2024-07-12T01:31:37.123Z'), Date.parse('2024-07-12T01:31:37.123Z')]);
    assert.equal(sandbox.formatDateOrFallback(moment, 'not a date'), '?');
});

test('archived AI and embedding actions do not consume retained bodies pending file revalidation', async () => {
    let aiCalls = 0; let providerCalls = 0;
    const { sandbox, index, settings } = setup({ generateTitleForChat: async () => { aiCalls++; }, embedTexts: async () => { providerCalls++; } });
    settings.embeddingLevels.chat = true;
    index['target.jsonl'] = { fileName: 'target.jsonl', isLoaded: true, needsHydration: true, messages: [{ index: 0, role: 'user', text: 'stale retained content' }] };
    const button = new Element(); button.dataset.filename = 'target.jsonl';
    await sandbox.handleAITitle({ currentTarget: button, stopPropagation() {} });
    const result = await sandbox.runEmbeddingGeneration(['target.jsonl'], { rerender: false, incremental: true });
    assert.equal(aiCalls, 0); assert.equal(providerCalls, 0); assert.equal(result.skipped, true);
    assert.equal(sandbox.getEmbeddingStatus(index['target.jsonl']), 'unknown');
});

test('dimension drift first discovered by direct embedText clears UI and index vectors centrally', async () => {
    const context = { characterId: 0, characters: [{ avatar: 'alpha.png' }], extensionSettings: {}, chat: [], saveSettingsDebounced() {} };
    const store = new Map(); let dimensions = 2;
    const originalFetch = globalThis.fetch;
    globalThis.SillyTavern = { getContext: () => context, libs: { localforage: { createInstance: () => ({ getItem: async key => store.get(key), setItem: async (key, value) => { store.set(key, value); }, clear: async () => store.clear() }) } } };
    globalThis.document = { getElementById: () => null, querySelector: () => null };
    globalThis.window = {};
    meta.setEmbeddingSettings({ enabled: true, provider: 'ollama', ollamaUrl: 'http://synthetic-embeddings.invalid', model: 'dimension-test', embeddingLevels: { chat: true, message: true, query: true } });
    const service = await import('../src/embedding-service.js');
    await import('../src/ui-controller.js');
    globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ embeddings: [Array.from({ length: dimensions }, () => 1)] }) });
    try {
        await service.embedText('old', { level: 'query' });
        const entry = reader.getIndex()['dimension.jsonl'] = { fileName: 'dimension.jsonl', messages: [], chatEmbedding: [1, 1], messageEmbeddings: new Map([['0:0', [1, 1]]]), clusterLabel: 1 };
        dimensions = 3;
        await assert.rejects(service.embedText('new', { level: 'query' }), error => error.reason === 'dimensions');
        assert.equal(entry.chatEmbedding, null); assert.equal(entry.messageEmbeddings, null); assert.equal(entry.clusterLabel, null);
    } finally {
        globalThis.fetch = originalFetch;
        reader.clearIndex();
    }
});


test('branch detection coalesces during idle time, reads the latest chat, and cancels stale callbacks', () => {
    const idle = [], detected = [], cancelled = [];
    const { sandbox } = setup({
        requestIdleCallback: fn => { idle.push(fn); return idle.length; },
        cancelIdleCallback: id => cancelled.push(id),
        runDeferredBranchDetection: filename => detected.push(filename),
    });
    sandbox.selectedFile = 'before.jsonl';
    vm.runInContext("panelOpen = true; getActiveFilename = () => selectedFile; patchBranchIndicators = () => {};", sandbox);
    sandbox.scheduleBranchDetection(); sandbox.scheduleBranchDetection();
    assert.equal(idle.length, 1); assert.deepEqual(detected, []);
    sandbox.selectedFile = 'after.jsonl'; idle[0]();
    assert.deepEqual(detected, ['after.jsonl']);
    sandbox.scheduleBranchDetection(); sandbox.cancelBranchDetection(); idle[1]();
    assert.deepEqual(cancelled, [2]); assert.deepEqual(detected, ['after.jsonl']);
    sandbox.scheduleBranchDetection();
    vm.runInContext('panelOpen = false;', sandbox); idle[2]();
    assert.deepEqual(detected, ['after.jsonl']);
});
