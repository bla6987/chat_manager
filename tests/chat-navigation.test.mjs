import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateToChat } from '../src/chat-navigation.js';

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

function fixture() {
    const events = [];
    const errors = [];
    const clone = value => JSON.parse(JSON.stringify(value));
    const messages = label => Array.from({ length: 20 }, (_, i) => ({ mes: `${label} ${i}`, is_user: i % 2 === 0 }));
    const context = {
        characterId: 0, groupId: null, chatId: 'old',
        characters: [{ avatar: 'alpha.png', name: 'Alpha' }, { avatar: 'beta.png', name: 'Beta' }],
        chat: messages('unsaved edit'), chatMetadata: { integrity: 'test', nested: { b: 2, a: 1 } },
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    };
    const disk = new Map([['old', [{ chat_metadata: clone(context.chatMetadata) }, ...messages('old persisted')]]]);
    let rendered = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    context.saveChat = async () => {
        events.push(`save:${context.chatId}`);
        disk.set(context.chatId, [{ chat_metadata: clone(context.chatMetadata) }, ...clone(context.chat)]);
    };
    context.openCharacterChat = async target => {
        events.push(`open:${target}`);
        context.chatId = target;
        const saved = disk.get(target) || [{ chat_metadata: { integrity: target } }, ...messages(target)];
        context.chatMetadata = clone(saved[0].chat_metadata);
        context.chat = clone(saved.slice(1));
        rendered = new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    };
    const container = {
        scrollTop: 0,
        getBoundingClientRect: () => ({ top: 0 }),
        scrollTo: ({ top }) => events.push(`scroll:${context.chatId}:${top}`),
    };
    const message = id => ({ getAttribute: () => String(id), getBoundingClientRect: () => ({ top: id }) });
    const options = {
        getContext: () => context,
        fetch: async (url, init) => {
            assert.equal(url, '/api/chats/get');
            assert.equal(init.cache, 'no-store');
            const request = JSON.parse(init.body);
            assert.equal(request.avatar_url, context.characters[context.characterId].avatar);
            events.push(`verify:${request.file_name}`);
            return { ok: true, json: async () => clone(disk.get(request.file_name) || []) };
        },
        document: {
            querySelector: selector => {
                if (selector === '#chat .mes[mesid]') return rendered.size ? message(Math.min(...rendered)) : null;
                const id = Number(selector.match(/mesid="(\d+)"/)[1]);
                return rendered.has(id) ? message(id) : null;
            },
            getElementById: id => id === 'chat' ? container : null,
        },
        loadEarlierMessages: async count => {
            events.push(`load:${context.chatId}:${count}`);
            rendered = new Set(Array.from({ length: 20 }, (_, i) => i));
        },
        onError: error => errors.push(error.message),
    };
    return { context, disk, events, errors, options, renderAll: () => { rendered = new Set(Array.from({ length: 20 }, (_, i) => i)); } };
}

test('a swallowed host save failure preserves the active unsaved chat', async () => {
    const f = fixture();
    f.context.saveChat = async () => { f.events.push('save failed internally'); };
    assert.equal(await navigateToChat('new.jsonl', 1, f.options), false);
    assert.equal(f.context.chatId, 'old');
    assert.equal(f.events.some(event => event.startsWith('open:')), false);
    assert.equal(f.context.chat[0].mes, 'unsaved edit 0');
    assert.match(f.errors[0], /does not match/);
});

test('successful navigation verifies full saved content before open and scroll', async () => {
    const f = fixture();
    f.options.beforeScroll = () => f.events.push('close popup');
    assert.equal(await navigateToChat('new.jsonl', 1, f.options), true);
    assert.deepEqual(f.events, ['save:old', 'verify:old', 'open:new', 'close popup', 'load:new:9', 'scroll:new:1']);
    assert.equal(f.disk.get('old')[1].mes, 'unsaved edit 0');
});

test('read-back comparison includes metadata and accepts reordered object keys', async () => {
    const f = fixture();
    const fetch = f.options.fetch;
    f.options.fetch = async (...args) => {
        const response = await fetch(...args);
        const saved = await response.json();
        saved[0].chat_metadata = { nested: { a: 1, b: 2 }, integrity: 'test' };
        return { ok: true, json: async () => saved };
    };
    assert.equal(await navigateToChat('new', null, f.options), true);
    const other = fixture();
    other.context.saveChat = async () => {
        other.disk.set('old', [{ chat_metadata: { integrity: 'old metadata' } }, ...other.context.chat]);
    };
    assert.equal(await navigateToChat('new', null, other.options), false);
    assert.equal(other.context.chatId, 'old');
});

test('failed or malformed read-back responses stop switching', async () => {
    for (const response of [{ ok: false }, { ok: true, json: async () => ({}) }, { ok: true, json: async () => [] }]) {
        const f = fixture();
        f.options.fetch = async () => response;
        assert.equal(await navigateToChat('new', null, f.options), false);
        assert.equal(f.context.chatId, 'old');
    }
});

test('the complete load and scroll finishes before another navigation starts', async () => {
    const f = fixture();
    const loading = deferred();
    const started = deferred();
    const originalLoad = f.options.loadEarlierMessages;
    f.options.loadEarlierMessages = async count => {
        started.resolve();
        await loading.promise;
        await originalLoad(count);
    };
    const first = navigateToChat('first', 1, f.options);
    await started.promise;
    const second = navigateToChat('second', 5, f.options);
    await Promise.resolve();
    assert.equal(f.events.includes('open:second'), false);
    loading.resolve();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.ok(f.events.indexOf('scroll:first:1') < f.events.indexOf('open:second'));
    assert.equal(f.events.at(-1), 'scroll:second:5');
});

