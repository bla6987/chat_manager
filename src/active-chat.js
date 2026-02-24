/**
 * Active Chat Resolver — resolves the current active chat filename from
 * authoritative SillyTavern context fields only (no heuristic message matching).
 */

const CHAT_FILE_EXT = '.jsonl';

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
}

function withJsonlExtension(value) {
    if (!isNonEmptyString(value)) return null;
    const trimmed = value.trim();
    if (trimmed.toLowerCase().endsWith(CHAT_FILE_EXT)) {
        return trimmed;
    }
    return `${trimmed}${CHAT_FILE_EXT}`;
}

function toCandidateList(value) {
    if (!isNonEmptyString(value)) return [];

    const trimmed = value.trim();
    const withExt = withJsonlExtension(trimmed);
    const withoutExt = trimmed.toLowerCase().endsWith(CHAT_FILE_EXT)
        ? trimmed.slice(0, -CHAT_FILE_EXT.length)
        : trimmed;

    const seen = new Set();
    const candidates = [];
    for (const candidate of [trimmed, withExt, withoutExt]) {
        if (!isNonEmptyString(candidate)) continue;
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        candidates.push(candidate);
    }
    return candidates;
}

function getChatIdFromContext(context) {
    if (!context || typeof context !== 'object') return null;
    if (isNonEmptyString(context.chatId)) return context.chatId;
    if (typeof context.getCurrentChatId === 'function') {
        const fromGetter = context.getCurrentChatId();
        return isNonEmptyString(fromGetter) ? fromGetter : null;
    }
    return null;
}

/**
 * Resolve active chat filename from official context fields.
 * Resolution order:
 * 1) context.chatMetadata.chat_file_name
 * 2) context.chatId / context.getCurrentChatId()
 *
 * If an index map is provided, only returns candidates that exist in that index.
 *
 * @param {Object} [context]
 * @param {Object<string, any>|null} [index=null]
 * @returns {string|null}
 */
export function resolveActiveChatFilename(context = null, index = null) {
    const ctx = context || SillyTavern.getContext();
    if (!ctx || typeof ctx !== 'object') return null;

    const orderedCandidates = [
        ...toCandidateList(ctx.chatMetadata?.chat_file_name),
        ...toCandidateList(getChatIdFromContext(ctx)),
    ];

    if (orderedCandidates.length === 0) return null;

    const hasIndex = !!(index && typeof index === 'object');
    if (hasIndex) {
        for (const candidate of orderedCandidates) {
            if (Object.hasOwn(index, candidate)) {
                return candidate;
            }
        }
        return null;
    }

    return withJsonlExtension(orderedCandidates[0]);
}
