/**
 * Timeline Data — Transforms chatIndex into Cytoscape-compatible elements.
 *
 * Algorithm:
 * 1. Filter chatIndex to loaded entries with messages.
 * 2. Transpose into depth buckets.
 * 3. Detect modified greetings (depth 0 metadata pass).
 * 4. Group identical text at each visible depth (starting depth 1).
 * 5. Build base nodes + edges with shared chat membership metadata.
 * 6. Collapse linear runs of repeated text into aggregate segment nodes.
 */

const DEPTH_LIMIT = { mini: 150, full: 500 };
const CHAT_KEY_SEPARATOR = '\u001f';

/**
 * Normalize message text for grouping: trim + collapse whitespace.
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    return (text || '').trim().replace(/\s+/g, ' ');
}

/**
 * Stable key for chat file membership set.
 * @param {string[]} chatFiles
 * @returns {string}
 */
function buildChatKey(chatFiles) {
    return [...chatFiles].sort().join(CHAT_KEY_SEPARATOR);
}

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

    // ── Step 2: Detect modified greetings at depth 0 ──
    const modifiedGreetingFiles = new Set();
    const greetingBucket = depthBuckets[0];
    if (greetingBucket && greetingBucket.length > 1) {
        const greetingCounts = new Map();
        for (const item of greetingBucket) {
            const count = greetingCounts.get(item.normalizedText) || 0;
            greetingCounts.set(item.normalizedText, count + 1);
        }

        let majorityText = '';
        let majorityCount = 0;
        for (const [text, count] of greetingCounts) {
            if (count > majorityCount) {
                majorityCount = count;
                majorityText = text;
            }
        }

        for (const item of greetingBucket) {
            if (item.normalizedText !== majorityText) {
                modifiedGreetingFiles.add(item.fileName);
            }
        }
    }

    // ── Step 3/4: Build base grouped nodes + edges ──
    const rawNodes = [];
    const rawEdges = [];
    const edgeSet = new Set();
    const previousNodeId = Object.create(null); // fileName -> last node id

    for (let depth = 1; depth <= effectiveMaxDepth; depth++) {
        const bucket = depthBuckets[depth];
        if (!bucket || bucket.length === 0) continue;

        const groups = new Map(); // normalizedText -> { items, groupIdx }
        let groupIdx = 0;

        for (const item of bucket) {
            const key = item.normalizedText;
            if (!groups.has(key)) {
                groups.set(key, { items: [], groupIdx: groupIdx++ });
            }
            groups.get(key).items.push(item);
        }

        const groupCount = groups.size;
        const isRootDepth = depth === 1;

        for (const [, group] of groups) {
            const nodeId = `d${depth}_g${group.groupIdx}`;
            const representative = group.items[0].message;
            const normalizedLabel = group.items[0].normalizedText;
            const chatFiles = group.items.map(it => it.fileName).sort();
            const chatKey = buildChatKey(chatFiles);

            const chatLengths = {};
            for (const item of group.items) {
                const entry = chatIndex[item.fileName];
                chatLengths[item.fileName] = entry ? entry.messageCount : 0;
            }

            const isActive = !!(activeChatFile && chatFiles.includes(activeChatFile));
            const hasModifiedGreeting = isRootDepth && chatFiles.some(f => modifiedGreetingFiles.has(f));

            const layoutDepth = depth - 1;
            const offset = (group.groupIdx - (groupCount - 1) / 2) * spacingX;
            const position = mode === 'full'
                ? { x: layoutDepth * spacingX, y: offset }
                : { x: offset, y: layoutDepth * spacingY };

            rawNodes.push({
                group: 'nodes',
                data: {
                    id: nodeId,
                    label: truncate(normalizedLabel, 40),
                    role: representative.role,
                    chat_depth: depth,
                    isUser: representative.role === 'user',
                    isActive,
                    isRoot: isRootDepth,
                    hasModifiedGreeting: !!hasModifiedGreeting,
                    msgIndex: depth,
                    sharedCount: chatFiles.length,
                    normalizedMsg: normalizedLabel,
                    chatKey,
                },
                position,
            });

            nodeDetails.set(nodeId, {
                msg: representative.text,
                normalizedMsg: normalizedLabel,
                timestamp: representative.timestamp || null,
                chatFiles: [...chatFiles],
                chatKey,
                chatLengths: { ...chatLengths },
                msgIndex: depth,
                role: representative.role,
            });

            const bySource = new Map();
            for (const item of group.items) {
                const sourceId = previousNodeId[item.fileName];
                if (!sourceId) continue;
                if (!bySource.has(sourceId)) bySource.set(sourceId, []);
                bySource.get(sourceId).push(item);
            }

            for (const [sourceId, items] of bySource) {
                const edgeKey = `${sourceId}->${nodeId}`;
                if (edgeSet.has(edgeKey)) continue;
                edgeSet.add(edgeKey);

                const edgeChatFiles = items.map(it => it.fileName);
                const edgeIsActive = !!(activeChatFile && edgeChatFiles.includes(activeChatFile));

                rawEdges.push({
                    group: 'edges',
                    data: {
                        id: `e_${edgeKey}`,
                        source: sourceId,
                        target: nodeId,
                        isActive: edgeIsActive,
                    },
                });
            }

            for (const item of group.items) {
                previousNodeId[item.fileName] = nodeId;
            }
        }
    }

    const collapsed = collapseRepeatedRuns(rawNodes, rawEdges, nodeDetails);

    // ── Step 5: Compute out-degree per node from post-collapse edges ──
    const outDegreeMap = new Map();
    for (const edge of collapsed.edges) {
        const src = edge.data.source;
        outDegreeMap.set(src, (outDegreeMap.get(src) || 0) + 1);
    }
    for (const node of collapsed.nodes) {
        node.data.outDegree = outDegreeMap.get(node.data.id) || 0;
    }

    return {
        elements: [...collapsed.nodes, ...collapsed.edges],
        nodeDetails: collapsed.nodeDetails,
        maxDepth: effectiveMaxDepth,
        loadedCount: loadedEntries.length,
    };
}

