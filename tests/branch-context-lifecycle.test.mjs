import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolveActiveChatFilename } from '../src/active-chat.js';
import { messagePreview } from '../src/message-descriptors.js';

const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

function fixture() {
    const writes = [];
    const context = {
        characterId: 0, characters: [{ avatar: 'one.png' }, { avatar: 'two.png' }],
        chatMetadata: { chat_file_name: 'active.jsonl' }, name2: 'Character',
        setExtensionPrompt: (_id, text) => writes.push(text),
    };
    const index = { 'active.jsonl': {}, 'other.jsonl': {} };
    const branches = Array.from({ length: 5 }, (_, i) => ({ fileName: `sibling-${i}.jsonl`, branchPoint: 1, messages: [{ isDescriptor: true, text: '' }] }));
    const bodies = new Map(branches.map(branch => [branch.fileName, [
        { index: 0, role: 'user', text: 'shared' },
        { index: 1, role: 'assistant', text: `${branch.fileName}: ${'x'.repeat(4000)}`, swipes: ['large unused swipe'] },
    ]]));
    let read = async fileName => bodies.get(fileName);
    const source = readFileSync(new URL('../src/branch-context.js', import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export /g, '');
    const sandbox = vm.createContext({
        AbortController, DOMException,
        SillyTavern: { getContext: () => context },
        getIndex: () => index,
        getSiblingBranchContextForThread: (_file, count) => branches.slice(0, count),
        readChatMessages: (file, options) => read(file, options),
        resolveActiveChatFilename, messagePreview, getDisplayName: file => file,
    });
    vm.runInContext(`${source}\nglobalThis.api = { getSiblingMessagesAsync, updateBranchContextInjection, clearBranchContextInjection };`, sandbox);
    return { ...sandbox.api, context, index, branches, bodies, writes, setRead(value) { read = value; } };
}

test('cold sibling hydration is sequential and retains only three bounded message copies', async () => {
    const f = fixture();
    let concurrent = 0, maximum = 0, reads = 0;
    f.setRead(async file => {
        reads++; concurrent++; maximum = Math.max(maximum, concurrent);
        await Promise.resolve();
        concurrent--;
        return f.bodies.get(file);
    });
    const siblings = await f.getSiblingMessagesAsync('active.jsonl', { maxSiblings: 20 });
    assert.equal(siblings.length, 3);
    assert.equal(reads, 3);
    assert.equal(maximum, 1);
    for (const sibling of siblings) {
        assert.equal(sibling.messages.length, 1);
        const message = sibling.messages[0];
        assert.equal(message.text.length, 501);
        assert.equal(message.text.endsWith('…'), true);
        assert.equal('swipes' in message, false);
        assert.equal('isDescriptor' in message, false);
        assert.notEqual(message, f.bodies.get(sibling.fileName)[1]);
    }
});

test('an active chat switch during a cold read cannot inject the old branch prompt', async () => {
    const f = fixture();
    const entered = deferred(), release = deferred();
    f.setRead(async file => { entered.resolve(); await release.promise; return f.bodies.get(file); });
    const pending = f.updateBranchContextInjection('active.jsonl');
    await entered.promise;
    f.context.chatMetadata.chat_file_name = 'other.jsonl';
    release.resolve();
    assert.equal((await pending).stale, true);
    assert.deepEqual(f.writes, []);
});

test('a character switch invalidates summary sibling reads before text can escape', async () => {
    const f = fixture();
    const entered = deferred(), release = deferred();
    f.setRead(async file => { entered.resolve(); await release.promise; return f.bodies.get(file); });
    const pending = f.getSiblingMessagesAsync('active.jsonl');
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await entered.promise;
    f.context.characterId = 1;
    release.resolve();
    await rejected;
});

test('clearing branch context cancels a pending injection and prevents late restoration', async () => {
    const f = fixture();
    const entered = deferred(), release = deferred();
    let signal;
    f.setRead(async (file, options) => {
        signal = options.signal;
        entered.resolve(); await release.promise;
        return f.bodies.get(file);
    });
    const pending = f.updateBranchContextInjection('active.jsonl');
    await entered.promise;
    f.clearBranchContextInjection();
    assert.equal(signal.aborted, true);
    release.resolve();
    assert.equal((await pending).stale, true);
    assert.deepEqual(f.writes, ['']);
});

test('the generation hook retries a superseded read, awaits cold text and defers embeddings', async () => {
    const entered = deferred(), release = deferred();
    const active = [];
    let calls = 0;
    const context = { characterId: 0, characters: [{ avatar: 'one.png' }] };
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('let hostGenerationActive = false;');
    const end = source.indexOf('function isEmbeddingGenerationEnabled()', start);
    const sandbox = vm.createContext({
        console, MODULE_NAME: 'test',
        SillyTavern: { getContext: () => context },
        getActiveChatFile: () => 'active.jsonl', getBranchContextEnabled: () => true,
        setEmbeddingGenerationActive: value => active.push(value),
        clearBranchContextInjection() {},
        updateBranchContextInjection: async () => {
            calls++;
            if (calls === 1) return { injected: false, branchCount: 0, stale: true };
            entered.resolve(); await release.promise;
            return { injected: true, branchCount: 1 };
        },
    });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.api = { onGenerationPreparing, syncEmbeddingGenerationActive };`, sandbox);
    let completed = false;
    const preparing = sandbox.api.onGenerationPreparing('normal', {}, false).then(() => { completed = true; });
    await entered.promise;
    assert.equal(calls, 2, 'a superseded read does not release prompt preparation');
    sandbox.api.syncEmbeddingGenerationActive(false);
    assert.equal(active.at(-1), true, 'host reconciliation cannot resume embeddings while cold context is pending');
    assert.equal(completed, false);
    release.resolve();
    await preparing;
    assert.equal(active.at(-1), false);
    await sandbox.api.onGenerationPreparing('normal', {}, true);
    assert.equal(calls, 2, 'dry runs do not fetch sibling bodies');
});

test('generation preparation does not retry a stale read after branch context is disabled', async () => {
    let enabled = true;
    let calls = 0;
    const active = [];
    const context = { characterId: 0, characters: [{ avatar: 'one.png' }] };
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const start = source.indexOf('let hostGenerationActive = false;');
    const end = source.indexOf('function isEmbeddingGenerationEnabled()', start);
    const sandbox = vm.createContext({
        console, MODULE_NAME: 'test', SillyTavern: { getContext: () => context },
        getActiveChatFile: () => 'active.jsonl', getBranchContextEnabled: () => enabled,
        setEmbeddingGenerationActive: value => active.push(value), clearBranchContextInjection() {},
        updateBranchContextInjection: async () => { calls++; enabled = false; return { stale: true }; },
    });
    vm.runInContext(`${source.slice(start, end)}\nglobalThis.prepare = onGenerationPreparing;`, sandbox);
    await sandbox.prepare('normal', {}, false);
    assert.equal(calls, 1);
    assert.equal(active.at(-1), false);
});
