/** Parses and hashes chat text away from the page. See chat-index-data.js. */
import { indexChatText } from './chat-index-data.js';

self.onmessage = ({ data }) => {
    const { id, text, fileName } = data;
    try {
        self.postMessage({ id, ok: true, ...indexChatText(text, fileName) });
    } catch (error) {
        self.postMessage({ id, ok: false, error: String(error?.message || error) });
    }
};
