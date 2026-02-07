/**
 * Icicle Data — Builds a trie from chatIndex and computes icicle layout.
 *
 * Pipeline:
 * 1. Trie construction: each chat's message sequence = root-to-leaf path.
 *    Trie key at each depth = normalized message text.
 * 2. Layout: recursive top-down y0/y1 assignment in [0,1] space.
 *    Children divide parent's span proportionally by chat count.
 * 3. Flatten: pre-order traversal → flat array for rendering + hit testing.
 */

/**
 * @typedef {Object} TrieNode
 * @property {string} normalizedText
 * @property {string} role
 * @property {number} depth
 * @property {string[]} chatFiles - which chats pass through this node
 * @property {Map<string, TrieNode>} children
 * @property {{ text: string, timestamp: number|null }} representative
 * @property {number} y0 - top of vertical span [0,1]
 * @property {number} y1 - bottom of vertical span [0,1]
 */

/**
 * Normalize message text for trie keying: trim + collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    return (text || '').trim().replace(/\s+/g, ' ');
}

/**
 * Filter loaded entries to only those sharing the active chat's thread.
 * A chat is "on-thread" if it shares at least the first 2 messages with the active chat.
 * @param {Array<{fileName: string, entry: Object}>} loadedEntries
 * @param {string} activeChatFile
 * @returns {Array<{fileName: string, entry: Object}>}
 */
function filterToThread(loadedEntries, activeChatFile) {
    const activeEntry = loadedEntries.find(e => e.fileName === activeChatFile);
    if (!activeEntry || activeEntry.entry.messages.length < 2) return loadedEntries;

    const activeKeys = activeEntry.entry.messages.map(
        msg => `${msg.role}:${normalizeText(msg.text)}`,
    );

    return loadedEntries.filter(({ fileName, entry }) => {
        if (fileName === activeChatFile) return true;
        if (entry.messages.length < 2) return false;

        for (let i = 0; i < 2; i++) {
            const key = `${entry.messages[i].role}:${normalizeText(entry.messages[i].text)}`;
            if (key !== activeKeys[i]) return false;
        }
        return true;
    });
}

/**
 * Build icicle data from chatIndex.
 *
 * @param {Object} chatIndex - keyed by fileName
 * @param {string|null} activeChatFile
 * @param {{ threadFocus?: boolean }} [options]
 * @returns {{ root: TrieNode, flatNodes: Array, maxDepth: number, loadedCount: number }}
 */
export function buildIcicleData(chatIndex, activeChatFile, options = {}) {
    const loadedEntries = [];
    for (const [fileName, entry] of Object.entries(chatIndex)) {
        if (entry.isLoaded && entry.messages && entry.messages.length > 0) {
            loadedEntries.push({ fileName, entry });
        }
    }

    if (loadedEntries.length === 0) {
        return { root: null, flatNodes: [], maxDepth: 0, loadedCount: 0 };
    }

    // Optional thread-focus filter
    let entries = loadedEntries;
    if (options.threadFocus && activeChatFile) {
        entries = filterToThread(loadedEntries, activeChatFile);
    }

    // ── Phase 1: Trie construction ──
    const root = makeNode('', '', -1);
    root.chatFiles = entries.map(e => e.fileName);
    let maxDepth = 0;

    for (const { fileName, entry } of entries) {
        let current = root;

        for (let i = 0; i < entry.messages.length; i++) {
            const msg = entry.messages[i];
            const key = normalizeText(msg.text);
            // Composite key includes role so user/assistant messages at same depth don't merge
            const compositeKey = `${msg.role}:${key}`;

            let child = current.children.get(compositeKey);
            if (!child) {
                child = makeNode(key, msg.role, i);
                child.representative = { text: msg.text, timestamp: msg.timestamp || null };
                current.children.set(compositeKey, child);
            }
            child.chatFiles.push(fileName);

            current = child;
            if (i > maxDepth) maxDepth = i;
        }
    }

    // ── Phase 2: Layout computation ──
    computeLayout(root, 0, 1, activeChatFile);

    // ── Phase 3: Flatten ──
    const flatNodes = [];
    flattenTrie(root, flatNodes);

    return { root, flatNodes, maxDepth, loadedCount: entries.length };
}

/**
 * Create a new trie node.
 */
function makeNode(normalizedText, role, depth) {
    return {
        normalizedText,
        role,
        depth,
        chatFiles: [],
        children: new Map(),
        representative: { text: '', timestamp: null },
        y0: 0,
        y1: 1,
    };
}

/**
 * Recursively assign y0/y1 to each node.
 * Children divide the parent's vertical span proportionally by chat count.
 * Sort: active-chat child first, then by weight descending.
 */
function computeLayout(node, y0, y1, activeChatFile) {
    node.y0 = y0;
    node.y1 = y1;

    if (node.children.size === 0) return;

    const children = [...node.children.values()];

    // Sort: active path first, then by chat count descending
    children.sort((a, b) => {
        const aActive = activeChatFile && a.chatFiles.includes(activeChatFile) ? 1 : 0;
        const bActive = activeChatFile && b.chatFiles.includes(activeChatFile) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.chatFiles.length - a.chatFiles.length;
    });

    const totalChats = children.reduce((sum, c) => sum + c.chatFiles.length, 0);
    if (totalChats === 0) return;
    const span = y1 - y0;
    let cursor = y0;

    for (const child of children) {
        const proportion = child.chatFiles.length / totalChats;
        const childSpan = span * proportion;
        computeLayout(child, cursor, cursor + childSpan, activeChatFile);
        cursor += childSpan;
    }
}

/**
 * Pre-order traversal producing a flat array.
 * Skips the virtual root (depth -1).
 */
function flattenTrie(node, out) {
    if (node.depth >= 0) {
        out.push(node);
    }
    // Iterate children in sorted order (Map preserves insertion order,
    // but computeLayout sorted the values — re-sort for traversal)
    const children = [...node.children.values()];
    children.sort((a, b) => a.y0 - b.y0);
    for (const child of children) {
        flattenTrie(child, out);
    }
}

/**
 * Re-layout a subtree so the given node spans [0,1] y-space.
 * Returns new flatNodes, maxDepth, and depthOffset for rendering.
 *
 * @param {TrieNode} node - subtree root to explore
 * @param {string|null} activeChatFile
 * @returns {{ flatNodes: Array, maxDepth: number, depthOffset: number }}
 */
export function reLayoutSubtree(node, activeChatFile) {
    computeLayout(node, 0, 1, activeChatFile);
    const flatNodes = [];
    flattenTrie(node, flatNodes);
    let maxDepth = node.depth;
    for (const n of flatNodes) {
        if (n.depth > maxDepth) maxDepth = n.depth;
    }
    return { flatNodes, maxDepth, depthOffset: node.depth };
}
