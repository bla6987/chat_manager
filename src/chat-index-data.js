/**
 * Pure chat indexing shared by the reader and its worker: parsing, per-chat
 * summaries and the compact per-message records stored for the views that need
 * them. No DOM, storage or network, so it runs identically in either thread.
 */

import { timestampMs } from './timestamps.js';
import {
    createMessageDescriptor, estimateMessageBodyBytes, messagePreview,
    normalizedMessageFingerprint, textFingerprint,
} from './message-descriptors.js';

export const LAST_MESSAGE_PREVIEW_CHARS = 240;
const EMBEDDING_TEXT_CHARS = 2000;
const EMBEDDING_TEXT_MESSAGES = 10;
const ACTIVITY_BUCKET_MS = 15 * 60_000; // Every real UTC offset is a multiple of 15 minutes.

export function canonicalFilename(value) {
    return typeof value === 'string' && value.trim() ? `${value.trim().replace(/\.jsonl$/i, '')}.jsonl` : null;
}

export function mainChatFromData(chatData, metadata = null) {
    return canonicalFilename(metadata?.main_chat ?? chatData?.[0]?.chat_metadata?.main_chat);
}

/** Thread identity of one message: role plus normalized full-text fingerprint. */
export function messageKey(message) {
    return `${message.role}:${normalizedMessageFingerprint(message)}`;
}

/**
 * Parse messages from a chat data array into the index format.
 * @param {Array} chatData - Raw message objects from the server or the host
 * @param {string} fileName - Chat filename
 * @param {Array|null} [previousMessages] - Reused where unchanged, preserving identity
 * @returns {Array}
 */
export function parseMessages(chatData, fileName, previousMessages = null) {
    const messages = [];
    // Disk arrays include a header; the host's live chat array does not.
    const offset = chatData[0] && typeof chatData[0].mes !== 'string' ? 1 : 0;
    for (let i = offset; i < chatData.length; i++) {
        const msg = chatData[i];
        // Skip metadata-only entries (no 'mes' field)
        if (!msg || typeof msg.mes !== 'string') continue;

        const previous = previousMessages?.[i - offset];
        const rawBranches = Array.isArray(msg.extra?.branches) ? msg.extra.branches.map(canonicalFilename).filter(Boolean) : [];
        const rawSwipeId = Number.isFinite(Number(msg.swipe_id)) ? Math.max(0, Math.floor(Number(msg.swipe_id))) : 0;
        const expectedSwipes = Array.isArray(msg.swipes) && msg.swipes.length ? msg.swipes : (msg.mes.trim() ? [msg.mes] : []);
        const expectedSwipeId = expectedSwipes.length ? Math.min(rawSwipeId, expectedSwipes.length - 1) : 0;
        if (previous && !previous.isDescriptor && previous.index === i - offset
            && previous.text === msg.mes && previous.role === (msg.is_user ? 'user' : 'assistant')
            && previous.timestamp === (msg.send_date || '') && previous.swipeId === expectedSwipeId
            && (previous.branches?.length || 0) === rawBranches.length
            && rawBranches.every((branch, n) => branch === previous.branches[n])
            && (previous.swipes?.length || 0) === expectedSwipes.length
            && expectedSwipes.every((swipe, n) => previous.swipes[n] === (n === expectedSwipeId ? msg.mes : (typeof swipe === 'string' ? swipe : '')))) {
            messages.push(previous);
            continue;
        }

        const rawSwipes = Array.isArray(msg.swipes) ? msg.swipes : null;
        let swipeId = rawSwipeId;
        let swipes = null;

        if (rawSwipes && rawSwipes.length > 0) {
            swipes = rawSwipes.map(swipe => typeof swipe === 'string' ? swipe : '');
            if (swipeId >= swipes.length) swipeId = swipes.length - 1;
            if (swipeId < 0) swipeId = 0;
            if (swipes[swipeId] !== msg.mes) swipes[swipeId] = msg.mes;
        } else if (msg.mes.trim().length > 0) {
            swipes = [msg.mes];
            swipeId = 0;
        }

        messages.push({
            filename: fileName,
            index: i - offset,
            role: msg.is_user ? 'user' : 'assistant',
            text: msg.mes,
            timestamp: msg.send_date || '',
            timestampMs: timestampMs(msg.send_date),
            branches: rawBranches,
            swipes: swipes || undefined,
            swipeId,
        });
    }
    if (previousMessages && messages.length === previousMessages.length && messages.every((message, i) => message === previousMessages[i])) return previousMessages;
    return messages;
}

