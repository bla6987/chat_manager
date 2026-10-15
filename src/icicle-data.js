/**
 * Icicle Data — Builds a trie from chatIndex and computes icicle layout.
 *
 * Pipeline:
 * 1. Trie construction: each chat's message sequence = root-to-leaf path.
 *    Trie key at each depth = normalized message text.
 * 2. Layout: iterative top-down y0/y1 assignment in [0,1] space.
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
 * @property {number|null} clusterLabel
 * @property {number[]|null} chatEmbedding
 * @property {number[]|null} pca3d
 * @property {number} y0 - top of vertical span [0,1]
 * @property {number} y1 - bottom of vertical span [0,1]
 */

import { pca3D, pca3DAsync } from './semantic-engine.js';

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
    const activeEntry = loadedEntries.find(e => e.fileName === activeChatFile)?.entry;
    return loadedEntries.filter(({ fileName, entry }) => fileName === activeChatFile
        || sharesActiveThread(entry, activeEntry));
}

/** Whether the current-thread filter includes an entry alongside the active chat. */
export function sharesActiveThread(entry, activeEntry) {
    if (!activeEntry?.isLoaded || !activeEntry.messages || activeEntry.messages.length < 2) return true;
    if (!entry?.messages || entry.messages.length < 2) return false;
    for (let i = 0; i < 2; i++) {
        const message = entry.messages[i];
        const active = activeEntry.messages[i];
        if (message.role !== active.role || normalizeText(message.text) !== normalizeText(active.text)) return false;
    }
    return true;
}

/**
 * Build icicle data from chatIndex.
 *
 * @param {Object} chatIndex - keyed by fileName
 * @param {string|null} activeChatFile
 * @param {{ threadFocus?: boolean, previousRoot?: TrieNode|null }} [options]
 * @returns {{ root: TrieNode, flatNodes: Array, maxDepth: number, loadedCount: number, pcaRanges: { x: [number, number], y: [number, number], z: [number, number] }|null }}
 */
export async function buildIcicleData(chatIndex, activeChatFile, options = {}) {
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

    compactSharedMembership(root, null);
    const semanticContext = await buildSemanticContext(entries);
    annotateSemanticFields(root, chatIndex, semanticContext, new WeakMap());

    // ── Phase 2: Layout computation ──
    computeLayout(root, 0, 1, activeChatFile, options.previousRoot);

    // ── Phase 3: Flatten ──
    const flatNodes = [];
    flattenTrie(root, flatNodes);

    const pcaRanges = computePcaRanges(flatNodes);

    return { root, flatNodes, maxDepth, loadedCount: entries.length, pcaRanges };
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
        clusterLabel: null,
        chatEmbedding: null,
        pca3d: null,
        y0: 0,
        y1: 1,
    };
}

function compactSharedMembership(root, parentChatFiles) {
    const stack = [{ node: root, parentChatFiles }];
    while (stack.length) {
        const { node, parentChatFiles: parentFiles } = stack.pop();
        if (parentFiles && node.chatFiles.length === parentFiles.length) {
            node.chatFiles = parentFiles;
        }
        for (const child of node.children.values()) {
            stack.push({ node: child, parentChatFiles: node.chatFiles });
        }
    }
}

/**
 * @param {Array<{fileName: string, entry: Object}>} entries
 * @returns {{ mean: number[]|null, components: number[][]|null }}
 */
async function buildSemanticContext(entries) {
    const vectors = [];
    for (const { entry } of entries) {
        if (Array.isArray(entry.chatEmbedding) && entry.chatEmbedding.length > 0) {
            vectors.push(entry.chatEmbedding);
        }
    }

    if (vectors.length === 0) {
        return { mean: null, components: null };
    }

    const { mean, components } = await pca3DAsync(vectors);
    if (!Array.isArray(mean) || !Array.isArray(components) || components.length === 0) {
        return { mean: null, components: null };
    }

    return { mean, components };
}

/**
 * @param {string[]} chatFiles
 * @param {Object} chatIndex
 * @returns {number|null}
 */
function majorityCluster(chatFiles, chatIndex) {
    const counts = new Map();
    for (const file of chatFiles) {
        const label = chatIndex[file]?.clusterLabel;
        if (!Number.isFinite(label)) continue;
        const key = Math.floor(label);
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (counts.size === 0) return null;

    let bestLabel = null;
    let bestCount = -1;
    for (const [label, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            bestLabel = label;
        }
    }
    return bestLabel;
}

/**
 * @param {string[]} chatFiles
 * @param {Object} chatIndex
 * @returns {number[]|null}
 */
function meanPoolEmbeddings(chatFiles, chatIndex) {
    let sum = null;
    let count = 0;
    for (const file of chatFiles) {
        const vector = chatIndex[file]?.chatEmbedding;
        if (!Array.isArray(vector) || vector.length === 0) continue;
        if (!sum) sum = new Array(vector.length).fill(0);
        if (vector.length !== sum.length) continue;
        for (let i = 0; i < vector.length; i++) sum[i] += vector[i];
        count++;
    }
    if (!sum || count === 0) return null;
    for (let i = 0; i < sum.length; i++) sum[i] /= count;
    return sum;
}

/**
 * Project a pooled embedding into the shared PCA basis.
 * @param {number[]} vector
 * @param {number[]} mean
 * @param {number[][]} components
 * @returns {number[]|null}
 */
function projectToPca3(vector, mean, components) {
    if (!Array.isArray(vector) || !Array.isArray(mean) || !Array.isArray(components)) return null;
    if (vector.length !== mean.length) return null;

    const centered = new Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
        centered[i] = vector[i] - mean[i];
    }

    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
        const component = components[c];
        if (!Array.isArray(component) || component.length !== centered.length) {
            out[c] = 0;
            continue;
        }

        let dot = 0;
        for (let i = 0; i < centered.length; i++) {
            dot += centered[i] * component[i];
        }
        out[c] = dot;
    }

    return out;
}

