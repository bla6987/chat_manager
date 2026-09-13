import test from 'node:test';
import assert from 'node:assert/strict';
import { getIndex, clearIndex, updateActiveChat, ensureMessageEmbeddingMap, setMessageEmbedding, getMessageEmbedding } from '../src/chat-reader.js';
import { getEmbeddingSettings, setEmbeddingSettings, getFilterState, setFilterState, getDisplayName, getSummary, getChatTags, getSelectedEmbeddingChats, setSelectedEmbeddingChats, isEmbeddingChatSelected, setEmbeddingChatSelected } from '../src/metadata-store.js';

function setup() {
    clearIndex();
    const context = {
        characterId: 0,
        characters: [{ avatar: 'synthetic.png' }],
        extensionSettings: {},
        chat: [],
        saveSettingsDebounced() {},
    };
    globalThis.SillyTavern = { getContext: () => context };
    return context;
}

function entry(messages) {
    return { fileName: 'synthetic.jsonl', isLoaded: true, messages, messageEmbeddings: new Map(), chatEmbedding: [1, 0], chatEmbeddingHash: 'existing', clusterLabel: 1 };
}
function raw(text, swipes, swipe_id = 0) {
    return { mes: text, is_user: false, send_date: '2026-01-01T00:00:00Z', swipes, swipe_id };
}
function parsed(index, text, swipes = [text], swipeId = 0) {
    return { index, text, swipes, swipeId, role: 'assistant' };
}

test('5,000 vector insertions do not repeatedly scan the growing map', () => {
    setup();
    let visits = 0;
    class CountingMap extends Map {
        *keys() { for (const key of super.keys()) { visits++; yield key; } }
    }
    const chat = entry(Array.from({ length: 5000 }, (_, i) => parsed(i, `message ${i}`)));
    chat.messageEmbeddings = new CountingMap();
    for (let i = 0; i < 5000; i++) setMessageEmbedding(chat, i, 0, [1, i]);
    assert.equal(chat.messageEmbeddings.size, 5000);
    assert.ok(visits <= 1, `Expected at most one key scan; saw ${visits}`);
});

test('legacy migration preserves mixed maps and never lends another swipe its vector', () => {
    setup();
    const chat = entry([parsed(0, 'active', ['alternate', 'active'], 1)]);
    const active = [1, 0], alternate = [0, 1];
    chat.messageEmbeddings = new Map([[0, active], ['m:0:s:0', alternate]]);
    assert.equal(getMessageEmbedding(chat, chat.messages[0], 2), null);
    const migrated = ensureMessageEmbeddingMap(chat);
    assert.equal(migrated.get('m:0:s:1'), active);
    assert.equal(migrated.get('m:0:s:0'), alternate);
    assert.equal(ensureMessageEmbeddingMap(chat), migrated);
    assert.equal(getMessageEmbedding(chat, chat.messages[0], 2), null);
});

test('appending to a long chat keeps unchanged vectors without copying vector arrays', async () => {
    const context = setup();
    const messages = Array.from({ length: 5000 }, (_, i) => parsed(i, `message ${i}`));
    const chat = entry(messages);
    for (let i = 0; i < messages.length; i++) setMessageEmbedding(chat, i, 0, [1, i]);
    getIndex()[chat.fileName] = chat;
    context.chat = messages.map(msg => raw(msg.text));
    context.chat.push(raw('new message'));
    assert.equal(await updateActiveChat(chat.fileName), true);
    const updated = getIndex()[chat.fileName];
    assert.equal(updated.messageEmbeddings.size, 5000);
    for (let i = 0; i < 5000; i++) assert.equal(getMessageEmbedding(updated, updated.messages[i]), chat.messageEmbeddings.get(`m:${i}:s:0`));
    assert.equal(getMessageEmbedding(updated, updated.messages[5000]), null);
    assert.equal(updated.chatEmbedding, null, 'changed representative text invalidates the chat vector');
    assert.notEqual(updated.messageEmbeddings, chat.messageEmbeddings, 'in-flight writes to old entries stay isolated');
});

test('edits, swipe changes, deletions, and JSONL metadata offsets retain only matching text', async () => {
    const context = setup();
    const chat = entry([parsed(1, 'active', ['alternate', 'active'], 1), parsed(2, 'tail')]);
    setMessageEmbedding(chat, 1, 0, [0, 1]);
    setMessageEmbedding(chat, 1, 1, [1, 0]);
    setMessageEmbedding(chat, 2, 0, [1, 1]);
    getIndex()[chat.fileName] = chat;
    context.chat = [raw('edited', ['alternate', 'edited'], 1), raw('tail')];
    await updateActiveChat(chat.fileName);
    let updated = getIndex()[chat.fileName];
    assert.deepEqual(getMessageEmbedding(updated, updated.messages[0], 0), [0, 1]);
    assert.equal(getMessageEmbedding(updated, updated.messages[0], 1), null);
    assert.deepEqual(getMessageEmbedding(updated, updated.messages[1]), [1, 1]);
    context.chat = [raw('alternate', ['alternate', 'edited'], 0)];
    await updateActiveChat(chat.fileName);
    updated = getIndex()[chat.fileName];
    assert.equal(updated.messageEmbeddings.size, 1, 'deleted message and edited swipe vectors are absent');
    assert.deepEqual(getMessageEmbedding(updated, updated.messages[0]), [0, 1]);
});