/** The exact bounded text a chat-level embedding is generated from. */
export function embeddingTextFromMessages(messages) {
    const tail = messages.length > EMBEDDING_TEXT_MESSAGES ? messages.slice(-EMBEDDING_TEXT_MESSAGES) : messages;
    const text = tail
        .map(message => (typeof message?.text === 'string' ? message.text.trim().slice(0, EMBEDDING_TEXT_CHARS) : ''))
        .filter(Boolean)
        .join('\n');
    return messagePreview(text.slice(0, EMBEDDING_TEXT_CHARS).trim(), EMBEDDING_TEXT_CHARS);
}

function lastMessagePreview(message) {
    return typeof message?.text === 'string' ? messagePreview(message.text.trim(), LAST_MESSAGE_PREVIEW_CHARS) : '';
}

/**
 * Which swipe variants of a chat hold text, without keeping per-message objects.
 * Arrays stay absent in the common case: contiguous indexes, first swipe active,
 * one swipe per message, and no empty message.
 */
function summarizeVariants(descriptors) {
    const indexes = [];
    const activeSwipes = [];
    const swipeCounts = [];
    const empty = [];
    let contiguous = true;
    let anyActive = false;
    let anyAlternates = false;
    for (let position = 0; position < descriptors.length; position++) {
        const descriptor = descriptors[position];
        if (descriptor.index !== position) contiguous = false;
        indexes.push(descriptor.index);
        activeSwipes.push(descriptor.swipeId);
        swipeCounts.push(descriptor.swipeCount);
        if (descriptor.swipeId) anyActive = true;
        if (descriptor.swipeCount > 1) anyAlternates = true;
        if (!(descriptor.textLength > 0)) empty.push(position, descriptor.swipeId);
        for (let swipe = 0; swipe < descriptor.swipeCount; swipe++) {
            if (swipe !== descriptor.swipeId && !(descriptor.swipeLengths?.[swipe] > 0)) empty.push(position, swipe);
        }
    }
    return {
        indexes: contiguous ? null : indexes,
        activeSwipes: anyActive ? activeSwipes : null,
        swipeCounts: anyAlternates ? swipeCounts : null,
        empty: empty.length ? empty : null,
    };
}

/**
 * Everything the panel needs from a chat once its body is gone.
 * @param {Array} messages - Parsed messages holding complete text
 * @param {Array} descriptors - Their descriptors
 * @param {string|null} mainChat
 */
export function summarizeChat(messages, descriptors, mainChat = null) {
    let userMessageCount = 0;
    const buckets = new Map();
    const branchTargets = new Set();
    const content = [];
    for (const descriptor of descriptors) {
        if (descriptor.role === 'user') userMessageCount++;
        const ms = Number.isFinite(descriptor.timestampMs) ? descriptor.timestampMs : timestampMs(descriptor.timestamp);
        if (Number.isFinite(ms)) {
            const bucket = Math.floor(ms / ACTIVITY_BUCKET_MS);
            buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
        }
        for (const branch of descriptor.branches || []) branchTargets.add(branch);
        content.push(descriptor.index, descriptor.role, descriptor.timestamp, descriptor.swipeId,
            (descriptor.swipeHashes || []).join(','), (descriptor.branches || []).join(','));
    }
    const activity = [];
    for (const [bucket, count] of buckets) activity.push(bucket, count);
    return {
        messageCount: messages.length,
        firstMessageTimestamp: messages[0]?.timestamp ?? null,
        lastMessageTimestamp: messages.at(-1)?.timestamp ?? null,
        mainChat,
        bodyEmbeddingText: embeddingTextFromMessages(messages),
        lastMessagePreview: lastMessagePreview(messages.at(-1)),
        userMessageCount,
        activity,
        branchTargets: [...branchTargets],
        openingKeys: descriptors.slice(0, 2).map(messageKey),
        contentHash: textFingerprint(content.join('\u0000')),
        variants: summarizeVariants(descriptors),
        bodyBytes: estimateMessageBodyBytes(messages),
    };
}

