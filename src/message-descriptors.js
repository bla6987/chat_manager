/** Compact, content-derived records for archive views without retaining chat bodies. */

const PREVIEW_LENGTH = 160;

export function messagePreview(text, limit = PREVIEW_LENGTH) {
    // Joining the short character list avoids sliced-string backing stores that
    // can otherwise keep a multi-megabyte source message alive through a preview.
    return String(text || '').slice(0, limit).split('').join('');
}

/** Non-security 128-bit fingerprint with the UTF-16 length included. */
export function textFingerprint(value) {
    const text = typeof value === 'string' ? value : '';
    let a = 0x811c9dc5, b = 0x9e3779b9, c = 0x85ebca6b, d = 0xc2b2ae35;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code, 0x85ebca6b);
        c = Math.imul(c ^ code, 0xc2b2ae35);
        d = Math.imul(d ^ code, 0x27d4eb2f);
    }
    return `${text.length}:${[a, b, c, d].map(n => (n >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

export function messageFingerprint(message) {
    return message?.textHash || textFingerprint(message?.text);
}

export function normalizedMessageFingerprint(message) {
    return message?.normalizedTextHash || textFingerprint(String(message?.text || '').trim().replace(/\s+/g, ' '));
}

/** Exact when both bodies are present; compact records are content-addressed candidates. */
export function sameMessageContent(left, right) {
    if (!left || !right || left.role !== right.role) return false;
    if (!left.isDescriptor && !right.isDescriptor) return left.text === right.text;
    return messageFingerprint(left) === messageFingerprint(right);
}

export function createMessageDescriptor(message) {
    if (message?.isDescriptor === true) return message;
    const text = typeof message?.text === 'string' ? message.text : '';
    const normalized = text.trim().replace(/\s+/g, ' ');
    const swipeId = Number.isFinite(Number(message?.swipeId)) ? Math.max(0, Math.floor(Number(message.swipeId))) : 0;
    const variants = Array.isArray(message?.swipes) && message.swipes.length ? message.swipes : [text];
    return {
        filename: message?.filename,
        index: message?.index,
        role: message?.role,
        timestamp: message?.timestamp || '',
        timestampMs: message?.timestampMs,
        branches: Array.isArray(message?.branches) ? [...message.branches] : [],
        isDescriptor: true,
        text: '',
        preview: messagePreview(text),
        textHash: textFingerprint(text),
        textLength: text.length,
        wordCount: normalized ? normalized.split(' ').length : 0,
        normalizedTextHash: textFingerprint(normalized),
        normalizedTextLength: normalized.length,
        swipeId,
        swipeCount: variants.length,
        swipeHashes: variants.map((variant, index) => textFingerprint(index === swipeId ? text : variant)),
        swipeLengths: variants.map((variant, index) => String(index === swipeId ? text : variant || '').length),
        swipePreviews: variants.map((variant, index) => messagePreview(index === swipeId ? text : variant)),
    };
}

export function createMessageDescriptors(messages) {
    return Array.isArray(messages) ? messages.map(createMessageDescriptor) : [];
}

/** Conservative logical estimate; not a claim about an engine's measured heap usage. */
export function estimateMessageBodyBytes(messages) {
    let bytes = 0;
    for (const message of messages || []) {
        if (message?.isDescriptor) continue;
        bytes += 256 + 2 * String(message?.text || '').length;
        for (const swipe of message?.swipes || []) bytes += 24 + 2 * String(swipe || '').length;
        bytes += 64 * (message?.branches?.length || 0);
    }
    return bytes;
}
