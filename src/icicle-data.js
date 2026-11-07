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

import { computePcaBasisAsync, projectVectorToPca } from './semantic-engine.js';
import { isVector } from './vector-utils.js';
import { messagePreview as truncateMessagePreview } from './message-descriptors.js';
import { messageKey } from './chat-index-data.js';

const PREVIEW_CHARS = 160;
const vectorIds = new WeakMap();
let nextVectorId = 1;
let semanticBasisCache = null;
let semanticCacheGeneration = 0;

/** Release the small shared PCA basis when its owning view is closed/invalidated. */
export function clearIcicleSemanticCache() {
    semanticCacheGeneration++;
    semanticBasisCache = null;
}

function messagePreview(message) {
    return truncateMessagePreview(message.preview ?? message.text ?? '', PREVIEW_CHARS);
}

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

function openingKeysOf(entry) {
    if (entry?.messages?.length >= 2) return entry.messages.slice(0, 2).map(messageKey);
    return entry?.openingKeys?.length >= 2 ? entry.openingKeys : null;
}

/** Whether the current-thread filter includes an entry alongside the active chat. */
export function sharesActiveThread(entry, activeEntry) {
    const active = activeEntry?.isLoaded ? openingKeysOf(activeEntry) : null;
    if (!active) return true;
    const own = openingKeysOf(entry);
    return !!own && own[0] === active[0] && own[1] === active[1];
}

/**
 * Build icicle data from chatIndex.
 *
 * @param {Object} chatIndex - keyed by fileName
 * @param {string|null} activeChatFile
 * @param {{ threadFocus?: boolean, previousRoot?: TrieNode|null, colorMode?: string, embeddingRevision?: number, signal?: AbortSignal, iterateChatVectors?: Function, readDescriptors?: Function }} [options]
 *   readDescriptors supplies the per-message records of a chat without a resident
 *   body, one chat at a time, so the tree is the only thing retained.
 * @returns {{ root: TrieNode, flatNodes: Array, maxDepth: number, loadedCount: number, pcaRanges: { x: [number, number], y: [number, number], z: [number, number] }|null }}
 */
