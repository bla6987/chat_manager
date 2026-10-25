import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { searchArchivePage } from '../src/archive-search.js';
import { messageVariants } from '../src/archive-data.js';
import { isVector, toFloat32Vector } from '../src/vector-utils.js';
import { hashEmbeddingText } from '../src/embedding-service.js';
import { getMessageEmbedding, getMessageActiveSwipeIndex } from '../src/chat-reader.js';

let embeddingSettings;
function setupEmbeddingContext() {
    embeddingSettings = {
        enabled: true, provider: 'ollama', model: 'synthetic', ollamaUrl: 'http://test-archive',
        dimensions: 2, embeddingLevels: { chat: true, message: true, query: true },
    };
    globalThis.SillyTavern = { getContext: () => ({
        extensionSettings: { chat_manager: { metadata: {}, embeddings: embeddingSettings } },
        saveSettingsDebounced() {},
    }) };
}

function message(fileName, text, overrides = {}) {
    return { fileName, msgIndex: 7, text, activeText: text, swipeIndex: 0,
        activeSwipeIndex: 0, isActive: true, role: 'assistant', timestampMs: 1, ...overrides };
}

function optionsFor(items, extra = {}) {
    return {
        query: 'needle', limit: 3,
        sourceFactory: async function* () { yield* items; },
        resolveIdentity: reference => items.find(item => item.fileName === reference.fileName
            && item.msgIndex === reference.msgIndex)?.activeText.toLowerCase() ?? null,
        ...extra,
    };
}

test('keyword archive pages bound retained excerpts and paginate every exact group', async () => {
    const items = Array.from({ length: 13 }, (_, i) => message(`thread-${i}`, `needle-${i} ${'x'.repeat(10000)}`, { timestampMs: i + 1 }));
    const excluded = new Map();
    const seen = [];
    let more;
    do {
        const page = await searchArchivePage(optionsFor(items, { excluded }));
        assert.ok(page.results.length <= 3);
        assert.equal(page.scanned, 13);
        for (const result of page.results) {
            seen.push(result.item.filename);
            assert.ok(result.item.text.length <= 242);
            assert.equal('activeText' in result, false);
        }
        for (const { hash, reference } of page.pageReferences) {
            assert.equal('identity' in reference, false, 'pagination stores identifiers, not source text');
            const refs = excluded.get(hash) || [];
            refs.push(reference);
            excluded.set(hash, refs);
        }
        more = page.hasMore;
    } while (more);
    assert.equal(seen.length, 13);
    assert.equal(new Set(seen).size, 13);
});

test('long identities and forced fingerprint collisions require exact dedup verification', async () => {
    const a = `needle ${'x'.repeat(5000)} A`;
    const b = `needle ${'x'.repeat(5000)} B`;
    const items = [message('a', a), message('b', b), message('a-newer', a, { timestampMs: 2 }),
        message('different-index', a, { msgIndex: 8 })];
    let comparisons = 0;
    const options = optionsFor(items, {
        limit: 10, fingerprint: () => 'forced-collision',
        resolveIdentity: reference => {
            comparisons++;
            return items.find(item => item.fileName === reference.fileName && item.msgIndex === reference.msgIndex).activeText.toLowerCase();
        },
    });
    const page = await searchArchivePage(options);
    assert.equal(page.results.length, 3);
    assert.deepEqual(page.results.find(result => result.item.filename === 'a-newer').otherFiles, ['a']);
    assert.ok(page.results.some(result => result.item.filename === 'b'));
    assert.ok(page.results.some(result => result.item.filename === 'different-index'));
    assert.ok(comparisons > 0, 'full identities were resolved instead of trusting the hash');
});

