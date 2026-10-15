/** Serialized chat navigation with persisted-save verification. */
import { resolveActiveChatFilename } from './active-chat.js';

let navigationQueue = Promise.resolve();

function identity(context) {
    const character = context.characters?.[context.characterId];
    if (context.groupId || !character?.avatar) throw new Error('Select a character chat before navigating.');
    const filename = resolveActiveChatFilename(context);
    if (!filename) throw new Error('The active chat could not be identified.');
    return { avatar: character.avatar, characterId: String(context.characterId), filename, name: character.name };
}

function sameCharacter(a, b) {
    return a.avatar === b.avatar && a.characterId === b.characterId;
}

function checkIdentity(getContext, expected) {
    const current = identity(getContext());
    if (!sameCharacter(current, expected) || current.filename !== expected.filename) {
        throw new Error('The active character or chat changed during navigation.');
    }
}

// JSON round-tripping matches the host save format, including omitted undefined
// properties. Sort object keys so read-back equality does not depend on order.
function canonical(value) {
    return JSON.stringify(JSON.parse(JSON.stringify(value)), (_key, item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]));
    });
}

function chatSnapshot(context) {
    if (!Array.isArray(context.chat)) throw new Error('The active chat messages are unavailable.');
    return canonical({ metadata: context.chatMetadata || {}, messages: context.chat });
}

async function saveAndVerify(getContext, fetchRequest, source) {
    const context = getContext();
    if (typeof context.saveChat !== 'function') throw new Error('The host save function is unavailable.');
    const expected = chatSnapshot(context);
    await context.saveChat();
    checkIdentity(getContext, source);
    if (chatSnapshot(getContext()) !== expected) throw new Error('The chat changed while it was being saved. Please try again.');

    // Both saveChat and saveChatConditional absorb save errors in the host.
    // Only a fresh read of the persisted content establishes it is safe to leave.
    const response = await fetchRequest('/api/chats/get', {
        method: 'POST', cache: 'no-store', headers: getContext().getRequestHeaders(),
        body: JSON.stringify({ ch_name: source.name, file_name: source.filename.replace(/\.jsonl$/i, ''), avatar_url: source.avatar }),
    });
    checkIdentity(getContext, source);
    if (!response.ok) throw new Error('The saved chat could not be verified.');
    const saved = await response.json();
    checkIdentity(getContext, source);
    if (chatSnapshot(getContext()) !== expected) throw new Error('The chat changed during save verification. Please try again.');
    if (!Array.isArray(saved) || !saved[0] || !Object.hasOwn(saved[0], 'chat_metadata')
        || canonical({ metadata: saved[0].chat_metadata, messages: saved.slice(1) }) !== expected) {
        throw new Error('The saved chat does not match the current messages. Navigation was stopped to preserve your edits.');
    }
}

async function scrollToMessage(messageIndex, getContext, target, options) {
    const doc = options.document || globalThis.document;
    checkIdentity(getContext, target);
    if (messageIndex >= getContext().chat.length) throw new Error('That message no longer exists in the target chat.');
    const expectedMessage = canonical(getContext().chat[messageIndex]);

    let message = doc.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    if (!message) {
        const first = doc.querySelector('#chat .mes[mesid]');
        const rawFirstId = first?.getAttribute('mesid');
        const firstId = rawFirstId === null || rawFirstId === undefined ? NaN : Number(rawFirstId);
        const count = Number.isFinite(firstId) && firstId > messageIndex
            ? firstId - messageIndex : getContext().chat.length;
        const loadEarlierMessages = options.loadEarlierMessages
            || (await import('/script.js')).showMoreMessages;
        checkIdentity(getContext, target);
        await loadEarlierMessages(count);
        checkIdentity(getContext, target);
        message = doc.querySelector(`#chat .mes[mesid="${messageIndex}"]`);
    }

    const chat = doc.getElementById('chat');
    if (!message || !chat) throw new Error('The target message could not be rendered.');
    checkIdentity(getContext, target);
    const currentChat = getContext().chat;
    if (messageIndex >= currentChat.length || canonical(currentChat[messageIndex]) !== expectedMessage) {
        throw new Error('The target message changed while it was being rendered. Please try again.');
    }
    const top = message.getBoundingClientRect().top - chat.getBoundingClientRect().top + chat.scrollTop;
    chat.scrollTo({ top, behavior: 'smooth' });
}

/**
 * Save/verify, switch, and optionally scroll as one queued operation.
 * UI callers may supply beforeOpen(), beforeScroll(), and onError(error). Dependency overrides
 * getContext, fetch, document, and loadEarlierMessages support isolated tests.
 * Returns false on a failed verification, identity change, or rendering error.
 */
export function navigateToChat(filename, messageIndex = null, options = {}) {
    const getContext = options.getContext || (() => globalThis.SillyTavern.getContext());
    let requestedCharacter;
    let captureError;
    try {
        requestedCharacter = identity(getContext());
    } catch (error) {
        captureError = error;
    }

    const operation = navigationQueue.then(async () => {
        if (captureError) throw captureError;
        if (typeof filename !== 'string' || !filename.trim()) throw new Error('A target chat filename is required.');
        if (messageIndex !== null && (!Number.isInteger(messageIndex) || messageIndex < 0)) throw new Error('The message index is invalid.');
        const source = identity(getContext());
        if (!sameCharacter(source, requestedCharacter)) throw new Error('The selected character changed before navigation started.');
        const targetName = filename.trim().replace(/\.jsonl$/i, '');
        const target = { ...source, filename: `${targetName}.jsonl` };

        if (source.filename !== target.filename) {
            await saveAndVerify(getContext, options.fetch || globalThis.fetch, source);
            checkIdentity(getContext, source);
            if (options.beforeOpen) await options.beforeOpen();
            checkIdentity(getContext, source);
            await getContext().openCharacterChat(targetName);
            checkIdentity(getContext, target);
        }

        if (messageIndex !== null) {
            if (options.beforeScroll) await options.beforeScroll();
            checkIdentity(getContext, target);
            await scrollToMessage(messageIndex, getContext, target, options);
        }
        return true;
    });
    // A failed operation must not poison later navigation requests.
    navigationQueue = operation.catch(() => {});
    return operation.catch(error => {
        console.warn('[chat_manager] Navigation stopped:', error);
        try { options.onError?.(error); } catch (reportError) { console.warn('[chat_manager] Navigation error reporting failed:', reportError); }
        return false;
    });
}
