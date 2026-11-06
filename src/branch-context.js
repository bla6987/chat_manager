/**
 * Branch Context Injection — Injects sibling branch messages into the AI prompt
 * via SillyTavern's setExtensionPrompt API so the AI can compare parallel threads.
 */

import { getSiblingBranchContextForThread, getIndex, readChatMessages } from './chat-reader.js';
import { resolveActiveChatFilename } from './active-chat.js';
import { messagePreview } from './message-descriptors.js';
import { getDisplayName } from './metadata-store.js';

const PROMPT_ID = 'chat_manager_branch_ctx';
const MSG_TRUNCATE = 500;

let lastInjectedText = null;
let lastInjectionScope = null;
let injectionRequest = 0;
let pendingInjectionController = null;

function captureScope(fileName) {
    const context = SillyTavern.getContext();
    return {
        fileName,
        avatar: context.characters?.[context.characterId]?.avatar ?? null,
        characterId: context.characterId,
        groupId: context.groupId ?? null,
        entry: getIndex()[fileName],
    };
}

function isScopeCurrent(scope, requireActive = false) {
    const context = SillyTavern.getContext();
    return (context.characters?.[context.characterId]?.avatar ?? null) === scope.avatar
        && context.characterId === scope.characterId
        && (context.groupId ?? null) === scope.groupId
        && getIndex()[scope.fileName] === scope.entry
        && (!requireActive || resolveActiveChatFilename(context, getIndex()) === scope.fileName);
}

function assertScopeCurrent(scope, signal) {
    if (signal?.aborted) throw signal.reason || new DOMException('Operation cancelled', 'AbortError');
    if (!isScopeCurrent(scope)) throw new DOMException('The target chat changed', 'AbortError');
}

/**
 * Fetch at most three sibling bodies sequentially. Only copied, bounded text
 * leaves this helper; full swipes, body objects and vectors are never retained
 * in a summary action or an injected prompt snapshot.
 * @returns {Promise<Array<{fileName:string,branchPoint:number,messages:Array}>>}
 */
export async function getSiblingMessagesAsync(fileName, { maxSiblings = 3, maxTextChars = MSG_TRUNCATE, signal } = {}) {
    if (!fileName) return [];
    const scope = captureScope(fileName);
    assertScopeCurrent(scope, signal);
    const count = Math.max(0, Math.min(3, Math.floor(Number(maxSiblings) || 0)));
    const textLimit = Math.max(1, Math.min(MSG_TRUNCATE, Math.floor(Number(maxTextChars) || MSG_TRUNCATE)));
    // Copy identifiers before the first await, releasing any resident message
    // references returned by the branch selector immediately.
    const selections = getSiblingBranchContextForThread(fileName, count)
        .map(({ fileName: siblingFile, branchPoint }) => ({ fileName: siblingFile, branchPoint }));
    const siblings = [];
    for (const selection of selections) {
        assertScopeCurrent(scope, signal);
        const body = await readChatMessages(selection.fileName, { signal });
        assertScopeCurrent(scope, signal);
        const messages = [];
        for (let i = selection.branchPoint; i < body.length; i++) {
            const message = body[i];
            const text = typeof message?.text === 'string' ? message.text : '';
            messages.push({
                index: message.index, role: message.role,
                timestamp: message.timestamp, timestampMs: message.timestampMs,
                text: messagePreview(text, textLimit) + (text.length > textLimit ? '…' : ''),
            });
        }
        if (messages.length) siblings.push({ ...selection, messages });
    }
    assertScopeCurrent(scope, signal);
    return siblings;
}

/**
 * Update the active prompt after demand-loading cold sibling text. Newer
 * updates, explicit clears and character/chat switches invalidate pending reads.
 * @returns {Promise<{branchCount:number,injected:boolean,stale?:boolean}>}
 */