export async function buildIcicleData(chatIndex, activeChatFile, options = {}) {
    const loadedEntries = [];
    for (const [fileName, entry] of Object.entries(chatIndex)) {
        const hasMessages = entry.messages?.length > 0 || (options.readDescriptors && entry.messageCount > 0);
        if (entry.isLoaded && hasMessages) {
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
        let messages = entry.messages;
        if (!messages?.length) {
            if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
            try {
                messages = await options.readDescriptors(fileName, { signal: options.signal });
            } catch (error) {
                if (error?.name === 'AbortError') throw error;
                console.warn(`[chat_manager] Graph skipped ${fileName}:`, error);
                continue;
            }
        }
        let current = root;

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            // Full-text fingerprints preserve topology after bodies are evicted;
            // previews are only display text and never decide branch identity.
            const compositeKey = messageKey(msg);
            const preview = messagePreview(msg);
            const key = normalizeText(preview);

            let child = current.children.get(compositeKey);
            if (!child) {
                child = makeNode(key, msg.role, i);
                child.key = compositeKey;
                child.representative = { text: preview, timestamp: msg.timestamp || null };
                current.children.set(compositeKey, child);
            }

            current = child;
            if (i > maxDepth) maxDepth = i;
        }
        // Store each file only at its terminal until memberships are assembled.
        current.chatFiles.push(fileName);
    }

    assembleMembership(root, entries);
    compactSharedMembership(root, null);
    const semanticContext = options.colorMode === 'gradient'
        ? await buildSemanticContext(entries, options)
        : null;
    if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
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
        key: '',
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

// Unary shared prefixes reuse their child's array immediately: no temporary
// branches × common-depth file references are allocated during construction.
function assembleMembership(root, entries) {
    const order = new Map(entries.map(({ fileName }, index) => [fileName, index]));
    const stack = [{ node: root, visited: false }];
    while (stack.length) {
        const { node, visited } = stack.pop();
        if (!visited) {
            stack.push({ node, visited: true });
            for (const child of node.children.values()) stack.push({ node: child, visited: false });
            continue;
        }
        if (node === root) continue; // Root already has the complete ordered list.
        const groups = [];
        if (node.chatFiles.length) groups.push(node.chatFiles);
        for (const child of node.children.values()) groups.push(child.chatFiles);
        if (groups.length === 1) {
            node.chatFiles = groups[0];
        } else if (groups.length > 1) {
            node.chatFiles = groups.flat();
            // Child insertion order can interleave the original input order.
            node.chatFiles.sort((a, b) => order.get(a) - order.get(b));
        }
    }
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
async function buildSemanticContext(entries, options) {
    if (typeof options.iterateChatVectors === 'function') return buildArchivedSemanticContext(entries, options);
    const vectors = [];
    const signatureParts = ['resident', options.embeddingRevision || 0];
    for (const { fileName, entry } of entries) {
        const vector = entry.chatEmbedding;
        if (!isVector(vector) || vector.length === 0) continue;
        if (!vectorIds.has(vector)) vectorIds.set(vector, nextVectorId++);
        // Vectors are immutable. Replacing one or changing its recipe invalidates
        // the basis without a second O(N*D) content scan on every view refresh.
        signatureParts.push(fileName, vectorIds.get(vector), entry.chatEmbeddingHash || '');
        vectors.push(vector);
    }
    if (vectors.length === 0) return null;
    const signature = JSON.stringify(signatureParts);
    if (semanticBasisCache?.signature === signature) return semanticBasisCache.basis;
    const generation = semanticCacheGeneration;
    const basis = await computePcaBasisAsync(vectors, { components: 3, signal: options.signal });
    if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
    if (generation === semanticCacheGeneration) semanticBasisCache = { signature, basis };
    return basis;
}

/** Persist only a bounded basis and three coordinates per chat, including evicted representatives. */
async function buildArchivedSemanticContext(entries, options) {
    const generation = semanticCacheGeneration;
    const byFile = new Map(entries.map(item => [item.fileName, item.entry]));
    const sourceOptions = { fileNames: [...byFile.keys()], signal: options.signal };
    const signatureParts = ['archive', options.embeddingRevision || 0];
    let sample = [];
    let dims = 0, count = 0, sampleLimit = 0, randomState = 0x517cc1b7;
    for await (const record of options.iterateChatVectors(sourceOptions)) {
        if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
        const vector = record.vector;
        if (!byFile.has(record.fileName) || !isVector(vector) || !vector.length) continue;
        if (!dims) {
            dims = vector.length;
            sampleLimit = Math.max(1, Math.min(1024, Math.floor((8 * 1024 * 1024) / (dims * 4))));
            signatureParts.push(dims);
        }
        if (vector.length !== dims) continue;
        const entry = byFile.get(record.fileName);
        let identity = record.hash || entry.cachedChatEmbeddingHash || entry.chatEmbeddingHash;
        if (!identity) {
            if (!vectorIds.has(vector)) vectorIds.set(vector, nextVectorId++);
            identity = vectorIds.get(vector);
        }
        signatureParts.push(record.fileName, record.epoch ?? '', record.recipeKey || '', identity);
        count++;
        if (sample.length < sampleLimit) sample.push(Float32Array.from(vector));
        else {
            randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5;
            const slot = Math.floor((randomState >>> 0) / 4294967296 * count);
            if (slot < sampleLimit) sample[slot] = Float32Array.from(vector);
        }
    }
    if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
    if (!count) {
        if (generation === semanticCacheGeneration) semanticBasisCache = null;
        return null;
    }
    const signature = JSON.stringify(signatureParts);
    if (semanticBasisCache?.signature === signature) return { projections: semanticBasisCache.projections };
    const basis = await computePcaBasisAsync(sample, { components: 3, signal: options.signal });
    sample = [];
    const projections = new Map();
    for await (const record of options.iterateChatVectors(sourceOptions)) {
        if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
        if (byFile.has(record.fileName) && isVector(record.vector) && record.vector.length === dims) {
            projections.set(record.fileName, projectVectorToPca(record.vector, basis));
        }
    }
    if (options.signal?.aborted) throw options.signal.reason || new Error('Icicle build cancelled');
    if (generation === semanticCacheGeneration) semanticBasisCache = { signature, basis, projections };
    return { projections };
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

/** PCA is linear: average three projected coordinates, never retain a D-vector per group. */
function meanProjectedCoordinates(chatFiles, projections) {
    if (!projections) return null;
    const sum = [0, 0, 0];
    let count = 0;
    for (const file of chatFiles) {
        const point = projections.get(file);
        if (!point) continue;
        for (let axis = 0; axis < 3; axis++) sum[axis] += point[axis] || 0;
        count++;
    }
    return count ? sum.map(value => value / count) : null;
}

/**
 * @param {TrieNode} node
 * @param {Object} chatIndex
 * @param {{ mean: number[]|null, components: number[][]|null }} semanticContext
 */
function annotateSemanticFields(root, chatIndex, semanticContext, aggregateCache) {
    const projections = semanticContext?.projections || (semanticContext ? new Map() : null);
    if (projections && !semanticContext.projections) {
        for (const file of root.chatFiles) {
            const vector = chatIndex[file]?.chatEmbedding;
            if (isVector(vector) && vector.length === semanticContext.mean.length) {
                projections.set(file, projectVectorToPca(vector, semanticContext));
            }
        }
    }
    const stack = [root];
    while (stack.length) {
        const node = stack.pop();
        let aggregate = aggregateCache.get(node.chatFiles);
        if (!aggregate) {
            aggregate = {
                clusterLabel: majorityCluster(node.chatFiles, chatIndex),
                pca3d: meanProjectedCoordinates(node.chatFiles, projections),
            };
            aggregateCache.set(node.chatFiles, aggregate);
        }
        node.clusterLabel = aggregate.clusterLabel;
        node.chatEmbedding = null;
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
            ordered.forEach((child, i) => previousOrder.set(child.key, i));
        }

        // Keep existing branches in place during refreshes and chat switches. New
        // branches follow them; the initial layout still prioritizes the active chat.
        children.sort((a, b) => {
            const aOrder = previousOrder.get(a.key) ?? Infinity;
            const bOrder = previousOrder.get(b.key) ?? Infinity;
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
            const previousChild = previousNode?.children.get(child.key);
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
