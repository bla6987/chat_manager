/** Shared chat text selection for embedding generation and invalidation. */
import { getSummary } from './metadata-store.js';
import { messagePreview } from './message-descriptors.js';
import { embeddingTextFromMessages } from './chat-index-data.js';

export function getRepresentativeEmbeddingText(entry) {
    if (!entry) return '';

    const summary = (getSummary(entry.fileName) || '').trim();
    if (summary) {
        return messagePreview(summary, 2000);
    }

    // Reader keeps this exact bounded recipe when the full body is evicted.
    if (entry.bodyResident === false) {
        return typeof entry.bodyEmbeddingText === 'string' ? entry.bodyEmbeddingText : '';
    }

    if (!entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    return embeddingTextFromMessages(entry.messages);
}