/**
 * Collapse linear chains where adjacent nodes represent the same message text
 * and the same chat membership set.
 *
 * @param {Array} rawNodes
 * @param {Array} rawEdges
 * @param {Map<string, Object>} rawDetails
 * @returns {{ nodes: Array, edges: Array, nodeDetails: Map<string, Object> }}
 */
function collapseRepeatedRuns(rawNodes, rawEdges, rawDetails) {
    const nodeById = new Map(rawNodes.map(node => [node.data.id, node]));
    const outgoing = new Map();
    const incoming = new Map();

    for (const edge of rawEdges) {
        if (!outgoing.has(edge.data.source)) outgoing.set(edge.data.source, []);
        if (!incoming.has(edge.data.target)) incoming.set(edge.data.target, []);
        outgoing.get(edge.data.source).push(edge);
        incoming.get(edge.data.target).push(edge);
    }

    const sortedNodes = [...rawNodes].sort((a, b) => (a.data.msgIndex || 0) - (b.data.msgIndex || 0));
    const visited = new Set();
    const runOwnerByMember = new Map(); // member node id -> run node id
    const runNodes = [];
    const runDetailsById = new Map();

    for (const node of sortedNodes) {
        const startId = node.data.id;
        if (visited.has(startId)) continue;

        const chain = [startId];
        let currentId = startId;

        while (true) {
            const out = outgoing.get(currentId) || [];
            if (out.length !== 1) break;

            const nextId = out[0].data.target;
            if (visited.has(nextId)) break;

            const nextIncoming = incoming.get(nextId) || [];
            if (nextIncoming.length !== 1 || nextIncoming[0].data.source !== currentId) break;

            if (!canCollapsePair(currentId, nextId, nodeById, rawDetails)) break;

            chain.push(nextId);
            currentId = nextId;
        }

        if (chain.length < 2) continue;

        const runId = `run_${startId}`;
        const runBundle = createRunBundle(runId, chain, nodeById, rawDetails);
        runNodes.push(runBundle.node);
        runDetailsById.set(runId, runBundle.detail);

        for (const memberId of chain) {
            visited.add(memberId);
            runOwnerByMember.set(memberId, runId);
        }
    }

    const finalNodes = [];
    const finalDetails = new Map();

    for (const node of rawNodes) {
        const nodeId = node.data.id;
        if (runOwnerByMember.has(nodeId)) continue;
        finalNodes.push(node);
        finalDetails.set(nodeId, rawDetails.get(nodeId));
    }

    for (const runNode of runNodes) {
        finalNodes.push(runNode);
        finalDetails.set(runNode.data.id, runDetailsById.get(runNode.data.id));
    }

    const dedupEdges = new Map();
    for (const edge of rawEdges) {
        const source = runOwnerByMember.get(edge.data.source) || edge.data.source;
        const target = runOwnerByMember.get(edge.data.target) || edge.data.target;
        if (source === target) continue;

        const edgeKey = `${source}->${target}`;
        const existing = dedupEdges.get(edgeKey);
        if (existing) {
            existing.data.isActive = existing.data.isActive || !!edge.data.isActive;
            continue;
        }

        dedupEdges.set(edgeKey, {
            group: 'edges',
            data: {
                id: `e_${edgeKey}`,
                source,
                target,
                isActive: !!edge.data.isActive,
            },
        });
    }

    return {
        nodes: finalNodes,
        edges: [...dedupEdges.values()],
        nodeDetails: finalDetails,
    };
}

/**
 * Check if two adjacent nodes can be collapsed into the same repeated run.
 * @param {string} leftId
 * @param {string} rightId
 * @param {Map<string, Object>} nodeById
 * @param {Map<string, Object>} detailsById
 * @returns {boolean}
 */
