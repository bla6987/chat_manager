import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cosineSimilarity, topicShiftScores } from '../src/semantic-engine.js';
import { isVector } from '../src/vector-utils.js';
import { messagePreview, createMessageDescriptor } from '../src/message-descriptors.js';

const productionSource = file => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    .replace(/^import .*;$/gm, '').replace(/^export /gm, '');

function fixture(vectors, { onRead = null, source = null } = {}) {
    const fileName = 'evicted.jsonl';
    const messages = vectors.map((_vector, index) => ({ index: index + 7, role: 'assistant',
        text: `archived active ${index}`, swipeId: 1, swipes: [`alternate ${index}`, `archived active ${index}`] }));
    const entry = { fileName, isLoaded: true, bodyResident: false,
        messages: messages.map(createMessageDescriptor), messageEmbeddings: new Map() };
    const index = { [fileName]: entry };
    const diskVectors = new Map(messages.map((message, i) => [message.text, vectors[i]]));
    const reads = [];
    const operation = { epoch: 1, recipeKey: 'recipe', settings: { includeAlternateSwipes: true } };
    let current = true;
    let avatar = 'fixture.png';
    const context = { characterId: 0, characters: [{ avatar }] };
    const globals = {
        DOMException, Float32Array, cosineSimilarity, isVector, messagePreview,
        getIndex: () => index,
        getIndexCharacterAvatar: () => avatar,
        SillyTavern: { getContext: () => context },
        captureEmbeddingOperation: () => operation,
        isEmbeddingOperationCurrent: token => current && token === operation,
        getMessageActiveSwipeIndex: message => message.swipeId,
        getMessageEmbedding: () => null,
        iterateChatBodies: async function* ({ fileNames, signal }) {
            assert.deepEqual(Array.from(fileNames), [fileName]);
            if (signal?.aborted) throw signal.reason;
            // Simulate a persisted body read. It is never installed on entry.
            yield { entry, messages };
        },
        getCachedEmbeddingsForTexts: async texts => {
            reads.push(Array.from(texts));
            await onRead?.({ reads, entry, index, operation });
            return texts.map(text => diskVectors.has(text) ? Float32Array.from(diskVectors.get(text)) : null);
        },
    };
    const sandbox = vm.createContext(globals);
    vm.runInContext(productionSource('archive-data.js'), sandbox);
    if (source) sandbox.iterateCachedMessageVectors = options => source(options, { entry, operation });
    vm.runInContext(`${productionSource('archive-drift.js')}\nglobalThis.compute = computeArchiveDriftSummary;`, sandbox);
    return { fileName, entry, index, reads, operation, messages, compute: sandbox.compute,
        invalidate() { current = false; },
        changeCharacter() { avatar = 'other.png'; context.characters = [{ avatar }]; },
    };
}

test('persisted active vectors produce the complete major-first summary without restoring evicted bodies or vectors', async () => {
    let angle = 0;
    const vectors = Array.from({ length: 160 }, (_, i) => {
        if (i) angle += i < 3 || i % 4 === 1 ? Math.acos(0.65) : i % 4 ? Math.PI / 2 : 0;
        return new Float32Array([Math.cos(angle), Math.sin(angle)]);
    });
    const f = fixture(vectors);
    const shifts = topicShiftScores(vectors);
    const major = [], moderate = [];
    shifts.forEach((score, i) => {
        if (score > 0.4) major.push(f.messages[i + 1].index);
        else if (score > 0.3) moderate.push(f.messages[i + 1].index);
    });
    assert.ok(moderate[0] < major[0], 'fixture distinguishes major-first priority from chronological first five');
    const summary = await f.compute(f.fileName, { embeddingOperation: f.operation });
    const positions = [...major, ...moderate].slice(0, 5);
    assert.deepEqual(JSON.parse(JSON.stringify(summary)), {
        count: major.length + moderate.length, majorCount: major.length, positions, firstMsgIndex: positions[0],
    });
    assert.deepEqual(f.reads.map(batch => batch.length), [50, 50, 50, 10]);
    assert.ok(f.reads.flat().every(text => text.startsWith('archived active')), 'alternate swipes do not enter drift calculations');
    assert.equal(f.entry.messageEmbeddings.size, 0);
    assert.equal(f.entry.bodyResident, false);
    assert.ok(f.entry.messages.every(message => message.isDescriptor && message.text === ''));
    assert.equal(summary.positions.length, 5);
});

test('cancelled persisted reads cannot publish a summary or promote their results', async () => {
    const controller = new AbortController();
    const f = fixture([[1, 0], [0, 1]], { onRead: () => controller.abort() });
    await assert.rejects(f.compute(f.fileName, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.entry.messageEmbeddings.size, 0);
    assert.equal(f.reads.length, 1);
    await assert.rejects(f.compute(f.fileName, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(f.reads.length, 1, 'already-cancelled requests do no archive work');
});

for (const change of ['recipe', 'entry', 'character']) {
    test(`drift rejects a ${change} change after the final yielded vector`, async () => {
        let f;
        f = fixture([], { source: async function* (options, { entry, operation }) {
            assert.equal(options.embeddingOperation, operation);
            assert.equal(options.mode, 'active');
            yield { fileName: entry.fileName, entry, msgIndex: 1, vector: new Float32Array([1, 0]) };
            yield { fileName: entry.fileName, entry, msgIndex: 2, vector: new Float32Array([0, 1]) };
            if (change === 'recipe') f.invalidate();
            else if (change === 'entry') f.index[f.fileName] = { ...entry };
            else f.changeCharacter();
        } });
        await assert.rejects(f.compute(f.fileName), { name: 'AbortError' });
    });
}

test('absent chats, fewer than two vectors and unchanged topics yield no drift badge', async () => {
    for (const vectors of [[], [[1, 0]], [[1, 0], [1, 0], [1, 0]]]) {
        const f = fixture(vectors);
        assert.equal(await f.compute(f.fileName), null);
        assert.equal(await f.compute('missing.jsonl'), null);
    }
});
