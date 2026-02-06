/**
 * Timeline Data — Transforms chatIndex into Cytoscape-compatible elements.
 *
 * Algorithm:
 * 1. Filter chatIndex to loaded entries with messages
 * 2. Transpose: build depthBuckets[depth] = [{fileName, message}]
 * 3. Group identical messages at each depth (by normalized text)
 * 4. Create one Cytoscape node per group (depth-0 nodes are graph roots)
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

const DEPTH_LIMIT = { mini: 150, full: 500 };

/**
 * Build a Cytoscape-compatible element array from chatIndex.
 *
 * @param {Object} chatIndex - keyed by fileName, each entry has messages[], messageCount, isLoaded
 * @param {string|null} activeChatFile - filename of the active chat
 * @param {'mini'|'full'} [mode='mini'] - display mode (controls depth cap and position spacing)
 * @returns {{ elements: Array<{group:string, data:Object}>, nodeDetails: Map, maxDepth: number, loadedCount: number }}
 */
export function buildTimelineData(chatIndex, activeChatFile, mode = 'mini') {
    const loadedEntries = [];
    for (const [fileName, entry] of Object.entries(chatIndex)) {
        if (entry.isLoaded && entry.messages && entry.messages.length > 0) {
            loadedEntries.push({ fileName, entry });
        }
    }

    const nodeDetails = new Map();

    if (loadedEntries.length === 0) {
        return { elements: [], nodeDetails, maxDepth: 0, loadedCount: 0 };
    }

    // ── Step 1: Build depth buckets (capped by mode) ──
    // depthBuckets[depth] = [{ fileName, message, normalizedText }]
    const depthLimit = DEPTH_LIMIT[mode] || 500;
    let maxDepth = 0;
    const depthBuckets = [];

    for (const { fileName, entry } of loadedEntries) {
        const limit = Math.min(entry.messages.length, depthLimit);
        for (let i = 0; i < limit; i++) {
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

    const effectiveMaxDepth = Math.min(maxDepth, depthLimit);

    // ── Position spacing for pre-computed layout ──
    const spacingX = mode === 'full' ? 60 : 25;
    const spacingY = mode === 'full' ? 30 : 15;

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

    for (let depth = 0; depth <= effectiveMaxDepth; depth++) {
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

        const groupCount = groups.size;

        // Create nodes and edges for each group
        for (const [, group] of groups) {
            const nodeId = `d${depth}_g${group.groupIdx}`;
            const representative = group.items[0].message;
            const chatFiles = group.items.map(it => it.fileName);
            const normalizedLabel = group.items[0].normalizedText;

            // Build chatLengths: { fileName: totalMessages }
            const chatLengths = {};
            for (const item of group.items) {
                const entry = chatIndex[item.fileName];
                chatLengths[item.fileName] = entry ? entry.messageCount : 0;
            }

            const isActive = activeChatFile && chatFiles.includes(activeChatFile);

            // Pre-compute position: center groups within each depth row
            const offset = (group.groupIdx - (groupCount - 1) / 2) * spacingX;
            const position = mode === 'full'
                ? { x: depth * spacingX, y: offset }
                : { x: offset, y: depth * spacingY };

            nodes.push({
                group: 'nodes',
                data: {
                    id: nodeId,
                    label: truncate(normalizedLabel, 40),
                    role: representative.role,
                    chat_depth: depth,
                    isUser: representative.role === 'user',
                    isActive: !!isActive,
                    isRoot: depth === 0,
                    msgIndex: depth,
                    sharedCount: chatFiles.length,
                },
                position,
            });

            // Store heavy data in side-map
            nodeDetails.set(nodeId, {
                msg: representative.text,
                timestamp: representative.timestamp || null,
                chatFiles,
                chatLengths,
            });

            if (isActive) activeNodeIds.add(nodeId);

            // ── Create edges using pre-bucketed source grouping (O(n)) ──
            const bySource = new Map();
            for (const item of group.items) {
                const src = previousNodeId[item.fileName];
                if (!src) continue;
                if (!bySource.has(src)) bySource.set(src, []);
                bySource.get(src).push(item);
            }

            for (const [sourceId, items] of bySource) {
                const edgeKey = `${sourceId}->${nodeId}`;
                if (edgeSet.has(edgeKey)) continue;
                edgeSet.add(edgeKey);

                const edgeChatFiles = items.map(it => it.fileName);
                const edgeIsActive = activeChatFile && edgeChatFiles.includes(activeChatFile);
                const edgeId = `e_${edgeKey}`;

                edges.push({
                    group: 'edges',
                    data: {
                        id: edgeId,
                        source: sourceId,
                        target: nodeId,
                        isActive: !!edgeIsActive,
                    },
                });

                if (edgeIsActive) activeEdgeIds.add(edgeId);
            }

            // Update previousNodeId for all items in this group
            for (const item of group.items) {
                previousNodeId[item.fileName] = nodeId;
            }
        }
    }

    return {
        elements: [...nodes, ...edges],
        nodeDetails,
        maxDepth: effectiveMaxDepth,
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
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '\u2026';
}