test('semantic grouping preserves alternate swipe identity and earlier duplicate thread links', async () => {
    setupEmbeddingContext();
    const items = [
        message('earlier-copy', 'irrelevant', { activeText: 'shared active', vector: new Float32Array([0, 1]) }),
        message('other', 'needle unrelated', { vector: new Float32Array([0.8, 0.6]), timestampMs: 10 }),
        message('winner', 'shared active', { vector: new Float32Array([0, 1]) }),
        message('winner', 'needle alternate', { activeText: 'shared active', swipeIndex: 2,
            isActive: false, vector: new Float32Array([1, 0]) }),
    ];
    const page = await searchArchivePage(optionsFor(items, {
        mode: 'semantic', queryVector: new Float32Array([1, 0]), limit: 1,
    }));
    assert.equal(page.hasMore, true);
    assert.equal(page.results[0].item.filename, 'winner');
    assert.equal(page.results[0].matchedSwipeIndex, 2);
    assert.equal(page.results[0].activeSwipeIndex, 0);
    assert.equal(page.results[0].isActiveSwipeMatch, false);
    assert.deepEqual(page.results[0].otherFiles, ['earlier-copy']);
    assert.equal(page.results[0].combinedScore, 1);
});

test('message variants preserve host swipe indices and the active text', () => {
    const item = { index: 4, text: 'edited active', swipeId: 2, swipes: ['first', 'second', 'original active', 'fourth'] };
    assert.deepEqual(messageVariants(item, { includeAlternateSwipes: true, maxSwipesPerMessage: 3 }, 'all'), [
        { swipeIndex: 2, text: 'edited active', isActive: true },
        { swipeIndex: 0, text: 'first', isActive: false },
        { swipeIndex: 1, text: 'second', isActive: false },
    ]);
    assert.deepEqual(messageVariants(item, { includeAlternateSwipes: false }, 'alternate'), []);
});

test('cancellation and an embedding recipe change cannot complete a two-pass search', async () => {
    const controller = new AbortController();
    const item = message('one', 'needle', { vector: new Float32Array([1, 0]) });
    await assert.rejects(searchArchivePage(optionsFor([item], {
        signal: controller.signal,
        sourceFactory: async function* () { yield item; controller.abort(); },
    })), { name: 'AbortError' });
    setupEmbeddingContext();
    await assert.rejects(searchArchivePage(optionsFor([item], {
        mode: 'semantic', queryVector: new Float32Array([1, 0]),
        sourceFactory: async function* () { yield item; embeddingSettings.model = 'changed-between-scans'; },
    })), { name: 'AbortError' });
});