test('a stable summary preserves the chat vector when new messages arrive', async () => {
    const context = setup();
    getEmbeddingSettings();
    context.extensionSettings.chat_manager.metadata['synthetic.png'] = { 'synthetic.jsonl': { summary: 'Stable summary' } };
    const chat = entry([parsed(0, 'old')]);
    getIndex()[chat.fileName] = chat;
    context.chat = [raw('old'), raw('new')];
    await updateActiveChat(chat.fileName);
    const updated = getIndex()[chat.fileName];
    assert.equal(updated.chatEmbedding, chat.chatEmbedding);
    assert.equal(updated.chatEmbeddingHash, 'existing');
    assert.equal(updated.clusterLabel, 1);
});

test('settings reads reuse normalized data; writes and replacement settings remain visible', () => {
    const context = setup();
    context.extensionSettings.chat_manager = { embeddings: { selectedChatsByAvatar: { 'synthetic.png': [' a ', 'a', '', 1] } } };
    const settings = getEmbeddingSettings();
    const selected = settings.selectedChatsByAvatar['synthetic.png'];
    const filter = getFilterState();
    assert.deepEqual(selected, ['a']);
    for (let i = 0; i < 1000; i++) {
        getDisplayName('a'); getSummary('a'); getChatTags('a');
        assert.equal(getEmbeddingSettings(), settings);
        assert.equal(settings.selectedChatsByAvatar['synthetic.png'], selected);
        assert.equal(getFilterState(), filter);
        assert.equal(isEmbeddingChatSelected('a'), true);
    }
    const copy = getSelectedEmbeddingChats();
    copy.push('unpersisted');
    assert.equal(isEmbeddingChatSelected('unpersisted'), false);
    setEmbeddingChatSelected('b', true);
    assert.equal(isEmbeddingChatSelected('b'), true);
    setSelectedEmbeddingChats([' c ', 'c']);
    assert.equal(isEmbeddingChatSelected('b'), false);
    assert.equal(isEmbeddingChatSelected('c'), true);
    setEmbeddingSettings({ maxSwipesPerMessage: 1000, selectedChatsByAvatar: { 'synthetic.png': [' d ', 'd'] } });
    assert.equal(settings.maxSwipesPerMessage, 64);
    assert.equal(isEmbeddingChatSelected('d'), true);
    setFilterState({ messageCountMin: '12' });
    assert.equal(getFilterState().messageCountMin, 12);
    context.extensionSettings.chat_manager.embeddings = { selectedChatsByAvatar: { 'synthetic.png': [' e '] } };
    assert.notEqual(getEmbeddingSettings(), settings);
    assert.equal(isEmbeddingChatSelected('e'), true);
});

test('incremental generation reads only the new message from persistent cache', async () => {
    const context = setup();
    const { hashEmbeddingText } = await import('../src/embedding-service.js');
    const { generateEmbeddingsForCurrentIndex } = await import('../src/ui-controller.js');
    setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'synthetic', dimensions: 2, embeddingLevels: { chat: true, message: true, query: false } });
    context.extensionSettings.chat_manager.metadata['synthetic.png'] = { 'synthetic.jsonl': { summary: 'Stable summary' } };
    const messages = Array.from({ length: 5000 }, (_, i) => parsed(i, `message ${i}`));
    const chat = entry(messages);
    chat.chatEmbeddingHash = hashEmbeddingText('Stable summary');
    for (let i = 0; i < 5000; i++) setMessageEmbedding(chat, i, 0, [1, i]);
    getIndex()[chat.fileName] = chat;
    context.chat = [...messages.map(msg => raw(msg.text)), raw('new message')];
    await updateActiveChat(chat.fileName);
    const reads = [];
    const cacheEntries = new Map([[hashEmbeddingText('new message'), { text: 'new message', vector: [0, 1], dims: 2, provider: 'ollama', model: 'synthetic' }]]);
    globalThis.SillyTavern.libs = { localforage: { createInstance: () => ({
        async getItem(key) {
            reads.push(key);
            return cacheEntries.get(key) || null;
        },
    }) } };
    await generateEmbeddingsForCurrentIndex({ ensureIndex: false, rerender: false, incremental: true });
    assert.equal(reads.length, 1);
    assert.equal(getIndex()[chat.fileName].messageEmbeddings.size, 5001);
    await generateEmbeddingsForCurrentIndex({ ensureIndex: false, rerender: false, incremental: true });
    assert.equal(reads.length, 1, 'a second pass with unchanged text performs no extra cache reads');
    const { isEmbeddingRunPending } = await import('../src/ui-controller.js');
    assert.equal(isEmbeddingRunPending(), false, 'completed embedding run releases the retained promise chain');

    clearIndex();
    setEmbeddingSettings({ embeddingLevels: { chat: false, message: true, query: false } });
    const active = entry(Array.from({ length: 5000 }, (_, i) => parsed(i, `large ${i}`)));
    active.fileName = 'active.jsonl';
    active.messageEmbeddings = new Map();
    const inactive = entry(Array.from({ length: 5000 }, (_, i) => parsed(i, `inactive ${i}`)));
    inactive.fileName = 'inactive.jsonl';
    inactive.messageEmbeddings = new Map();
    getIndex()[active.fileName] = active;
    getIndex()[inactive.fileName] = inactive;
    for (let i = 5000 - 256; i < 5000; i++) {
        const text = `large ${i}`;
        cacheEntries.set(hashEmbeddingText(text), { text, vector: [1, i], dims: 2, provider: 'ollama', model: 'synthetic' });
    }
    reads.length = 0;
    const { getAutomaticEmbeddingRunOptions } = await import('../src/ui-controller.js');
    const automatic = getAutomaticEmbeddingRunOptions(active.fileName, false);
    await generateEmbeddingsForCurrentIndex({ ...automatic, ensureIndex: false, rerender: false });
    assert.equal(reads.length, 256, 'automatic cold restore only reads the newest active-chat window');
    assert.equal(active.messageEmbeddings.size, 256);
    assert.equal(inactive.messageEmbeddings.size, 0, 'inactive chat messages are not restored');
    reads.length = 0;
    await generateEmbeddingsForCurrentIndex({ ...automatic, ensureIndex: false, rerender: false });
    assert.equal(reads.length, 0, 'repeat automatic restore does not walk backward into older messages');
    assert.equal(active.messageEmbeddings.size, 256);
});

