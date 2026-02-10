/**
 * AI Features — LLM wrappers for title and summary generation.
 */

import { getAIConnectionProfile } from './metadata-store.js';

const MODULE_NAME = 'chat_manager';
// Keep this window short so repeated user actions are still counted separately.
const TOKEN_USAGE_DEDUPE_TTL_MS = 2000;
const recentTokenUsageKeys = new Map();

function hashText(text) {
    const value = typeof text === 'string' ? text : '';
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function pruneUsageKeyCache(now = Date.now()) {
    for (const [key, timestamp] of recentTokenUsageKeys.entries()) {
        if ((now - timestamp) > TOKEN_USAGE_DEDUPE_TTL_MS) {
            recentTokenUsageKeys.delete(key);
        }
    }
}

function buildUsageKey(operation, profileId, modelId, sourceId, inputText, outputText) {
    return [
        operation || 'unknown',
        profileId || 'current',
        modelId || 'unknown-model',
        sourceId || 'unknown-source',
        hashText(inputText),
        hashText(outputText),
    ].join(':');
}

/**
 * Report token usage for an AI feature call when TokenUsageTracker is available.
 * For quiet generations, prefer consuming pending quiet usage from the tracker so
 * input tokens come from the full prompt context instead of a local estimate.
 * @param {Object} params
 * @param {string} params.operation
 * @param {string} [params.inputText]
 * @param {string} [params.outputText]
 * @param {boolean} [params.preferQuietFlush]
 * @returns {Promise<boolean>} true if usage was recorded by this helper
 */
async function reportTokenUsageIfNeeded({ operation, inputText = '', outputText = '', preferQuietFlush = false }) {
    try {
        const tracker = window['TokenUsageTracker'];
        if (!tracker || typeof outputText !== 'string' || outputText.length === 0) return false;

        if (preferQuietFlush && typeof tracker.flushPendingQuietGeneration === 'function') {
            const flushed = await tracker.flushPendingQuietGeneration(outputText);
            if (flushed) return true;
            // If pending quiet usage was not flushed, avoid fallback counting here.
            // The tracker may have already recorded this generation via core events.
            return false;
        }

        if (typeof tracker.countTokens !== 'function' || typeof tracker.recordUsage !== 'function') return false;

        const promptText = typeof inputText === 'string' ? inputText : '';
        const inputTokens = promptText ? await tracker.countTokens(promptText) : 0;
        const outputTokens = await tracker.countTokens(outputText);
        if (inputTokens <= 0 && outputTokens <= 0) return false;

        const modelId = typeof tracker.getCurrentModelId === 'function' ? tracker.getCurrentModelId() : null;
        const sourceId = typeof tracker.getCurrentSourceId === 'function' ? tracker.getCurrentSourceId() : null;
        const usageKey = buildUsageKey(
            operation,
            getAIConnectionProfile(),
            modelId,
            sourceId,
            promptText,
            outputText,
        );

        const now = Date.now();
        pruneUsageKeyCache(now);

        const seenAt = recentTokenUsageKeys.get(usageKey);
        if (typeof seenAt === 'number' && (now - seenAt) <= TOKEN_USAGE_DEDUPE_TTL_MS) {
            return false;
        }
        recentTokenUsageKeys.set(usageKey, now);

        tracker.recordUsage(inputTokens, outputTokens, null, modelId, sourceId, 0);
        return true;
    } catch (e) {
        console.warn(`[${MODULE_NAME}] Token usage reporting failed:`, e);
        return false;
    }
}

function notifyWarning(message) {
    if (typeof toastr !== 'undefined' && typeof toastr.warning === 'function') {
        toastr.warning(message);
        return;
    }
    console.warn(`[${MODULE_NAME}] ${message}`);
}

function notifyError(message) {
    if (typeof toastr !== 'undefined' && typeof toastr.error === 'function') {
        toastr.error(message);
        return;
    }
    console.error(`[${MODULE_NAME}] ${message}`);
}

/**
 * Check if LLM API is available.
 * @returns {boolean}
 */
export function isLLMAvailable() {
    const context = SillyTavern.getContext();
    return context.onlineStatus && context.onlineStatus !== 'no_connection';
}

/**
 * Show a warning toast if LLM is not connected.
 * @returns {boolean} true if available, false if not
 */
export function requireLLM() {
    if (!isLLMAvailable()) {
        notifyWarning("Connect to an LLM API in SillyTavern's API settings to use AI-powered features.");
        return false;
    }
    return true;
}

// ── Profile-switching wrapper ──

/** Serialization lock to prevent concurrent profile switches from colliding. */
let profileLock = Promise.resolve();

/**
 * Execute `fn` under the configured AI connection profile.
 * Switches to the target profile before calling fn, and restores the original afterward.
 * If no AI profile is configured, or it's already active, calls fn directly.
 * Uses a serialization lock to prevent concurrent profile switches.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withAIProfile(fn) {
    const targetId = getAIConnectionProfile();
    if (!targetId) return fn();

    const context = SillyTavern.getContext();
    const cmProfiles = context.extensionSettings?.connectionManager?.profiles;
    if (!Array.isArray(cmProfiles) || cmProfiles.length === 0) return fn();

    const targetProfile = cmProfiles.find(p => p.id === targetId);
    if (!targetProfile) {
        console.warn(`[${MODULE_NAME}] AI profile "${targetId}" not found, using current connection`);
        return fn();
    }

    // Check if target is already the selected profile
    const selectedProfileId = context.extensionSettings?.connectionManager?.selectedProfile;
    if (selectedProfileId === targetId) return fn();

    // Serialize through the lock to prevent interleaving
    const ticket = profileLock;
    let release;
    profileLock = new Promise(resolve => { release = resolve; });

    try {
        await ticket;
        return await switchAndRun(targetProfile, selectedProfileId, cmProfiles, fn);
    } finally {
        release();
    }
}

/**
 * @param {Object} targetProfile
 * @param {string|undefined} originalProfileId
 * @param {Array} cmProfiles
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function switchAndRun(targetProfile, originalProfileId, cmProfiles, fn) {
    const context = SillyTavern.getContext();

    // Switch to the AI profile
    try {
        await context.executeSlashCommandsWithOptions(`/profile ${targetProfile.name}`);
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to switch to AI profile "${targetProfile.name}", using current connection:`, err);
        return fn();
    }

    try {
        return await fn();
    } finally {
        // Restore the original profile
        try {
            const originalProfile = originalProfileId
                ? cmProfiles.find(p => p.id === originalProfileId)
                : null;
            const restoreName = originalProfile ? originalProfile.name : 'None';
            await context.executeSlashCommandsWithOptions(`/profile ${restoreName}`);
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Failed to restore original profile:`, err);
        }
    }
}

/**
 * Generate a title for the currently active chat using generateQuietPrompt.
 * @returns {Promise<string|null>} The generated title, or null on failure
 */
export async function generateTitleForActiveChat() {
    return withAIProfile(async () => {
        if (!requireLLM()) return null;

        const context = SillyTavern.getContext();
        const quietPrompt = 'Based on the recent messages, generate a short title (3-10 words) capturing the most recent key event or theme. Output ONLY the title text. No quotes, no explanation.';

        try {
            const result = await context.generateQuietPrompt({
                quietPrompt,
            });
            await reportTokenUsageIfNeeded({
                operation: 'active-title-quiet',
                inputText: quietPrompt,
                outputText: result,
                preferQuietFlush: true,
            });

            const title = cleanGeneratedText(result, 200);
            if (!title) {
                notifyWarning('AI returned an empty or invalid title.');
                return null;
            }

            return title;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Title generation failed:`, err);
            notifyError('Failed to generate title. Check API connection.');
            return null;
        }
    });
}

/**
 * Generate a title for a non-active chat using generateRaw.
 * @param {Array} messages - Array of {role, text} message objects
 * @param {string} characterName - The character's display name
 * @returns {Promise<string|null>}
 */
export async function generateTitleForChat(messages, characterName) {
    return withAIProfile(async () => {
        if (!requireLLM()) return null;

        const context = SillyTavern.getContext();

        const messageContext = messages.slice(-15).map(m =>
            `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
        ).join('\n');

        const prompt = `Given these recent roleplay messages:\n\n${messageContext}\n\nGenerate a short title (3-10 words) capturing the most recent key event. Output ONLY the title.`;
        const systemPrompt = 'You are a concise title generator. Output only the requested title.';

        try {
            const result = await context.generateRaw({ prompt, systemPrompt });
            await reportTokenUsageIfNeeded({
                operation: 'thread-title-raw',
                inputText: `${systemPrompt}\n${prompt}`,
                outputText: result,
            });

            const title = cleanGeneratedText(result, 200);
            if (!title) {
                notifyWarning('AI returned an empty or invalid title.');
                return null;
            }

            return title;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Title generation failed:`, err);
            notifyError('Failed to generate title. Check API connection.');
            return null;
        }
    });
}

/**
 * Generate a summary for the currently active chat using generateQuietPrompt.
 * @returns {Promise<string|null>}
 */
export async function generateSummaryForActiveChat() {
    return withAIProfile(async () => {
        if (!requireLLM()) return null;

        const context = SillyTavern.getContext();
        const quietPrompt = 'Summarize this roleplay conversation with emphasis on recent events. 2-4 sentences. Focus on what happened, key actions, and current situation. Output ONLY the summary.';

        try {
            const result = await context.generateQuietPrompt({
                quietPrompt,
            });
            await reportTokenUsageIfNeeded({
                operation: 'active-summary-quiet',
                inputText: quietPrompt,
                outputText: result,
                preferQuietFlush: true,
            });

            const summary = cleanGeneratedText(result, 1000);
            if (!summary) {
                notifyWarning('AI returned an empty or invalid summary.');
                return null;
            }

            return summary;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Summary generation failed:`, err);
            notifyError('Failed to generate summary. Check API connection.');
            return null;
        }
    });
}

