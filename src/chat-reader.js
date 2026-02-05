/**
 * Chat Reader — JSONL parsing, search index building, branch detection.
 * Never modifies any chat files.
 */

const MODULE_NAME = 'chat_manager';

/** @type {Object<string, ChatIndexEntry>} filename -> index entry */
let chatIndex = {};
let currentCharacterAvatar = null;
let indexBuildInProgress = false;

/**
 * @typedef {Object} IndexMessage
 * @property {number} index
 * @property {string} role - 'user' | 'assistant'
 * @property {string} text
 * @property {string} timestamp
 */

/**
 * @typedef {Object} ChatIndexEntry
 * @property {string} fileName
 * @property {number} lastModified
 * @property {number} messageCount
 * @property {IndexMessage[]} messages
 * @property {string|null} firstMessageTimestamp
 * @property {string|null} lastMessageTimestamp
 * @property {number|null} branchPoint - message index where this chat diverged, or null
 */

/**
 * Fetch list of chat files for the current character.
 * @returns {Promise<Array>} Array of chat metadata objects from the server
 */
export async function fetchChatList() {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return [];

    const character = context.characters[context.characterId];
    if (!character) return [];

    const response = await fetch('/api/characters/chats', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({ avatar_url: character.avatar }),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to fetch chat list:`, response.status);
        return [];
    }

    return await response.json();
}

/**
 * Fetch the contents of a specific chat file.
 * @param {string} fileName - The JSONL filename
 * @returns {Promise<Array>} Array of message objects
 */
export async function fetchChatContent(fileName) {
    const context = SillyTavern.getContext();
    if (context.characterId === undefined) return [];

    const character = context.characters[context.characterId];
    if (!character) return [];

    const response = await fetch('/api/chats/get', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            ch_name: character.name,
            file_name: fileName.replace(/\.jsonl$/i, ''),
            avatar_url: character.avatar,
        }),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to fetch chat content for ${fileName}:`, response.status);
        return [];
    }

    return await response.json();
}

/**
 * Parse messages from a chat data array into our index format.
 * @param {Array} chatData - Raw message objects from the server
 * @returns {IndexMessage[]}
 */
function parseMessages(chatData) {
    const messages = [];
    for (let i = 0; i < chatData.length; i++) {
        const msg = chatData[i];
        // Skip metadata-only entries (no 'mes' field)
        if (!msg || typeof msg.mes !== 'string') continue;

        messages.push({
            index: i,
            role: msg.is_user ? 'user' : 'assistant',
            text: msg.mes,
            timestamp: msg.send_date || '',
        });
    }
    return messages;
}

/**
 * Build (or rebuild) the full search index for the current character.
 * @param {Function} [onProgress] - Called with (completed, total) for progress tracking
 * @returns {Promise<Object>} The chat index
 */
export async function buildIndex(onProgress) {
    if (indexBuildInProgress) {
        console.warn(`[${MODULE_NAME}] Index build already in progress, skipping`);
        return chatIndex;
    }

    indexBuildInProgress = true;
    const context = SillyTavern.getContext();

    if (context.characterId === undefined) {
        chatIndex = {};
        currentCharacterAvatar = null;
        indexBuildInProgress = false;
        return chatIndex;
    }

    const character = context.characters[context.characterId];
    if (!character) {
        chatIndex = {};
        currentCharacterAvatar = null;
        indexBuildInProgress = false;
        return chatIndex;
    }

    currentCharacterAvatar = character.avatar;

    try {
        const chatList = await fetchChatList();
        if (!chatList || !chatList.length) {
            chatIndex = {};
            indexBuildInProgress = false;
            return chatIndex;
        }

        const newIndex = {};
        const total = chatList.length;
        const BATCH_SIZE = 10;

        for (let i = 0; i < total; i += BATCH_SIZE) {
            const batch = chatList.slice(i, i + BATCH_SIZE);
            const results = await Promise.all(
                batch.map(async (chatMeta) => {
                    // chatMeta is an array with a single object; the key is the filename
                    const metaObj = Array.isArray(chatMeta) ? chatMeta[0] : chatMeta;
                    const fileName = metaObj.file_name;

                    const chatData = await fetchChatContent(fileName);
                    const messages = parseMessages(chatData);

                    return {
                        fileName,
                        lastModified: metaObj.file_size ? Date.now() : (metaObj.last_mes ? new Date(metaObj.last_mes).getTime() : 0),
                        messageCount: messages.length,
                        messages,
                        firstMessageTimestamp: messages.length > 0 ? messages[0].timestamp : null,
                        lastMessageTimestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
                        branchPoint: null,
                    };
                }),
            );

            for (const entry of results) {
                newIndex[entry.fileName] = entry;
            }

            if (onProgress) {
                onProgress(Math.min(i + BATCH_SIZE, total), total);
            }
        }

        // Detect branches
        detectBranches(newIndex);

        chatIndex = newIndex;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error building index:`, err);
    } finally {
        indexBuildInProgress = false;
    }

    return chatIndex;
}

/**
 * Detect branch points by comparing opening messages across chats.
 * @param {Object} index - The chat index to analyze
 */
function detectBranches(index) {
    const entries = Object.values(index);
    if (entries.length < 2) return;

    const COMPARE_COUNT = 15;

    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const a = entries[i];
            const b = entries[j];

            if (a.messages.length < 2 || b.messages.length < 2) continue;

            // Check if first messages match
            if (a.messages[0]?.text !== b.messages[0]?.text) continue;

            // Find divergence point
            const maxCompare = Math.min(COMPARE_COUNT, a.messages.length, b.messages.length);
            let divergeAt = maxCompare;

            for (let k = 1; k < maxCompare; k++) {
                if (a.messages[k]?.text !== b.messages[k]?.text) {
                    divergeAt = k;
                    break;
                }
            }

            // If they share at least 1 message and diverge, mark the shorter/later one as branch
            if (divergeAt > 0) {
                // The chat with fewer messages or a later last-modified is the branch
                const branch = (a.messageCount <= b.messageCount) ? a : b;
                if (branch.branchPoint === null || divergeAt > 1) {
                    branch.branchPoint = divergeAt;
                }
            }
        }
    }
}

/**
 * Get the current chat index.
 * @returns {Object}
 */
export function getIndex() {
    return chatIndex;
}

/**
 * Get the avatar of the character the index was built for.
 * @returns {string|null}
 */
export function getIndexCharacterAvatar() {
    return currentCharacterAvatar;
}

/**
 * Clear the index (e.g., when no character is selected).
 */
export function clearIndex() {
    chatIndex = {};
    currentCharacterAvatar = null;
}

/**
 * Check if an index build is currently in progress.
 * @returns {boolean}
 */
export function isBuilding() {
    return indexBuildInProgress;
}

/**
 * Build a flat array of all messages for Fuse.js search.
 * @returns {Array}
 */
export function getSearchableMessages() {
    const messages = [];
    for (const [filename, chatData] of Object.entries(chatIndex)) {
        for (const msg of chatData.messages) {
            messages.push({
                filename,
                index: msg.index,
                role: msg.role,
                text: msg.text,
                timestamp: msg.timestamp,
            });
        }
    }
    return messages;
}