function canCollapsePair(leftId, rightId, nodeById, detailsById) {
    const leftNode = nodeById.get(leftId);
    const rightNode = nodeById.get(rightId);
    if (!leftNode || !rightNode) return false;

    if ((rightNode.data.msgIndex || 0) !== (leftNode.data.msgIndex || 0) + 1) return false;
    if (leftNode.data.role !== rightNode.data.role) return false;

    const leftDetails = detailsById.get(leftId);
    const rightDetails = detailsById.get(rightId);
    if (!leftDetails || !rightDetails) return false;

    if (leftDetails.normalizedMsg !== rightDetails.normalizedMsg) return false;
    if (leftDetails.chatKey !== rightDetails.chatKey) return false;

    return true;
}

/**
 * Build a collapsed run node plus expansion metadata.
 * @param {string} runId
 * @param {string[]} chain
 * @param {Map<string, Object>} nodeById
 * @param {Map<string, Object>} detailsById
 * @returns {{ node: Object, detail: Object }}
 */
function createRunBundle(runId, chain, nodeById, detailsById) {
    const firstNode = nodeById.get(chain[0]);
    const lastNode = nodeById.get(chain[chain.length - 1]);
    const firstDetails = detailsById.get(chain[0]) || {};

    let totalX = 0;
    let totalY = 0;
    let isActive = false;
    let isRoot = false;
    let hasModifiedGreeting = false;

    const runMembers = [];
    const runMessageIds = [];

    for (let i = 0; i < chain.length; i++) {
        const sourceNodeId = chain[i];
        const sourceNode = nodeById.get(sourceNodeId);
        const sourceDetails = detailsById.get(sourceNodeId);
        if (!sourceNode || !sourceDetails) continue;

        const memberId = `${runId}__m${i}`;
        const position = {
            x: sourceNode.position?.x || 0,
            y: sourceNode.position?.y || 0,
        };

        totalX += position.x;
        totalY += position.y;

        isActive = isActive || !!sourceNode.data.isActive;
        isRoot = isRoot || !!sourceNode.data.isRoot;
        hasModifiedGreeting = hasModifiedGreeting || !!sourceNode.data.hasModifiedGreeting;
        runMessageIds.push(sourceNode.data.msgIndex);

        runMembers.push({
            id: memberId,
            node: {
                group: 'nodes',
                data: {
                    ...sourceNode.data,
                    id: memberId,
                    originalNodeId: sourceNodeId,
                    collapsedOwnerId: runId,
                    isRunMember: true,
                    isCollapsedRun: false,
                    startMsgIndex: sourceNode.data.msgIndex,
                    endMsgIndex: sourceNode.data.msgIndex,
                    runLength: 1,
                },
                position,
            },
            detail: {
                ...sourceDetails,
                chatFiles: [...(sourceDetails.chatFiles || [])],
                chatLengths: { ...(sourceDetails.chatLengths || {}) },
            },
        });
    }

    const runLength = runMembers.length;
    const startMsgIndex = firstNode?.data?.msgIndex || 0;
    const endMsgIndex = lastNode?.data?.msgIndex || startMsgIndex;
    const avgPosition = runLength > 0
        ? { x: totalX / runLength, y: totalY / runLength }
        : { x: firstNode?.position?.x || 0, y: firstNode?.position?.y || 0 };

    const normalizedPreview = firstDetails.normalizedMsg || normalizeText(firstDetails.msg || '');
    const runLabelBase = truncate(normalizedPreview, 22);
    const runLabel = runLabelBase ? `${runLabelBase} x${runLength}` : `Repeat x${runLength}`;

    return {
        node: {
            group: 'nodes',
            data: {
                id: runId,
                label: runLabel,
                role: firstNode?.data?.role || 'assistant',
                chat_depth: firstNode?.data?.chat_depth || startMsgIndex,
                isUser: !!firstNode?.data?.isUser,
                isActive,
                isRoot,
                hasModifiedGreeting,
                msgIndex: startMsgIndex,
                startMsgIndex,
                endMsgIndex,
                runLength,
                sharedCount: firstNode?.data?.sharedCount || (firstDetails.chatFiles || []).length,
                isCollapsedRun: true,
                normalizedMsg: normalizedPreview,
                chatKey: firstNode?.data?.chatKey || firstDetails.chatKey || buildChatKey(firstDetails.chatFiles || []),
            },
            position: avgPosition,
        },
        detail: {
            msg: firstDetails.msg || '',
            normalizedMsg: normalizedPreview,
            timestamp: firstDetails.timestamp || null,
            chatFiles: [...(firstDetails.chatFiles || [])],
            chatKey: firstDetails.chatKey || buildChatKey(firstDetails.chatFiles || []),
            chatLengths: { ...(firstDetails.chatLengths || {}) },
            msgIndex: startMsgIndex,
            role: firstDetails.role || firstNode?.data?.role || 'assistant',
            isCollapsedRun: true,
            runLength,
            startMsgIndex,
            endMsgIndex,
            runMessageIds,
            runMembers,
        },
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