export async function updateBranchContextInjection(activeFilename) {
    const request = ++injectionRequest;
    pendingInjectionController?.abort();
    const controller = new AbortController();
    pendingInjectionController = controller;
    const scope = captureScope(activeFilename);
    const current = () => request === injectionRequest && isScopeCurrent(scope, true);
    try {
        if (!activeFilename || !current()) return { branchCount: 0, injected: false, stale: true };
        const siblings = await getSiblingMessagesAsync(activeFilename, { signal: controller.signal });
        if (!current()) return { branchCount: 0, injected: false, stale: true };
        if (!siblings.length) {
            clearBranchContextInjection();
            return { branchCount: 0, injected: false };
        }
        const context = SillyTavern.getContext();
        const text = formatBranchContext(siblings, context.name2 || 'Character');
        const sameScope = lastInjectionScope?.fileName === scope.fileName
            && lastInjectionScope?.avatar === scope.avatar;
        if (sameScope && text === lastInjectedText) return { branchCount: siblings.length, injected: true };
        context.setExtensionPrompt(PROMPT_ID, text, 1, 0, false, 0);
        lastInjectedText = text;
        lastInjectionScope = { fileName: scope.fileName, avatar: scope.avatar };
        return { branchCount: siblings.length, injected: true };
    } catch (error) {
        if (error?.name === 'AbortError' || controller.signal.aborted || !current()) {
            return { branchCount: 0, injected: false, stale: true };
        }
        throw error;
    } finally {
        if (pendingInjectionController === controller) pendingInjectionController = null;
    }
}

/** Clear the prompt and prevent an older asynchronous update from restoring it. */
export function clearBranchContextInjection() {
    injectionRequest++;
    pendingInjectionController?.abort();
    pendingInjectionController = null;
    const context = SillyTavern.getContext();
    context.setExtensionPrompt(PROMPT_ID, '', 1, 0, false, 0);
    lastInjectedText = null;
    lastInjectionScope = null;
}

/**
 * Format sibling branch data into a prompt text block.
 * @param {Array<{ fileName: string, branchPoint: number, messages: Array }>} siblings
 * @param {string} characterName
 * @returns {string}
 */
export function formatBranchContext(siblings, characterName) {
    const lines = [];

    lines.push('[Branch Context — Parallel Thread]');
    lines.push('These messages are from sibling branches that diverged from this conversation.');
    lines.push('They represent alternative paths. Use this to understand what makes the');
    lines.push('current thread unique compared to these parallel explorations.');
    lines.push('');

    for (const sibling of siblings) {
        const displayName = getDisplayName(sibling.fileName) || sibling.fileName;
        lines.push(`=== Branch: "${displayName}" ===`);
        lines.push(`Diverged at message #${sibling.branchPoint}. ${sibling.messages.length} messages after branch point.`);
        lines.push('');

        for (const msg of sibling.messages) {
            const role = msg.role === 'user' ? 'User' : characterName;
            let text = msg.text || '';
            if (text.length > MSG_TRUNCATE) {
                text = text.substring(0, MSG_TRUNCATE) + '…';
            }
            lines.push(`${role}: ${text}`);
        }

        lines.push('');
    }

    lines.push('[End of Branch Context]');

    return lines.join('\n');
}

/**
 * Format sibling branch data for non-active summary generation.
 * Keeps the structure compact so the model can focus on differences.
 * @param {Array<{ fileName: string, branchPoint: number, messages: Array }>} siblings
 * @param {string} characterName
 * @param {string} [targetDisplayName='this thread']
 * @returns {string}
 */
export function formatBranchContextForSummary(siblings, characterName, targetDisplayName = 'this thread') {
    if (!Array.isArray(siblings) || siblings.length === 0) return '';

    const lines = [];
    lines.push('[Sibling Branch Context]');
    lines.push(`These are sibling branches relative to "${targetDisplayName}".`);
    lines.push('Use them to highlight what is unique in the target thread.');
    lines.push('');

    for (const sibling of siblings) {
        const displayName = getDisplayName(sibling.fileName) || sibling.fileName;
        lines.push(`=== Sibling Branch: "${displayName}" ===`);
        lines.push(`Diverged at message #${sibling.branchPoint}. ${sibling.messages.length} messages after branch point.`);
        lines.push('');

        for (const msg of sibling.messages) {
            const role = msg.role === 'user' ? 'User' : characterName;
            let text = msg.text || '';
            if (text.length > MSG_TRUNCATE) {
                text = text.substring(0, MSG_TRUNCATE) + '…';
            }
            lines.push(`${role}: ${text}`);
        }

        lines.push('');
    }

    lines.push('[End Sibling Branch Context]');
    return lines.join('\n');
}