test('archive variant batches stop source consumption at their bounded row limit', async () => {
    // Inject only the reader boundary; the production batching/identity code runs unchanged.
    const source = readFileSync(new URL('../src/archive-data.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export /g, '');
    let consumed = 0;
    const entry = { fileName: 'fixture' };
    const messages = Array.from({ length: 12 }, (_, index) => ({ index, text: `needle-${index}`, swipeId: 0 }));
    const sandbox = vm.createContext({
        DOMException,
        iterateChatBodies: async function* () { yield { entry, messages }; },
        getEmbeddingSettings: () => ({}),
        getMessageActiveSwipeIndex: item => item.swipeId,
        messagePreview: text => text,
    });
    vm.runInContext(`${source}\nglobalThis.batches = iterateVariantBatches;`, sandbox);
    for (const msg of messages) {
        let text = msg.text;
        Object.defineProperty(msg, 'text', { get() { consumed++; return text; } });
    }
    const batches = sandbox.batches({ batchSize: 4 });
    const first = await batches.next();
    assert.equal(first.value.length, 4);
    const readsAtYield = consumed;
    await Promise.resolve();
    assert.equal(consumed, readsAtYield, 'paused consumer does not read more source messages');
    assert.equal(first.value.at(-1).msgIndex, 3);
    const second = await batches.next();
    assert.equal(second.value[0].msgIndex, 4);
    await batches.return();
});

function chatVectorFixture() {
    const index = Object.fromEntries(Array.from({ length: 53 }, (_, i) => [`chat-${i}`, {
        fileName: `chat-${i}`, isLoaded: i !== 52, needsHydration: i === 52,
        bodyResident: false, bodyEmbeddingText: `representative-${i}`, chatEmbedding: null,
    }]));
    let current = true;
    const reads = [], requests = [];
    const context = { characterId: 0, characters: [{ avatar: 'fixture.png' }] };
    const operation = { epoch: 2, recipeKey: 'fixture-recipe' };
    const source = readFileSync(new URL('../src/archive-data.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export /g, '');
    const sandbox = vm.createContext({
        DOMException, isVector, toFloat32Vector, hashEmbeddingText,
        SillyTavern: { getContext: () => context },
        getIndex: () => index, getIndexCharacterAvatar: () => 'fixture.png',
        captureEmbeddingOperation: () => operation, isEmbeddingOperationCurrent: () => current,
        getRepresentativeEmbeddingText: entry => entry.bodyEmbeddingText,
        readChatMessages: async file => {
            reads.push(file);
            index[file].isLoaded = true;
            index[file].needsHydration = false;
            return [];
        },
        getCachedEmbeddingsForTexts: async texts => {
            requests.push(Array.from(texts));
            return texts.map(() => new Float32Array([1, 0]));
        },
    });
    vm.runInContext(`${source}\nglobalThis.chats = iterateCachedChatVectors;`, sandbox);
    return { index, context, reads, requests, iterate: sandbox.chats, invalidate() { current = false; } };
}

test('chat vectors stream from bounded cache batches without rehydrating cold indexed bodies', async () => {
    const f = chatVectorFixture();
    const iterator = f.iterate();
    const first = await iterator.next();
    assert.equal(first.value.fileName, 'chat-0');
    assert.ok(first.value.vector instanceof Float32Array);
    assert.equal(first.value.hash, hashEmbeddingText('representative-0'));
    assert.equal(first.value.recipeKey, 'fixture-recipe');
    assert.equal(first.value.epoch, 2);
    assert.deepEqual(f.requests.map(texts => texts.length), [50]);
    assert.deepEqual(f.reads, [], 'cold indexed representatives do not load their bodies');
    let count = 1;
    for await (const _item of iterator) count++;
    assert.equal(count, 53);
    assert.deepEqual(f.requests.map(texts => texts.length), [50, 3]);
    assert.deepEqual(f.reads, ['chat-52'], 'only the unknown catalog entry needs hydration');
    assert.ok(Object.values(f.index).every(entry => entry.chatEmbedding === null), 'streaming does not promote vectors');
});

test('chat vector iterator rejects a recipe change between individual cached yields', async () => {
    const f = chatVectorFixture();
    const iterator = f.iterate();
    await iterator.next();
    f.invalidate();
    await assert.rejects(iterator.next(), { name: 'AbortError' });
    assert.equal(f.requests.length, 1);
});

test('archive alternate swipes cannot borrow a legacy active-only resident vector', async () => {
    const entry = { fileName: 'legacy', messageEmbeddings: new Map([[7, new Float32Array([1, 0])]]) };
    const messages = [{ index: 7, text: 'active', swipeId: 0, swipes: ['active', 'alternate'] }];
    const requests = [];
    const source = readFileSync(new URL('../src/archive-data.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export /g, '');
    const sandbox = vm.createContext({
        DOMException, isVector, getMessageEmbedding, getMessageActiveSwipeIndex,
        iterateChatBodies: async function* () { yield { entry, messages }; },
        captureEmbeddingOperation: () => ({}), isEmbeddingOperationCurrent: () => true,
        messagePreview: text => text,
        getCachedEmbeddingsForTexts: async texts => { requests.push(...texts); return texts.map(() => null); },
    });
    vm.runInContext(`${source}\nglobalThis.vectors = iterateCachedMessageVectors;`, sandbox);
    const results = [];
    for await (const item of sandbox.vectors({ settings: { includeAlternateSwipes: true }, mode: 'all' })) results.push(item);
    assert.deepEqual(results.map(item => item.swipeIndex), [0]);
    assert.deepEqual(requests, ['alternate']);
});