test('deleting the last message uses the empty live chat and drops its vectors', async () => {
    const context = setup();
    const chat = entry([parsed(0, 'last message')]);
    setMessageEmbedding(chat, 0, 0, [1, 0]);
    getIndex()[chat.fileName] = chat;
    context.chat = [];
    assert.equal(await updateActiveChat(chat.fileName), true);
    assert.equal(getIndex()[chat.fileName].messageCount, 0);
    assert.equal(getIndex()[chat.fileName].messageEmbeddings.size, 0);
    assert.equal(getIndex()[chat.fileName].chatEmbedding, null);
});

test('automatic embedding work is bounded to active-message tails and excludes alternate swipes', async () => {
    const { AUTOMATIC_MESSAGE_RESTORE_LIMIT, getAutomaticEmbeddingRunOptions } = await import('../src/ui-controller.js');
    const bootstrap = getAutomaticEmbeddingRunOptions('active.jsonl', false);
    assert.deepEqual(bootstrap.messageTargetFileNames, ['active.jsonl']);
    assert.equal(bootstrap.messageWindowLimit, AUTOMATIC_MESSAGE_RESTORE_LIMIT);
    assert.equal(bootstrap.cacheOnly, true);
    assert.equal(bootstrap.includeAlternateSwipes, false);

    const incremental = getAutomaticEmbeddingRunOptions(null, true);
    assert.equal(incremental.messageTargetFileNames, undefined);
    assert.equal(incremental.messageWindowLimit, 256);
    assert.equal(incremental.cacheOnly, false);
    assert.equal(incremental.includeAlternateSwipes, false);
});

test('generation lifecycle defers automatic timers and ignores dry runs', async () => {
    setup();
    setEmbeddingSettings({ enabled: true, provider: 'ollama', model: 'synthetic', embeddingLevels: { chat: false, message: true, query: false } });
    const ui = await import('../src/ui-controller.js');
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const scheduled = [];
    globalThis.setTimeout = (fn, delay) => {
        const timer = { fn, delay, cleared: false };
        scheduled.push(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => { if (timer) timer.cleared = true; };
    try {
        ui.onEmbeddingGenerationStarted(true);
        ui.scheduleIncrementalEmbedding('dry-run.jsonl');
        assert.equal(scheduled.filter(timer => !timer.cleared).length, 1, 'dry run does not pause scheduling');

        ui.onEmbeddingGenerationStarted(false);
        assert.equal(scheduled.filter(timer => !timer.cleared).length, 0, 'real generation cancels pending automatic timer');
        ui.scheduleIncrementalEmbedding('during-generation.jsonl');
        assert.equal(scheduled.filter(timer => !timer.cleared).length, 0, 'work remains queued while generation is active');

        ui.setEmbeddingGenerationActive(false);
        const live = scheduled.filter(timer => !timer.cleared);
        assert.equal(live.length, 1, 'generation end releases one deferred timer');
        assert.equal(live[0].delay, 1200);
        live[0].cleared = true;
        live[0].fn();
        await Promise.resolve();
    } finally {
        ui.setEmbeddingGenerationActive(false);
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
    }
});
