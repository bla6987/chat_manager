/**
 * Branch Context Injection — Injects sibling branch messages into the AI prompt
 * via SillyTavern's setExtensionPrompt API so the AI can compare parallel threads.
 */

import { getSiblingBranchContext } from './chat-reader.js';
import { getDisplayName } from './metadata-store.js';

const PROMPT_ID = 'chat_manager_branch_ctx';
const MSG_TRUNCATE = 500;

let lastInjectedText = null;

/**
 * Update the branch context injection for the active chat.
 * Fetches sibling data, formats, and injects via setExtensionPrompt.
 * @param {string} activeFilename
 * @returns {{ branchCount: number, injected: boolean }}
 */
export function updateBranchContextInjection(activeFilename) {
    const context = SillyTavern.getContext();
    const siblings = getSiblingBranchContext(activeFilename);

    if (siblings.length === 0) {
        if (lastInjectedText !== null) {
            clearBranchContextInjection();
        }
        return { branchCount: 0, injected: false };
    }

    const characterName = context.name2 || 'Character';
    const text = formatBranchContext(siblings, characterName);

    // Skip no-op updates
    if (text === lastInjectedText) {
        return { branchCount: siblings.length, injected: true };
    }

    // position=1 (IN_CHAT), depth=0, scan=false, role=0 (SYSTEM)
    context.setExtensionPrompt(PROMPT_ID, text, 1, 0, false, 0);
    lastInjectedText = text;

    return { branchCount: siblings.length, injected: true };
}

/**
 * Clear the branch context injection.
 */
export function clearBranchContextInjection() {
    const context = SillyTavern.getContext();
    context.setExtensionPrompt(PROMPT_ID, '', 1, 0, false, 0);
    lastInjectedText = null;
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