/**
 * Generate a summary for a non-active chat using generateRaw.
 * @param {Array} messages - Array of {role, text} message objects
 * @param {string} characterName
 * @param {number|null} branchPoint - Message index where this chat diverges from another
 * @param {string} [branchContextText=''] - Optional sibling branch context for contrastive summary
 * @returns {Promise<string|null>}
 */
export async function generateSummaryForChat(messages, characterName, branchPoint = null, branchContextText = '') {
    return withAIProfile(async () => {
        if (!requireLLM()) return null;

        const context = SillyTavern.getContext();

        const windowSize = 30;
        const windowStart = Math.max(0, messages.length - windowSize);
        const recentMsgs = messages.slice(-windowSize);

        let messageContext;
        let branchHint = '';

        if (branchPoint != null && branchPoint >= windowStart) {
            // Branch point falls within the window — insert a marker
            const relPos = branchPoint - windowStart;
            const before = recentMsgs.slice(0, relPos).map(m =>
                `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
            );
            const after = recentMsgs.slice(relPos).map(m =>
                `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
            );
            messageContext = [...before, '--- BRANCH POINT ---', ...after].join('\n');
            branchHint = '\nThis conversation branches from another at the marked point. Emphasize what happens after the branch point — what makes this path distinct.';
        } else {
            messageContext = recentMsgs.map(m =>
                `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
            ).join('\n');
            if (branchPoint != null) {
                branchHint = '\nThis conversation is a branch that diverged early from another. Summarize its unique content.';
            }
        }

        const trimmedBranchContext = typeof branchContextText === 'string' ? branchContextText.trim() : '';
        const siblingContextBlock = trimmedBranchContext
            ? `\n\nHere is sibling branch context for comparison:\n\n${trimmedBranchContext}\n\nUse this only to highlight what is unique in the target thread compared to sibling branches.`
            : '';

        const prompt = `Given these recent roleplay messages:\n\n${messageContext}${siblingContextBlock}\n\nSummarize this roleplay conversation with emphasis on recent events. 2-4 sentences. Focus on what happened, key actions, and current situation.${branchHint} Output ONLY the summary.`;
        const systemPrompt = 'You are a concise summarizer. Output only the requested summary.';

        try {
            const result = await context.generateRaw({ prompt, systemPrompt });
            await reportTokenUsageIfNeeded({
                operation: 'thread-summary-raw',
                inputText: `${systemPrompt}\n${prompt}`,
                outputText: result,
            });

            const summary = cleanGeneratedText(result, 1000);
            if (!summary) {
                notifyWarning('AI returned an empty or invalid summary.');
                return null;
            }

            return summary;
        } catch (err) {
            console.error(`[${MODULE_NAME}] Summary generation failed:`, err);
            notifyError('Failed to generate summary. Check API connection.');
            return null;
        }
    });
}

/**
 * Clean up LLM output: trim whitespace, strip surrounding quotes, validate length.
 * @param {string} text
 * @param {number} maxLength
 * @returns {string|null} Cleaned text or null if invalid
 */
function cleanGeneratedText(text, maxLength) {
    if (!text || typeof text !== 'string') return null;

    let cleaned = text.trim();

    // Strip surrounding quotes
    if ((cleaned.startsWith('"') && cleaned.endsWith('"')) ||
        (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
        cleaned = cleaned.slice(1, -1).trim();
    }

    if (cleaned.length === 0 || cleaned.length > maxLength) return null;

    return cleaned;
}