/** Expand a summary's activity buckets as [millisecond start, message count]. */
export function* iterateActivity(activity) {
    for (let i = 0; i + 1 < (activity?.length || 0); i += 2) yield [activity[i] * ACTIVITY_BUCKET_MS, activity[i + 1]];
}

/** Visit every message/swipe pair of a summary that holds text. */
export function forEachSummarizedVariant(summary, { includeAlternates = false, maxSwipes = 8 } = {}, visit) {
    const variants = summary?.variants;
    if (!variants || !Number.isFinite(summary.messageCount)) return;
    const empty = new Set();
    for (let i = 0; i + 1 < (variants.empty?.length || 0); i += 2) empty.add(`${variants.empty[i]}:${variants.empty[i + 1]}`);
    for (let position = 0; position < summary.messageCount; position++) {
        const index = variants.indexes ? variants.indexes[position] : position;
        const active = variants.activeSwipes ? variants.activeSwipes[position] : 0;
        if (!empty.has(`${position}:${active}`) && visit(index, active, active) === false) return;
        if (!includeAlternates) continue;
        const count = Math.min(variants.swipeCounts ? variants.swipeCounts[position] : 1, maxSwipes);
        for (let swipe = 0; swipe < count; swipe++) {
            if (swipe === active || empty.has(`${position}:${swipe}`)) continue;
            if (visit(index, swipe, active) === false) return;
        }
    }
}

/**
 * Store descriptors as positional rows. Repeated field names and the filename
 * otherwise dominate their size. Swipe arrays are omitted for a single swipe, and
 * the active swipe's entry is left null because the row already holds it.
 */
export function encodeDescriptors(descriptors) {
    return JSON.stringify(descriptors.map(d => {
        const single = d.swipeCount <= 1 && !d.swipeId;
        const withoutActive = values => (single ? 0 : values.map((value, swipe) => (swipe === d.swipeId ? null : value)));
        return [d.index, d.role === 'user' ? 1 : 0, d.timestamp, d.timestampMs ?? null, d.branches?.length ? d.branches : 0,
            d.preview, d.textHash, d.textLength, d.wordCount, d.normalizedTextHash === d.textHash ? 0 : d.normalizedTextHash, d.normalizedTextLength,
            d.swipeId, d.swipeCount, withoutActive(d.swipeHashes), withoutActive(d.swipeLengths), withoutActive(d.swipePreviews)];
    }));
}

export function decodeDescriptors(payload, fileName) {
    return JSON.parse(payload).map(row => {
        const [index, user, timestamp, ms, branches, preview, textHash, textLength, wordCount, normalizedTextHash, normalizedTextLength,
            swipeId, swipeCount, swipeHashes, swipeLengths, swipePreviews] = row;
        const withActive = (values, active) => {
            if (!values) return [active];
            const copy = [...values];
            copy[swipeId] = active;
            return copy;
        };
        return {
            filename: fileName, index, role: user ? 'user' : 'assistant', timestamp, timestampMs: ms ?? undefined,
            branches: branches || [], isDescriptor: true, text: '', preview, textHash, textLength, wordCount,
            normalizedTextHash: normalizedTextHash || textHash, normalizedTextLength, swipeId, swipeCount,
            swipeHashes: withActive(swipeHashes, textHash), swipeLengths: withActive(swipeLengths, textLength),
            swipePreviews: withActive(swipePreviews, preview),
        };
    });
}

/**
 * Index a raw chat array.
 * @returns {{ messages: Array, descriptors: Array, summary: Object }}
 */
export function indexChatData(chatData, fileName, { metadata = null, previousMessages = null, descriptorFor = createMessageDescriptor } = {}) {
    const messages = parseMessages(chatData, fileName, previousMessages);
    const descriptors = messages.map(descriptorFor);
    return { messages, descriptors, summary: summarizeChat(messages, descriptors, mainChatFromData(chatData, metadata)) };
}

/**
 * Index the response text of one chat without keeping its body. This is the whole
 * of the worker's job: the slow parts (JSON parsing and hashing) leave the page.
 * @returns {{ summary: Object, descriptorsPayload: string }}
 */
export function indexChatText(text, fileName) {
    const chatData = JSON.parse(text);
    if (!Array.isArray(chatData)) throw new Error(`Invalid chat content response for ${fileName}`);
    const { descriptors, summary } = indexChatData(chatData, fileName);
    return { summary, descriptorsPayload: encodeDescriptors(descriptors) };
}
