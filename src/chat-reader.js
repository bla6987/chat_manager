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
 * @property {string} textLower - pre-lowercased text for fast search
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
            textLower: msg.mes.toLowerCase(),
            timestamp: msg.send_date || '',
        });
    }
    return messages;
}

/**
 * Extract a timestamp (ms since epoch) from a chat metadata object.
 * @param {Object} metaObj
 * @returns {number}
 */
function getMetaTimestamp(metaObj) {
    if (metaObj.last_mes) return new Date(metaObj.last_mes).getTime();
    return 0;
}

/**
 * Build (or incrementally update) the search index for the current character.
 * On incremental runs, only re-fetches chats whose `last_mes` timestamp changed.
 * @param {Function} [onProgress] - Called with (completed, total) for progress tracking
 * @returns {Promise<{ index: Object, changed: boolean }>}
 */
export async function buildIndex(onProgress) {
    if (indexBuildInProgress) {
        console.warn(`[${MODULE_NAME}] Index build already in progress, skipping`);
        return { index: chatIndex, changed: false };
    }

    indexBuildInProgress = true;
    const context = SillyTavern.getContext();

    if (context.characterId === undefined) {
        chatIndex = {};
        currentCharacterAvatar = null;
        indexBuildInProgress = false;
        return { index: chatIndex, changed: false };
    }

    const character = context.characters[context.characterId];
    if (!character) {
        chatIndex = {};
        currentCharacterAvatar = null;
        indexBuildInProgress = false;
        return { index: chatIndex, changed: false };
    }

    currentCharacterAvatar = character.avatar;
    let changed = false;

    try {
        const chatList = await fetchChatList();
        if (!chatList || !chatList.length) {
            changed = Object.keys(chatIndex).length > 0;
            chatIndex = {};
            indexBuildInProgress = false;
            return { index: chatIndex, changed };
        }

        // Build a map of filename -> metaObj from the server list
        const serverChats = new Map();
        for (const chatMeta of chatList) {
            const metaObj = Array.isArray(chatMeta) ? chatMeta[0] : chatMeta;
            serverChats.set(metaObj.file_name, metaObj);
        }

        // Determine which chats need fetching (new or modified) vs unchanged
        const toFetch = [];
        const existingKeys = new Set(Object.keys(chatIndex));

        for (const [fileName, metaObj] of serverChats) {
            const cached = chatIndex[fileName];
            const serverTimestamp = getMetaTimestamp(metaObj);

            if (!cached || cached.lastModified !== serverTimestamp) {
                toFetch.push({ fileName, metaObj });
            }
            existingKeys.delete(fileName);
        }

        // existingKeys now contains deleted chats
        for (const deletedKey of existingKeys) {
            delete chatIndex[deletedKey];
            changed = true;
        }

        if (toFetch.length > 0) {
            changed = true;
            const total = toFetch.length;
            const BATCH_SIZE = 25;

            console.log(`[${MODULE_NAME}] Incremental update: ${total} chats to re-fetch (${serverChats.size - total} cached)`);

            for (let i = 0; i < total; i += BATCH_SIZE) {
                const batch = toFetch.slice(i, i + BATCH_SIZE);
                const results = await Promise.all(
                    batch.map(async ({ fileName, metaObj }) => {
                        const chatData = await fetchChatContent(fileName);
                        const messages = parseMessages(chatData);

                        return {
                            fileName,
                            lastModified: getMetaTimestamp(metaObj),
                            messageCount: messages.length,
                            messages,
                            firstMessageTimestamp: messages.length > 0 ? messages[0].timestamp : null,
                            lastMessageTimestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
                            branchPoint: null,
                        };
                    }),
                );

                for (const entry of results) {
                    chatIndex[entry.fileName] = entry;
                }

                if (onProgress) {
                    onProgress(Math.min(i + BATCH_SIZE, total), total);
                }
            }
        } else {
            console.log(`[${MODULE_NAME}] Incremental update: 0 chats re-fetched`);
        }

        // Deferred: branch detection runs after buildIndex returns (via caller's setTimeout)
        // Reset branch points for fresh detection later
        if (changed) {
            for (const entry of Object.values(chatIndex)) {
                entry.branchPoint = null;
            }
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error building index:`, err);
    } finally {
        indexBuildInProgress = false;
    }

    return { index: chatIndex, changed };
}

/**
 * Update only the active chat's entry in the index (lightweight, no full rebuild).
 * @param {string} fileName - The chat file to update
 * @returns {Promise<boolean>} Whether the entry was actually updated
 */
export async function updateActiveChat(fileName) {
    if (!fileName || !chatIndex[fileName]) return false;

    try {
        const chatData = await fetchChatContent(fileName);
        const messages = parseMessages(chatData);
        const cached = chatIndex[fileName];

        chatIndex[fileName] = {
            ...cached,
            messageCount: messages.length,
            messages,
            firstMessageTimestamp: messages.length > 0 ? messages[0].timestamp : null,
            lastMessageTimestamp: messages.length > 0 ? messages[messages.length - 1].timestamp : null,
            lastModified: Date.now(),
        };
        return true;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Error updating active chat:`, err);
        return false;
    }
}

/**
 * Run branch detection on the current index. Designed to be called deferred (via setTimeout).
 */
export function runDeferredBranchDetection() {
    detectBranches(chatIndex);
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
 * Build a flat array of all messages for search.
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
                textLower: msg.textLower,
                timestamp: msg.timestamp,
            });
        }
    }
    return messages;
}
