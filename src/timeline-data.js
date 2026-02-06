/**
 * Timeline Data — Transforms chatIndex into Cytoscape-compatible elements.
 *
 * Algorithm:
 * 1. Filter chatIndex to loaded entries with messages
 * 2. Transpose: build depthBuckets[depth] = [{fileName, message}]
 * 3. Group identical messages at each depth (by normalized text)
 * 4. Create one Cytoscape node per group + one virtual root
 * 5. Track previousNodeId[fileName] to create edges (parent→child per file)
 * 6. Deduplicate edges with same source+target
 * 7. Mark active chat path on edges/nodes
 */

/**
 * Normalize message text for grouping: trim, collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    return (text || '').trim().replace(/\s+/g, ' ');
}

/**
 * Build a Cytoscape-compatible element array from chatIndex.
 *
 * @param {Object} chatIndex - keyed by fileName, each entry has messages[], messageCount, isLoaded
 * @param {string|null} activeChatFile - filename of the active chat
 * @returns {{ elements: Array<{group:string, data:Object}>, maxDepth: number, loadedCount: number }}
 */
export function buildTimelineData(chatIndex, activeChatFile) {
    const loadedEntries = [];
    for (const [fileName, entry] of Object.entries(chatIndex)) {
        if (entry.isLoaded && entry.messages && entry.messages.length > 0) {
            loadedEntries.push({ fileName, entry });
        }
    }

    if (loadedEntries.length === 0) {
        return { elements: [], maxDepth: 0, loadedCount: 0 };
    }

    // ── Step 1: Build depth buckets ──
    // depthBuckets[depth] = [{ fileName, message, normalizedText }]
    let maxDepth = 0;
    const depthBuckets = [];

    for (const { fileName, entry } of loadedEntries) {
        for (let i = 0; i < entry.messages.length; i++) {
            const msg = entry.messages[i];
            if (!depthBuckets[i]) depthBuckets[i] = [];
            depthBuckets[i].push({
                fileName,
                message: msg,
                normalizedText: normalizeText(msg.text),
            });
            if (i > maxDepth) maxDepth = i;
        }
    }

    // ── Step 2: Group by normalized text at each depth ──
    // Each group becomes one node. nodeId = `d${depth}_g${groupIdx}`
    const nodes = [];
    const edges = [];
    const edgeSet = new Set(); // "source->target" dedup

    // Track which node each file was last assigned to
    const previousNodeId = {}; // fileName → lastNodeId

    // Track which nodes are on the active path
    const activeNodeIds = new Set();
    const activeEdgeIds = new Set();

    // Virtual root node
    nodes.push({
        group: 'nodes',
        data: {
            id: 'root',
            label: 'Start',
            chat_depth: -1,
            isUser: false,
            timestamp: null,
            chatFiles: loadedEntries.map(e => e.fileName),
            chatLengths: {},
            isActive: !!activeChatFile,
            isRoot: true,
        },
    });

    // Set root as previous for all files
    for (const { fileName } of loadedEntries) {
        previousNodeId[fileName] = 'root';
    }

    for (let depth = 0; depth <= maxDepth; depth++) {
        const bucket = depthBuckets[depth];
        if (!bucket || bucket.length === 0) continue;

        // Group by normalizedText
        const groups = new Map(); // normalizedText → { items: [], groupIdx }
        let groupIdx = 0;

        for (const item of bucket) {
            const key = item.normalizedText;
            if (!groups.has(key)) {
                groups.set(key, { items: [], groupIdx: groupIdx++ });
            }
            groups.get(key).items.push(item);
        }

        // Create nodes and edges for each group
        for (const [, group] of groups) {
            const nodeId = `d${depth}_g${group.groupIdx}`;
            const representative = group.items[0].message;
            const chatFiles = group.items.map(it => it.fileName);

            // Build chatLengths: { fileName: totalMessages }
            const chatLengths = {};
            for (const item of group.items) {
                const entry = chatIndex[item.fileName];
                chatLengths[item.fileName] = entry ? entry.messageCount : 0;
            }

            const isActive = activeChatFile && chatFiles.includes(activeChatFile);

            nodes.push({
                group: 'nodes',
                data: {
                    id: nodeId,
                    label: truncate(representative.text, 40),
                    msg: representative.text,
                    role: representative.role,
                    chat_depth: depth,
                    isUser: representative.role === 'user',
                    timestamp: representative.timestamp || null,
                    chatFiles,
                    chatLengths,
                    isActive: !!isActive,
                    isRoot: false,
                    msgIndex: depth,
                    sharedCount: chatFiles.length,
                },
            });

            if (isActive) activeNodeIds.add(nodeId);

            // Create edges from each file's previous node to this node
            for (const item of group.items) {
                const sourceId = previousNodeId[item.fileName];
                if (!sourceId) continue;

                const edgeKey = `${sourceId}->${nodeId}`;
                if (!edgeSet.has(edgeKey)) {
                    edgeSet.add(edgeKey);

                    const edgeChatFiles = [];
                    // Collect all files that share this edge
                    for (const it of group.items) {
                        if (previousNodeId[it.fileName] === sourceId) {
                            edgeChatFiles.push(it.fileName);
                        }
                    }

                    const edgeIsActive = activeChatFile && edgeChatFiles.includes(activeChatFile);
                    const edgeId = `e_${edgeKey}`;

                    edges.push({
                        group: 'edges',
                        data: {
                            id: edgeId,
                            source: sourceId,
                            target: nodeId,
                            chatFiles: edgeChatFiles,
                            isActive: !!edgeIsActive,
                        },
                    });

                    if (edgeIsActive) activeEdgeIds.add(edgeId);
                }

                // Update previous node for this file
                previousNodeId[item.fileName] = nodeId;
            }
        }
    }

    // Mark root as active if the active chat is present
    if (activeChatFile && activeNodeIds.size > 0) {
        activeNodeIds.add('root');
    }

    return {
        elements: [...nodes, ...edges],
        maxDepth,
        loadedCount: loadedEntries.length,
    };
}

/**
 * Truncate text for node labels.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return clean.substring(0, max - 1) + '\u2026';
}
