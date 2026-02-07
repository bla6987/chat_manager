/**
 * AI Features — LLM wrappers for title and summary generation.
 */

const MODULE_NAME = 'chat_manager';

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
        toastr.warning("Connect to an LLM API in SillyTavern's API settings to use AI-powered features.");
        return false;
    }
    return true;
}

/**
 * Generate a title for the currently active chat using generateQuietPrompt.
 * @returns {Promise<string|null>} The generated title, or null on failure
 */
export async function generateTitleForActiveChat() {
    if (!requireLLM()) return null;

    const context = SillyTavern.getContext();

    try {
        const result = await context.generateQuietPrompt({
            quietPrompt: 'Based on the recent messages, generate a short title (3-10 words) capturing the most recent key event or theme. Output ONLY the title text. No quotes, no explanation.',
        });

        const title = cleanGeneratedText(result, 200);
        if (!title) {
            toastr.warning('AI returned an empty or invalid title.');
            return null;
        }

        return title;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Title generation failed:`, err);
        toastr.error('Failed to generate title. Check API connection.');
        return null;
    }
}

/**
 * Generate a title for a non-active chat using generateRaw.
 * @param {Array} messages - Array of {role, text} message objects
 * @param {string} characterName - The character's display name
 * @returns {Promise<string|null>}
 */
export async function generateTitleForChat(messages, characterName) {
    if (!requireLLM()) return null;

    const context = SillyTavern.getContext();

    const messageContext = messages.slice(-15).map(m =>
        `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
    ).join('\n');

    const prompt = `Given these recent roleplay messages:\n\n${messageContext}\n\nGenerate a short title (3-10 words) capturing the most recent key event. Output ONLY the title.`;
    const systemPrompt = 'You are a concise title generator. Output only the requested title.';

    try {
        const result = await context.generateRaw({ prompt, systemPrompt });

        // Report token usage
        try {
            const tracker = window['TokenUsageTracker'];
            if (tracker && result) {
                const inputTokens = await tracker.countTokens(systemPrompt + '\n' + prompt);
                const outputTokens = await tracker.countTokens(result);
                const modelId = tracker.getCurrentModelId();
                const sourceId = tracker.getCurrentSourceId();
                tracker.recordUsage(inputTokens, outputTokens, null, modelId, sourceId, 0);
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Token usage reporting failed:`, e);
        }

        const title = cleanGeneratedText(result, 200);
        if (!title) {
            toastr.warning('AI returned an empty or invalid title.');
            return null;
        }

        return title;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Title generation failed:`, err);
        toastr.error('Failed to generate title. Check API connection.');
        return null;
    }
}

/**
 * Generate a summary for the currently active chat using generateQuietPrompt.
 * @returns {Promise<string|null>}
 */
export async function generateSummaryForActiveChat() {
    if (!requireLLM()) return null;

    const context = SillyTavern.getContext();

    try {
        const result = await context.generateQuietPrompt({
            quietPrompt: 'Summarize this roleplay conversation with emphasis on recent events. 2-4 sentences. Focus on what happened, key actions, and current situation. Output ONLY the summary.',
        });

        const summary = cleanGeneratedText(result, 1000);
        if (!summary) {
            toastr.warning('AI returned an empty or invalid summary.');
            return null;
        }

        return summary;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Summary generation failed:`, err);
        toastr.error('Failed to generate summary. Check API connection.');
        return null;
    }
}

/**
 * Generate a summary for a non-active chat using generateRaw.
 * @param {Array} messages - Array of {role, text} message objects
 * @param {string} characterName
 * @returns {Promise<string|null>}
 */
export async function generateSummaryForChat(messages, characterName) {
    if (!requireLLM()) return null;

    const context = SillyTavern.getContext();

    const messageContext = messages.slice(-30).map(m =>
        `${m.role === 'user' ? 'User' : characterName}: ${m.text}`,
    ).join('\n');

    const prompt = `Given these recent roleplay messages:\n\n${messageContext}\n\nSummarize this roleplay conversation with emphasis on recent events. 2-4 sentences. Focus on what happened, key actions, and current situation. Output ONLY the summary.`;
    const systemPrompt = 'You are a concise summarizer. Output only the requested summary.';

    try {
        const result = await context.generateRaw({ prompt, systemPrompt });

        // Report token usage
        try {
            const tracker = window['TokenUsageTracker'];
            if (tracker && result) {
                const inputTokens = await tracker.countTokens(systemPrompt + '\n' + prompt);
                const outputTokens = await tracker.countTokens(result);
                const modelId = tracker.getCurrentModelId();
                const sourceId = tracker.getCurrentSourceId();
                tracker.recordUsage(inputTokens, outputTokens, null, modelId, sourceId, 0);
            }
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Token usage reporting failed:`, e);
        }

        const summary = cleanGeneratedText(result, 1000);
        if (!summary) {
            toastr.warning('AI returned an empty or invalid summary.');
            return null;
        }

        return summary;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Summary generation failed:`, err);
        toastr.error('Failed to generate summary. Check API connection.');
        return null;
    }
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