/**
 * @param {TrieNode} node
 * @param {Object} chatIndex
 * @param {{ mean: number[]|null, components: number[][]|null }} semanticContext
 */
function annotateSemanticFields(root, chatIndex, semanticContext, aggregateCache) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        let aggregate = aggregateCache.get(node.chatFiles);
        if (!aggregate) {
            aggregate = {
                clusterLabel: majorityCluster(node.chatFiles, chatIndex),
                chatEmbedding: meanPoolEmbeddings(node.chatFiles, chatIndex),
                pca3d: null,
            };
            if (aggregate.chatEmbedding && semanticContext.mean && semanticContext.components) {
                aggregate.pca3d = projectToPca3(aggregate.chatEmbedding, semanticContext.mean, semanticContext.components);
            }
            aggregateCache.set(node.chatFiles, aggregate);
        }
        node.clusterLabel = aggregate.clusterLabel;
        node.chatEmbedding = aggregate.chatEmbedding;
        node.pca3d = aggregate.pca3d;
        for (const child of node.children.values()) stack.push(child);
    }
}

/**
 * @param {Array<TrieNode>} nodes
 * @returns {{ x: [number, number], y: [number, number], z: [number, number] } | null}
 */
function computePcaRanges(nodes) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let count = 0;

    for (const node of nodes) {
        if (!Array.isArray(node.pca3d) || node.pca3d.length < 3) continue;
        const [x, y, z] = node.pca3d;
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        count++;
    }

    if (count === 0) return null;
    return { x: [minX, maxX], y: [minY, maxY], z: [minZ, maxZ] };
}

/**
 * Iteratively assign y0/y1 to each node.
 * Children divide the parent's vertical span proportionally by chat count.
 * Sort: active-chat child first, then by weight descending.
 */
function computeLayout(root, y0, y1, activeChatFile, previousNode = null) {
    const stack = [{ node: root, y0, y1, previousNode }];
    while (stack.length) {
        const { node, y0, y1, previousNode } = stack.pop();
        node.y0 = y0;
        node.y1 = y1;

        if (node.children.size === 0) continue;

        const children = [...node.children.values()];
        const previousOrder = new Map();
        if (previousNode) {
            const ordered = [...previousNode.children.values()].sort((a, b) => a.y0 - b.y0);
            ordered.forEach((child, i) => previousOrder.set(`${child.role}:${child.normalizedText}`, i));
        }

        // Keep existing branches in place during refreshes and chat switches. New
        // branches follow them; the initial layout still prioritizes the active chat.
        children.sort((a, b) => {
            const aOrder = previousOrder.get(`${a.role}:${a.normalizedText}`) ?? Infinity;
            const bOrder = previousOrder.get(`${b.role}:${b.normalizedText}`) ?? Infinity;
            if (aOrder !== bOrder) return aOrder - bOrder;
            const aActive = activeChatFile && a.chatFiles.includes(activeChatFile) ? 1 : 0;
            const bActive = activeChatFile && b.chatFiles.includes(activeChatFile) ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive;
            return b.chatFiles.length - a.chatFiles.length;
        });

        const totalChats = children.reduce((sum, c) => sum + c.chatFiles.length, 0);
        if (totalChats === 0) continue;
        const span = y1 - y0;
        let cursor = y0;

        for (const child of children) {
            const proportion = child.chatFiles.length / totalChats;
            const childSpan = span * proportion;
            const previousChild = previousNode?.children.get(`${child.role}:${child.normalizedText}`);
            stack.push({ node: child, y0: cursor, y1: cursor + childSpan, previousNode: previousChild });
            cursor += childSpan;
        }
    }
}

/**
 * Pre-order traversal producing a flat array.
 * Skips the virtual root (depth -1).
 */
function flattenTrie(root, out) {
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        if (node.depth >= 0) out.push(node);
        const children = [...node.children.values()].sort((a, b) => a.y0 - b.y0);
        // Reverse the push order to retain pre-order traversal in screen order.
        for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
}

/**
 * Re-layout a subtree so the given node spans [0,1] y-space.
 * Returns new flatNodes, maxDepth, and depthOffset for rendering.
 *
 * @param {TrieNode} node - subtree root to explore
 * @param {string|null} activeChatFile
 * @param {{ preserveOrder?: boolean }} [options]
 * @returns {{ flatNodes: Array, maxDepth: number, depthOffset: number }}
 */
export function reLayoutSubtree(node, activeChatFile, { preserveOrder = false } = {}) {
    computeLayout(node, 0, 1, activeChatFile, preserveOrder ? node : null);
    const flatNodes = [];
    flattenTrie(node, flatNodes);
    let maxDepth = node.depth;
    for (const n of flatNodes) {
        if (n.depth > maxDepth) maxDepth = n.depth;
    }
    return { flatNodes, maxDepth, depthOffset: node.depth };
}
