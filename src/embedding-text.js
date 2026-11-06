/** Shared chat text selection for embedding generation and invalidation. */
import { getSummary } from './metadata-store.js';
import { messagePreview } from './message-descriptors.js';

export function getRepresentativeEmbeddingText(entry) {
    if (!entry) return '';

    const summary = (getSummary(entry.fileName) || '').trim();
    if (summary) {
        return messagePreview(summary, 2000);
    }

    // Reader keeps this exact bounded recipe when the full body is evicted.
    // Descriptor previews must not silently produce a different embedding.
    if (entry.bodyResident === false) {
        return typeof entry.bodyEmbeddingText === 'string' ? entry.bodyEmbeddingText : '';
    }

    if (!entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    const tail = entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages;
    const text = tail
        .map(msg => (typeof msg?.text === 'string' ? msg.text.trim().slice(0, 2000) : ''))
        .filter(Boolean)
        .join('\n');

    return messagePreview(text.slice(0, 2000).trim(), 2000);
}
