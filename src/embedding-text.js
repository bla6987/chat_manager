/** Shared chat text selection for embedding generation and invalidation. */
import { getSummary } from './metadata-store.js';

export function getRepresentativeEmbeddingText(entry) {
    if (!entry) return '';

    const summary = (getSummary(entry.fileName) || '').trim();
    if (summary) {
        return summary.slice(0, 2000);
    }

    if (!entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    const tail = entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages;
    const text = tail
        .map(msg => (typeof msg?.text === 'string' ? msg.text.trim() : ''))
        .filter(Boolean)
        .join('\n');

    return text.slice(0, 2000).trim();
}