test('a character switch during saving prevents opening a same-named target for the wrong character', async () => {
    const f = fixture();
    const saving = deferred();
    f.context.saveChat = () => saving.promise;
    const navigation = navigateToChat('new', null, f.options);
    await Promise.resolve();
    f.context.characterId = 1;
    saving.resolve();
    assert.equal(await navigation, false);
    assert.equal(f.events.length, 0);
    assert.match(f.errors[0], /character or chat changed/);
});

test('a queued request retains its requested character', async () => {
    const f = fixture();
    const saving = deferred();
    f.context.saveChat = () => saving.promise;
    const first = navigateToChat('first', null, f.options);
    const second = navigateToChat('second', null, f.options);
    await Promise.resolve();
    f.context.characterId = 1;
    saving.resolve();
    assert.equal(await first, false);
    assert.equal(await second, false);
    assert.equal(f.events.some(event => event.startsWith('open:')), false);
});

test('edits during saving or read-back stop navigation instead of discarding newer content', async () => {
    for (const phase of ['save', 'read']) {
        const f = fixture();
        if (phase === 'save') {
            const save = f.context.saveChat;
            f.context.saveChat = async () => { await save(); f.context.chat[0].mes = 'newer edit'; };
        } else {
            const fetch = f.options.fetch;
            f.options.fetch = async (...args) => { const response = await fetch(...args); f.context.chat[0].mes = 'newer edit'; return response; };
        }
        assert.equal(await navigateToChat('new', null, f.options), false);
        assert.equal(f.context.chatId, 'old');
        assert.equal(f.context.chat[0].mes, 'newer edit');
    }
});

test('an external chat switch during earlier-message loading cannot scroll the new chat', async () => {
    const f = fixture();
    const loading = deferred();
    const started = deferred();
    f.options.loadEarlierMessages = async () => { started.resolve(); await loading.promise; };
    const navigation = navigateToChat('old', 1, f.options);
    await started.promise;
    f.context.chatId = 'external';
    loading.resolve();
    assert.equal(await navigation, false);
    assert.equal(f.events.some(event => event.startsWith('scroll:')), false);
});

test('identity is rechecked after the UI hook and target open', async () => {
    const f = fixture();
    f.options.beforeScroll = () => { f.context.chatId = 'external'; };
    assert.equal(await navigateToChat('new', 1, f.options), false);
    assert.equal(f.events.some(event => event.startsWith('scroll:')), false);
    const other = fixture();
    other.context.openCharacterChat = async () => {};
    assert.equal(await navigateToChat('new', null, other.options), false);
});

test('message deletion during loading cannot redirect the same index to another message', async () => {
    const f = fixture();
    const load = f.options.loadEarlierMessages;
    f.options.loadEarlierMessages = async count => {
        await load(count);
        f.context.chat.splice(0, 1);
    };
    assert.equal(await navigateToChat('old', 1, f.options), false);
    assert.equal(f.events.some(event => event.startsWith('scroll:')), false);
    assert.match(f.errors[0], /target message changed/);
});

test('failures release the queue for later navigation and invalid inputs do no work', async () => {
    const f = fixture();
    assert.equal(await navigateToChat('', null, f.options), false);
    assert.equal(await navigateToChat('new', -1, f.options), false);
    assert.equal(await navigateToChat('new', 1.5, f.options), false);
    assert.equal(f.events.length, 0);
    f.context.saveChat = async () => { throw new Error('save rejected'); };
    assert.equal(await navigateToChat('new', null, f.options), false);
    f.context.saveChat = async () => { f.disk.set('old', [{ chat_metadata: f.context.chatMetadata }, ...f.context.chat]); };
    assert.equal(await navigateToChat('new', null, f.options), true);
});

test('same-chat jumps skip save and read-back, and missing messages fail safely', async () => {
    const f = fixture();
    assert.equal(await navigateToChat('old.jsonl', 15, f.options), true);
    assert.deepEqual(f.events, ['scroll:old:15']);
    assert.equal(await navigateToChat('old', 99, f.options), false);
    f.options.loadEarlierMessages = async () => {};
    assert.equal(await navigateToChat('old', 1, f.options), false);
    assert.equal(f.events.length, 1);
});


test('popup closes after save verification and before the host opens the destination', async () => {
    const f = fixture();
    f.options.beforeOpen = () => f.events.push('close popup');
    assert.equal(await navigateToChat('new.jsonl', null, f.options), true);
    assert.deepEqual(f.events, ['save:old', 'verify:old', 'close popup', 'open:new']);
    const failed = fixture();
    failed.context.saveChat = async () => {};
    let closed = false;
    failed.options.beforeOpen = () => { closed = true; };
    assert.equal(await navigateToChat('new.jsonl', null, failed.options), false);
    assert.equal(closed, false, 'failed saves leave the source popup available');
});

test('a before-open hook cannot navigate after changing the source identity', async () => {
    const f = fixture();
    f.options.beforeOpen = () => { f.context.characterId = 1; };
    assert.equal(await navigateToChat('new.jsonl', null, f.options), false);
    assert.equal(f.events.some(event => event.startsWith('open:')), false);
});
