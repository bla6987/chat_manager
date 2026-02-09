/**
 * Graph View — Force-directed semantic graph with pinnable search terms and messages.
 *
 * Pins (anchors) can be:
 *   1. Search terms — user types a phrase, it gets embedded and becomes a gravity well.
 *   2. Messages — user clicks a message node to promote it to a pin.
 *
 * Neighboring messages cluster around whichever pin they are most semantically similar to.
 * Layout is computed via a velocity-verlet force simulation with spring attraction,
 * node repulsion, and velocity damping.
 */

import { getIndex, getMessageEmbedding, getMessageActiveSwipeIndex } from './chat-reader.js';
import { embedText, isEmbeddingConfigured } from './embedding-service.js';
import { clusterColor, cosineSimilarity } from './semantic-engine.js';
import { getDisplayName, getEmbeddingSettings } from './metadata-store.js';

/* ── Constants ── */

const MODULE_NAME = 'chat_manager';
const MIN_QUERY_CHARS = 3;
const DEFAULT_NEIGHBORS_PER_PIN = 50;
const MIN_NEIGHBORS = 10;
const MAX_NEIGHBORS = 150;
const MAX_PINS = 8;

const SPRING_K = 0.06;
const REPULSION_STRENGTH = 800;
const DAMPING = 0.88;
const PIN_CIRCLE_RADIUS = 180;
const SETTLE_ENERGY_THRESHOLD = 0.05;
const SETTLE_FRAMES = 30;
const MAX_VELOCITY = 12;

const PIN_RADIUS = 12;
const NEIGHBOR_MIN_RADIUS = 3;
const NEIGHBOR_MAX_RADIUS = 7;
const LABEL_FONT = '11px sans-serif';
const LABEL_MAX_CHARS = 36;
const TOOLTIP_MAX_CHARS = 300;

const PALETTE = [
    '#E05252', '#5294E0', '#52B788', '#E0A052',
    '#9B72CF', '#52BFB8', '#CF7298', '#7E8C4A',
];

/* ── Module State ── */

let mounted = false;
let container = null;
let canvas = null;
let ctx = null;
let overlayEl = null;
let toolbarEl = null;
let infoEl = null;
let queryInputEl = null;
let pinBtnEl = null;
let clearBtnEl = null;
let sliderEl = null;
let sliderLabelEl = null;
let emptyEl = null;
let loadingEl = null;

let dpr = 1;
let canvasWidth = 0;
let canvasHeight = 0;
let resizeObserver = null;

let onJumpToChat = null;
let getActiveChatFile = null;

/* ── Embedding Data ── */

let messageRefs = [];     // { fileName, displayName, msgIndex, swipeIndex, isActiveSwipe, role, timestamp, text }
let messageVectors = [];  // number[][] — parallel to messageRefs
let messageDims = 0;
let messageNorms = [];    // precomputed L2 norms

/* ── Pin State ── */

/**
 * @typedef {Object} PinNode
 * @property {'term'|'message'} kind
 * @property {string} label — display text (search term or truncated message)
 * @property {number[]} vector — embedding vector
 * @property {number} colorIndex — palette index
 * @property {number} x
 * @property {number} y
 * @property {boolean} fixed — always true for pins unless being dragged
 * @property {number|null} msgRefIndex — index into messageRefs, or null for search terms
 */
/** @type {PinNode[]} */
let pins = [];
let nextColorIndex = 0;

/* ── Simulation Nodes ── */

/**
 * @typedef {Object} SimNode
 * @property {number} x
 * @property {number} y
 * @property {number} vx
 * @property {number} vy
 * @property {boolean} isPin
 * @property {number} pinIndex — which pin this node belongs to (-1 = is a pin)
 * @property {number} similarity — cosine sim to owning pin (1.0 for pins themselves)
 * @property {number} colorIndex
 * @property {number|null} msgRefIndex — index into messageRefs
 * @property {string} label
 * @property {'term'|'message'} kind
 */
/** @type {SimNode[]} */
let simNodes = [];
let neighborsPerPin = DEFAULT_NEIGHBORS_PER_PIN;

/* ── Camera ── */

const camera = {
    x: 0,
    y: 0,
    zoom: 1,
};

/* ── Interaction ── */

let interaction = {
    mode: null, // 'pan' | 'dragPin'
    dragNodeIndex: -1,
    startX: 0,
    startY: 0,
    cameraStartX: 0,
    cameraStartY: 0,
    moved: false,
};

let hoveredNodeIndex = -1;
let selectedNodeIndex = -1;
let tooltipVisible = false;

/* ── Animation ── */

let rafId = null;
let renderPending = false;
let settleCounter = 0;
let simRunning = false;

/* ══════════════════════════════════════════════
   Public API
   ══════════════════════════════════════════════ */

export function setGraphViewCallbacks(callbacks) {
    onJumpToChat = callbacks.onJump || null;
    getActiveChatFile = callbacks.getActive || null;
}

export function isGraphViewMounted() {
    return mounted;
}

export async function mountGraphView(containerEl) {
    if (mounted) unmountGraphView();

    container = containerEl;
    container.innerHTML = '';
    container.style.position = 'relative';

    createCanvas();
    createOverlay();
    showLoading('Preparing graph view…');

    collectMessageVectors();

    if (messageRefs.length === 0) {
        hideLoading();
        showEmpty('No message embeddings found. Generate message embeddings first.');
        mounted = true;
        return;
    }

    hideLoading();
    mounted = true;
    setInfo(`${messageRefs.length.toLocaleString()} messages available · Pin a search term to begin`);

    bindEvents();
    bindResizeObserver();
    resizeCanvas();
    queueRender();
}

export function unmountGraphView() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    renderPending = false;
    simRunning = false;

    unbindEvents();
    unbindResizeObserver();

    if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    if (canvas) { canvas.remove(); canvas = null; }
    ctx = null;

    container = null;
    toolbarEl = null;
    infoEl = null;
    queryInputEl = null;
    pinBtnEl = null;
    clearBtnEl = null;
    sliderEl = null;
    sliderLabelEl = null;
    emptyEl = null;
    loadingEl = null;

    messageRefs = [];
    messageVectors = [];
    messageNorms = [];
    messageDims = 0;

    pins = [];
    nextColorIndex = 0;
    simNodes = [];

    hoveredNodeIndex = -1;
    selectedNodeIndex = -1;
    tooltipVisible = false;

    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    canvasWidth = 0;
    canvasHeight = 0;

    mounted = false;
}

export function updateGraphViewData() {
    if (!mounted || !container) return;
    const prevRefs = messageRefs;
    const prevVectors = messageVectors;
    const prevNorms = messageNorms;
    const prevDims = messageDims;
    collectMessageVectors();
    if (messageRefs.length === 0) {
        const hydrationInProgress = Object.values(getIndex()).some(entry => entry && !entry.isLoaded);
        if (prevRefs.length > 0 && hydrationInProgress) {
            messageRefs = prevRefs;
            messageVectors = prevVectors;
            messageNorms = prevNorms;
            messageDims = prevDims;
            hideEmpty();
            setInfo('Indexing chats… keeping existing graph');
            queueRender();
            return;
        }
        clearGraphDataState();
        showEmpty('No message embeddings found. Generate message embeddings first.');
        setInfo('No message embeddings available.');
        return;
    }
    hideEmpty();
    // Re-score existing pins against new data
    rebuildSimulation();
    queueRender();
}

function clearGraphDataState() {
    pins = [];
    nextColorIndex = 0;
    simNodes = [];
    simRunning = false;
    settleCounter = 0;
    hoveredNodeIndex = -1;
    selectedNodeIndex = -1;
    tooltipVisible = false;
    const existing = container?.querySelector?.('.chat-manager-graph-view-context');
    if (existing) existing.remove();
    queueRender();
}

/* ══════════════════════════════════════════════
   Data Collection
   ══════════════════════════════════════════════ */

function collectMessageVectors() {
    const index = getIndex();
    const settings = getEmbeddingSettings();
    const showAlternateSwipes = settings.includeAlternateSwipes === true && settings.showAlternateSwipesInResults === true;
    const maxSwipesPerMessage = Number.isFinite(Number(settings.maxSwipesPerMessage))
        ? Math.max(1, Math.min(64, Math.floor(Number(settings.maxSwipesPerMessage))))
        : 8;
    const refs = [];
    const vecs = [];
    const norms = [];
    let detectedDims = 0;

    for (const [fileName, entry] of Object.entries(index)) {
        if (!entry?.isLoaded || !(entry.messageEmbeddings instanceof Map) || entry.messageEmbeddings.size === 0) {
            continue;
        }

        const displayName = getDisplayName(fileName) || fileName;
        for (const msg of entry.messages || []) {
            const activeSwipeIndex = getMessageActiveSwipeIndex(msg);
            const variants = [{
                swipeIndex: activeSwipeIndex,
                text: typeof msg.text === 'string' ? msg.text : '',
                isActiveSwipe: true,
            }];

            if (showAlternateSwipes && Array.isArray(msg.swipes) && msg.swipes.length > 0) {
                const limit = Math.min(msg.swipes.length, maxSwipesPerMessage);
                for (let swipeIndex = 0; swipeIndex < limit; swipeIndex++) {
                    if (swipeIndex === activeSwipeIndex) continue;
                    const swipeText = typeof msg.swipes[swipeIndex] === 'string' ? msg.swipes[swipeIndex] : '';
                    if (!swipeText.trim()) continue;
                    variants.push({
                        swipeIndex,
                        text: swipeText,
                        isActiveSwipe: false,
                    });
                }
            }

            for (const variant of variants) {
                const vec = getMessageEmbedding(entry, msg, variant.swipeIndex);
                if (!Array.isArray(vec) || vec.length === 0) continue;

                if (!detectedDims) detectedDims = vec.length;
                if (vec.length !== detectedDims) continue;

                // Precompute norm
                let normSq = 0;
                for (let d = 0; d < detectedDims; d++) normSq += vec[d] * vec[d];
                const n = Math.sqrt(normSq);

                vecs.push(vec);
                norms.push(n);
                refs.push({
                    fileName,
                    displayName,
                    msgIndex: msg.index,
                    swipeIndex: variant.swipeIndex,
                    isActiveSwipe: variant.isActiveSwipe,
                    role: msg.role,
                    timestamp: msg.timestamp || '',
                    text: variant.text,
                });
            }
        }
    }

    messageRefs = refs;
    messageVectors = vecs;
    messageNorms = norms;
    messageDims = detectedDims;
}

/* ══════════════════════════════════════════════
   Pin Management
   ══════════════════════════════════════════════ */

async function addSearchTermPin(query) {
    if (!query || query.length < MIN_QUERY_CHARS) return;
    if (pins.length >= MAX_PINS) {
        setInfo(`Maximum ${MAX_PINS} pins reached. Remove a pin first.`);
        return;
    }
    if (!isEmbeddingConfigured()) {
        setInfo('Configure embedding provider in settings first.');
        return;
    }

    // Check for duplicate term pins
    const lowerQuery = query.toLowerCase().trim();
    if (pins.some(p => p.kind === 'term' && p.label.toLowerCase() === lowerQuery)) {
        setInfo(`"${truncate(query, 30)}" is already pinned.`);
        return;
    }

    setInfo(`Embedding "${truncate(query, 30)}"…`);

    let vector;
    try {
        vector = await embedText(query, { level: 'query' });
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to embed search term:`, err);
        setInfo('Failed to embed search term.');
        return;
    }

    if (!Array.isArray(vector) || vector.length === 0) {
        setInfo('Embedding returned empty vector.');
        return;
    }

    const angle = (pins.length / Math.max(1, MAX_PINS)) * Math.PI * 2;
    const radius = PIN_CIRCLE_RADIUS * Math.min(1, pins.length * 0.5 + 0.5);

    const pin = {
        kind: 'term',
        label: query.trim(),
        vector,
        colorIndex: nextColorIndex++ % PALETTE.length,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        fixed: true,
        msgRefIndex: null,
    };

    pins.push(pin);
    rebuildSimulation();
    autoFitCamera();
    startSimulation();
    updatePinInfo();
}

function addMessagePin(msgRefIndex) {
    if (msgRefIndex < 0 || msgRefIndex >= messageRefs.length) return;
    if (pins.length >= MAX_PINS) {
        setInfo(`Maximum ${MAX_PINS} pins reached. Remove a pin first.`);
        return;
    }

    // Don't double-pin same message
    if (pins.some(p => p.kind === 'message' && p.msgRefIndex === msgRefIndex)) return;

    const ref = messageRefs[msgRefIndex];
    const vector = messageVectors[msgRefIndex];

    const angle = (pins.length / Math.max(1, MAX_PINS)) * Math.PI * 2;
    const radius = PIN_CIRCLE_RADIUS * Math.min(1, pins.length * 0.5 + 0.5);

    const pin = {
        kind: 'message',
        label: truncate(ref.text, LABEL_MAX_CHARS),
        vector,
        colorIndex: nextColorIndex++ % PALETTE.length,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        fixed: true,
        msgRefIndex,
    };

    pins.push(pin);
    rebuildSimulation();
    autoFitCamera();
    startSimulation();
    updatePinInfo();
}

function removePin(pinIndex) {
    if (pinIndex < 0 || pinIndex >= pins.length) return;
    pins.splice(pinIndex, 1);

    // Reindex colors
    for (let i = 0; i < pins.length; i++) {
        pins[i].colorIndex = i % PALETTE.length;
    }
    nextColorIndex = pins.length;

    rebuildSimulation();
    if (pins.length > 0) {
        autoFitCamera();
        startSimulation();
    }
    updatePinInfo();
}

function clearAllPins() {
    pins = [];
    nextColorIndex = 0;
    simNodes = [];
    simRunning = false;
    hoveredNodeIndex = -1;
    selectedNodeIndex = -1;
    camera.x = 0;
    camera.y = 0;
    camera.zoom = 1;
    setInfo(`${messageRefs.length.toLocaleString()} messages available · Pin a search term to begin`);
    queueRender();
}

function updatePinInfo() {
    if (pins.length === 0) {
        setInfo(`${messageRefs.length.toLocaleString()} messages available · Pin a search term to begin`);
    } else {
        const neighborCount = simNodes.filter(n => !n.isPin).length;
        setInfo(`${pins.length} pin${pins.length > 1 ? 's' : ''} · ${neighborCount} neighbors`);
    }
}

/* ══════════════════════════════════════════════
   Simulation Build
   ══════════════════════════════════════════════ */

function rebuildSimulation() {
    if (pins.length === 0) {
        simNodes = [];
        queueRender();
        return;
    }

    const nodes = [];

    // Add pin nodes
    for (let p = 0; p < pins.length; p++) {
        const pin = pins[p];
        nodes.push({
            x: pin.x,
            y: pin.y,
            vx: 0,
            vy: 0,
            isPin: true,
            pinIndex: p,
            similarity: 1.0,
            colorIndex: pin.colorIndex,
            msgRefIndex: pin.msgRefIndex,
            label: pin.label,
            kind: pin.kind,
        });
    }

    // Score all messages against all pins, find best pin + similarity
    const scored = [];
    for (let i = 0; i < messageRefs.length; i++) {
        // Skip messages that are already pins
        if (pins.some(p => p.kind === 'message' && p.msgRefIndex === i)) continue;

        let bestPin = -1;
        let bestSim = -Infinity;

        for (let p = 0; p < pins.length; p++) {
            const sim = fastCosineSim(pins[p].vector, messageVectors[i], messageNorms[i]);
            if (sim > bestSim) {
                bestSim = sim;
                bestPin = p;
            }
        }

        if (bestPin >= 0) {
            scored.push({ msgIndex: i, pinIndex: bestPin, similarity: bestSim });
        }
    }

    // For each pin, take top-N neighbors by similarity
    const perPinBuckets = new Array(pins.length).fill(null).map(() => []);
    for (const s of scored) {
        perPinBuckets[s.pinIndex].push(s);
    }

    for (const bucket of perPinBuckets) {
        bucket.sort((a, b) => b.similarity - a.similarity);
    }

    const neighborLimit = neighborsPerPin;
    for (let p = 0; p < pins.length; p++) {
        const bucket = perPinBuckets[p];
        const pin = pins[p];
        const take = Math.min(bucket.length, neighborLimit);

        for (let i = 0; i < take; i++) {
            const s = bucket[i];
            const ref = messageRefs[s.msgIndex];

            // Place neighbor near its pin with some random offset
            const angle = Math.random() * Math.PI * 2;
            const dist = 40 + Math.random() * 60;

            nodes.push({
                x: pin.x + Math.cos(angle) * dist,
                y: pin.y + Math.sin(angle) * dist,
                vx: 0,
                vy: 0,
                isPin: false,
                pinIndex: p,
                similarity: s.similarity,
                colorIndex: pin.colorIndex,
                msgRefIndex: s.msgIndex,
                label: truncate(ref.text, LABEL_MAX_CHARS),
                kind: 'message',
            });
        }
    }

    simNodes = nodes;
    settleCounter = 0;
}

function fastCosineSim(vecA, vecB, normB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let normASq = 0;
    for (let d = 0; d < vecA.length; d++) {
        dot += vecA[d] * vecB[d];
        normASq += vecA[d] * vecA[d];
    }
    const normA = Math.sqrt(normASq);
    if (normA < 1e-12 || normB < 1e-12) return 0;
    const sim = dot / (normA * normB);
    return Math.max(-1, Math.min(1, sim));
}

/* ══════════════════════════════════════════════
   Force Simulation
   ══════════════════════════════════════════════ */

function startSimulation() {
    simRunning = true;
    settleCounter = 0;
    if (!rafId) tick();
}

function tick() {
    rafId = requestAnimationFrame(() => {
        if (!mounted) { rafId = null; return; }

        if (simRunning) {
            const energy = stepSimulation();
            if (energy < SETTLE_ENERGY_THRESHOLD) {
                settleCounter++;
                if (settleCounter >= SETTLE_FRAMES) {
                    simRunning = false;
                }
            } else {
                settleCounter = 0;
            }
        }

        render();

        // Keep ticking if sim is running or we need re-render
        if (simRunning || renderPending) {
            renderPending = false;
            tick();
        } else {
            rafId = null;
        }
    });
}

function stepSimulation() {
    const n = simNodes.length;
    if (n === 0) return 0;

    // Reset forces
    const fx = new Float64Array(n);
    const fy = new Float64Array(n);

    // 1. Spring attraction: each non-pin node toward its owning pin
    for (let i = 0; i < n; i++) {
        const node = simNodes[i];
        if (node.isPin) continue;

        // Find the pin node in simNodes
        const pinNode = simNodes[node.pinIndex];
        if (!pinNode) continue;

        const dx = pinNode.x - node.x;
        const dy = pinNode.y - node.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1e-6;

        // Rest length proportional to (1 - similarity) — more similar = closer
        const restLength = 30 + (1 - node.similarity) * 200;
        const displacement = dist - restLength;
        const force = SPRING_K * displacement;

        fx[i] += (dx / dist) * force;
        fy[i] += (dy / dist) * force;
    }

    // 2. Repulsion between all nodes (O(n^2) — fine for n < 500)
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const dx = simNodes[j].x - simNodes[i].x;
            const dy = simNodes[j].y - simNodes[i].y;
            const distSq = dx * dx + dy * dy + 1;
            const force = REPULSION_STRENGTH / distSq;
            const dist = Math.sqrt(distSq);

            const forceX = (dx / dist) * force;
            const forceY = (dy / dist) * force;

            if (!simNodes[i].isPin) { fx[i] -= forceX; fy[i] -= forceY; }
            if (!simNodes[j].isPin) { fx[j] += forceX; fy[j] += forceY; }
        }
    }

    // 3. Gentle centering for pins (keep them from drifting during interactions)
    for (let i = 0; i < n; i++) {
        if (!simNodes[i].isPin) continue;
        const pin = pins[simNodes[i].pinIndex];
        if (!pin) continue;
        // Pins stay at their assigned position
        simNodes[i].x = pin.x;
        simNodes[i].y = pin.y;
    }

    // 4. Integrate velocity + apply damping
    let totalEnergy = 0;
    for (let i = 0; i < n; i++) {
        if (simNodes[i].isPin) continue;

        simNodes[i].vx = (simNodes[i].vx + fx[i]) * DAMPING;
        simNodes[i].vy = (simNodes[i].vy + fy[i]) * DAMPING;

        // Clamp velocity
        const speed = Math.sqrt(simNodes[i].vx * simNodes[i].vx + simNodes[i].vy * simNodes[i].vy);
        if (speed > MAX_VELOCITY) {
            simNodes[i].vx = (simNodes[i].vx / speed) * MAX_VELOCITY;
            simNodes[i].vy = (simNodes[i].vy / speed) * MAX_VELOCITY;
        }

        simNodes[i].x += simNodes[i].vx;
        simNodes[i].y += simNodes[i].vy;

        totalEnergy += simNodes[i].vx * simNodes[i].vx + simNodes[i].vy * simNodes[i].vy;
    }

    return totalEnergy / Math.max(1, n);
}

/* ══════════════════════════════════════════════
   Canvas Setup & Rendering
   ══════════════════════════════════════════════ */

function createCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'chat-manager-graph-view-canvas';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    ctx = canvas.getContext('2d');
}

function resizeCanvas() {
    if (!canvas || !container) return;
    dpr = window.devicePixelRatio || 1;
    const rect = container.getBoundingClientRect();
    canvasWidth = Math.max(1, rect.width);
    canvasHeight = Math.max(1, rect.height);
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = canvasHeight + 'px';
    queueRender();
}

function queueRender() {
    renderPending = true;
    if (!rafId && mounted) tick();
}

function render() {
    if (!ctx || !canvas) return;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Clear
    ctx.fillStyle = 'rgba(10, 13, 18, 0.97)';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Subtle radial gradient background
    const grad = ctx.createRadialGradient(
        canvasWidth * 0.5, canvasHeight * 0.35, 0,
        canvasWidth * 0.5, canvasHeight * 0.35, canvasWidth * 0.7,
    );
    grad.addColorStop(0, 'rgba(42, 55, 70, 0.25)');
    grad.addColorStop(1, 'rgba(10, 13, 16, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    if (simNodes.length === 0) {
        ctx.restore();
        return;
    }

    // Apply camera transform
    ctx.save();
    ctx.translate(canvasWidth / 2, canvasHeight / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // Draw edges (neighbor → pin)
    drawEdges();

    // Draw neighbor nodes (back layer)
    drawNeighborNodes();

    // Draw pin nodes (front layer)
    drawPinNodes();

    // Draw hovered node highlight
    if (hoveredNodeIndex >= 0 && hoveredNodeIndex < simNodes.length) {
        drawNodeHighlight(hoveredNodeIndex);
    }

    ctx.restore(); // camera transform

    // Draw tooltip in screen space
    if (hoveredNodeIndex >= 0 && hoveredNodeIndex < simNodes.length) {
        drawTooltip(hoveredNodeIndex);
    }

    ctx.restore(); // dpr transform
}

function drawEdges() {
    ctx.lineWidth = 0.5 / camera.zoom;

    for (const node of simNodes) {
        if (node.isPin) continue;

        const pinNode = simNodes[node.pinIndex];
        if (!pinNode) continue;

        const alpha = 0.06 + node.similarity * 0.14;
        const color = PALETTE[node.colorIndex % PALETTE.length];
        ctx.strokeStyle = hexToRgba(color, alpha);

        ctx.beginPath();
        ctx.moveTo(node.x, node.y);
        ctx.lineTo(pinNode.x, pinNode.y);
        ctx.stroke();
    }
}

function drawNeighborNodes() {
    for (let i = 0; i < simNodes.length; i++) {
        const node = simNodes[i];
        if (node.isPin) continue;

        const color = PALETTE[node.colorIndex % PALETTE.length];
        const radius = NEIGHBOR_MIN_RADIUS + node.similarity * (NEIGHBOR_MAX_RADIUS - NEIGHBOR_MIN_RADIUS);
        const alpha = 0.3 + node.similarity * 0.55;

        ctx.fillStyle = hexToRgba(color, alpha);
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawPinNodes() {
    for (let i = 0; i < simNodes.length; i++) {
        const node = simNodes[i];
        if (!node.isPin) continue;

        const color = PALETTE[node.colorIndex % PALETTE.length];

        // Outer ring
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5 / camera.zoom;
        ctx.beginPath();
        ctx.arc(node.x, node.y, PIN_RADIUS, 0, Math.PI * 2);
        ctx.stroke();

        // Fill
        ctx.fillStyle = hexToRgba(color, 0.15);
        ctx.beginPath();
        ctx.arc(node.x, node.y, PIN_RADIUS, 0, Math.PI * 2);
        ctx.fill();

        // Inner dot
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
        ctx.fill();

        // Label
        const fontSize = Math.max(9, 11 / camera.zoom);
        ctx.font = `600 ${fontSize}px sans-serif`;
        ctx.fillStyle = 'rgba(230, 236, 244, 0.92)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(truncate(node.label, 28), node.x, node.y + PIN_RADIUS + 4);
    }
}

function drawNodeHighlight(index) {
    const node = simNodes[index];
    const radius = node.isPin ? PIN_RADIUS + 4 : NEIGHBOR_MIN_RADIUS + node.similarity * (NEIGHBOR_MAX_RADIUS - NEIGHBOR_MIN_RADIUS) + 3;
    const color = PALETTE[node.colorIndex % PALETTE.length];

    ctx.strokeStyle = hexToRgba(color, 0.7);
    ctx.lineWidth = 2 / camera.zoom;
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.strokeStyle = hexToRgba(color, 0.3);
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function drawTooltip(index) {
    const node = simNodes[index];
    const screen = worldToScreen(node.x, node.y);

    let text = '';
    if (node.kind === 'term') {
        text = `Pin: "${node.label}"`;
    } else if (node.msgRefIndex != null && node.msgRefIndex >= 0) {
        const ref = messageRefs[node.msgRefIndex];
        const roleBadge = ref.role === 'user' ? 'User' : 'AI';
        const simPct = (node.similarity * 100).toFixed(1);
        const swipeBadge = ref.isActiveSwipe ? 'Active' : `Alt #${Number(ref.swipeIndex) + 1}`;
        text = `[${roleBadge}] ${truncate(ref.text, TOOLTIP_MAX_CHARS)}`;
        if (!node.isPin) {
            text += `\nSimilarity: ${simPct}% · ${ref.displayName} · ${swipeBadge}`;
        } else {
            text += `\n${ref.displayName} · ${swipeBadge}`;
        }
    }

    if (!text) return;

    const lines = text.split('\n');
    const padding = 8;
    const lineHeight = 15;
    const maxWidth = 320;

    ctx.font = '12px sans-serif';

    let boxWidth = 0;
    for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > boxWidth) boxWidth = w;
    }
    boxWidth = Math.min(boxWidth, maxWidth) + padding * 2;
    const boxHeight = lines.length * lineHeight + padding * 2;

    let tx = screen.x + 12;
    let ty = screen.y - boxHeight - 8;
    if (tx + boxWidth > canvasWidth) tx = screen.x - boxWidth - 12;
    if (ty < 4) ty = screen.y + 16;

    // Background
    ctx.fillStyle = 'rgba(20, 20, 30, 0.94)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    roundRect(ctx, tx, ty, boxWidth, boxHeight, 6);
    ctx.fill();
    ctx.stroke();

    // Text
    ctx.fillStyle = 'rgba(230, 236, 244, 0.92)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
        ctx.fillText(truncate(lines[i], 60), tx + padding, ty + padding + i * lineHeight);
    }
}

/* ══════════════════════════════════════════════
   Overlay DOM
   ══════════════════════════════════════════════ */

function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.className = 'chat-manager-graph-view-overlay';

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'chat-manager-graph-view-toolbar';

    queryInputEl = document.createElement('input');
    queryInputEl.className = 'chat-manager-graph-view-query';
    queryInputEl.type = 'text';
    queryInputEl.placeholder = 'Type a topic to pin…';

    pinBtnEl = document.createElement('button');
    pinBtnEl.className = 'chat-manager-btn chat-manager-graph-view-btn';
    pinBtnEl.textContent = 'Pin';

    clearBtnEl = document.createElement('button');
    clearBtnEl.className = 'chat-manager-btn chat-manager-graph-view-btn';
    clearBtnEl.textContent = 'Clear';

    // Slider for neighbor count
    const sliderWrap = document.createElement('div');
    sliderWrap.className = 'chat-manager-graph-view-slider-wrap';

    sliderLabelEl = document.createElement('span');
    sliderLabelEl.className = 'chat-manager-graph-view-slider-label';
    sliderLabelEl.textContent = `${neighborsPerPin}`;

    sliderEl = document.createElement('input');
    sliderEl.className = 'chat-manager-graph-view-slider';
    sliderEl.type = 'range';
    sliderEl.min = String(MIN_NEIGHBORS);
    sliderEl.max = String(MAX_NEIGHBORS);
    sliderEl.value = String(neighborsPerPin);
    sliderEl.title = 'Neighbors per pin';

    sliderWrap.appendChild(sliderLabelEl);
    sliderWrap.appendChild(sliderEl);

    infoEl = document.createElement('div');
    infoEl.className = 'chat-manager-graph-view-info';

    toolbarEl.appendChild(queryInputEl);
    toolbarEl.appendChild(pinBtnEl);
    toolbarEl.appendChild(clearBtnEl);
    toolbarEl.appendChild(sliderWrap);

    overlayEl.appendChild(toolbarEl);
    overlayEl.appendChild(infoEl);

    emptyEl = document.createElement('div');
    emptyEl.className = 'chat-manager-graph-view-empty';
    emptyEl.style.display = 'none';
    overlayEl.appendChild(emptyEl);

    loadingEl = document.createElement('div');
    loadingEl.className = 'chat-manager-graph-view-loading';
    loadingEl.style.display = 'none';
    loadingEl.innerHTML = `
        <div class="chat-manager-spinner"></div>
        <div class="chat-manager-graph-view-loading-text"></div>
    `;
    overlayEl.appendChild(loadingEl);

    container.appendChild(overlayEl);
    bindOverlayEvents();
}

function bindOverlayEvents() {
    pinBtnEl?.addEventListener('click', () => {
        const query = (queryInputEl?.value || '').trim();
        if (query.length >= MIN_QUERY_CHARS) {
            void addSearchTermPin(query);
            if (queryInputEl) queryInputEl.value = '';
        }
    });

    clearBtnEl?.addEventListener('click', clearAllPins);

    queryInputEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const query = (queryInputEl?.value || '').trim();
            if (query.length >= MIN_QUERY_CHARS) {
                void addSearchTermPin(query);
                if (queryInputEl) queryInputEl.value = '';
            }
        }
        // Prevent event from bubbling to SillyTavern
        e.stopPropagation();
    });

    queryInputEl?.addEventListener('keyup', (e) => e.stopPropagation());
    queryInputEl?.addEventListener('keypress', (e) => e.stopPropagation());

    sliderEl?.addEventListener('input', () => {
        const val = parseInt(sliderEl.value, 10);
        if (Number.isFinite(val)) {
            neighborsPerPin = Math.max(MIN_NEIGHBORS, Math.min(MAX_NEIGHBORS, val));
            if (sliderLabelEl) sliderLabelEl.textContent = `${neighborsPerPin}`;
            if (pins.length > 0) {
                rebuildSimulation();
                startSimulation();
                updatePinInfo();
            }
        }
    });
}

/* ══════════════════════════════════════════════
   Canvas Events (Pan, Zoom, Hover, Click)
   ══════════════════════════════════════════════ */

let boundHandlers = {};

function bindEvents() {
    const onPointerDown = handlePointerDown.bind(null);
    const onPointerMove = handlePointerMove.bind(null);
    const onPointerUp = handlePointerUp.bind(null);
    const onWheel = handleWheel.bind(null);
    const onResize = resizeCanvas.bind(null);

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);

    boundHandlers = { onPointerDown, onPointerMove, onPointerUp, onWheel, onResize };
}

function unbindEvents() {
    if (canvas && boundHandlers.onPointerDown) {
        canvas.removeEventListener('pointerdown', boundHandlers.onPointerDown);
    }
    if (canvas && boundHandlers.onWheel) {
        canvas.removeEventListener('wheel', boundHandlers.onWheel);
    }
    if (boundHandlers.onPointerMove) {
        window.removeEventListener('pointermove', boundHandlers.onPointerMove);
    }
    if (boundHandlers.onPointerUp) {
        window.removeEventListener('pointerup', boundHandlers.onPointerUp);
    }
    if (boundHandlers.onResize) {
        window.removeEventListener('resize', boundHandlers.onResize);
    }
    boundHandlers = {};
}

function bindResizeObserver() {
    if (!container || typeof ResizeObserver !== 'function') return;
    resizeObserver = new ResizeObserver(() => {
        resizeCanvas();
    });
    resizeObserver.observe(container);
}

function unbindResizeObserver() {
    if (!resizeObserver) return;
    resizeObserver.disconnect();
    resizeObserver = null;
}

function handlePointerDown(e) {
    if (!mounted || !canvas) return;
    if (e.target !== canvas) return;

    const worldPos = screenToWorld(e.offsetX, e.offsetY);
    const hitIndex = hitTest(worldPos.x, worldPos.y);

    interaction.startX = e.clientX;
    interaction.startY = e.clientY;
    interaction.moved = false;

    if (hitIndex >= 0 && simNodes[hitIndex].isPin) {
        // Start dragging pin
        interaction.mode = 'dragPin';
        interaction.dragNodeIndex = hitIndex;
        canvas.setPointerCapture(e.pointerId);
    } else {
        // Start panning
        interaction.mode = 'pan';
        interaction.cameraStartX = camera.x;
        interaction.cameraStartY = camera.y;
        canvas.setPointerCapture(e.pointerId);
    }
}

function handlePointerMove(e) {
    if (!mounted || !canvas) return;

    if (interaction.mode === 'pan') {
        const dx = (e.clientX - interaction.startX) / camera.zoom;
        const dy = (e.clientY - interaction.startY) / camera.zoom;
        camera.x = interaction.cameraStartX - dx;
        camera.y = interaction.cameraStartY - dy;
        interaction.moved = true;
        queueRender();
        return;
    }

    if (interaction.mode === 'dragPin') {
        const worldPos = screenToWorld(e.offsetX, e.offsetY);
        const node = simNodes[interaction.dragNodeIndex];
        if (node && node.isPin) {
            const pin = pins[node.pinIndex];
            if (pin) {
                pin.x = worldPos.x;
                pin.y = worldPos.y;
                node.x = worldPos.x;
                node.y = worldPos.y;
            }
        }
        interaction.moved = true;
        startSimulation(); // reheat
        return;
    }

    // Hover detection
    if (e.target === canvas) {
        const worldPos = screenToWorld(e.offsetX, e.offsetY);
        const hitIndex = hitTest(worldPos.x, worldPos.y);
        if (hitIndex !== hoveredNodeIndex) {
            hoveredNodeIndex = hitIndex;
            canvas.style.cursor = hitIndex >= 0 ? 'pointer' : 'crosshair';
            queueRender();
        }
    }
}

function handlePointerUp(e) {
    if (!mounted) return;

    const wasDrag = interaction.moved;
    const mode = interaction.mode;
    const dragIndex = interaction.dragNodeIndex;

    interaction.mode = null;
    interaction.dragNodeIndex = -1;

    if (!wasDrag && mode !== null) {
        // It was a click, not a drag
        const worldPos = screenToWorld(e.offsetX, e.offsetY);
        const hitIndex = hitTest(worldPos.x, worldPos.y);

        if (hitIndex >= 0) {
            handleNodeClick(hitIndex);
        }
    }
}

function handleWheel(e) {
    if (!mounted || !canvas) return;
    e.preventDefault();

    const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newZoom = Math.max(0.1, Math.min(10, camera.zoom * scaleFactor));

    // Zoom toward cursor position
    const worldBefore = screenToWorld(e.offsetX, e.offsetY);
    camera.zoom = newZoom;
    const worldAfter = screenToWorld(e.offsetX, e.offsetY);

    camera.x += worldBefore.x - worldAfter.x;
    camera.y += worldBefore.y - worldAfter.y;

    queueRender();
}

function handleNodeClick(index) {
    const node = simNodes[index];

    if (node.isPin) {
        // Click on pin → unpin it
        removePin(node.pinIndex);
        hoveredNodeIndex = -1;
        queueRender();
    } else if (node.msgRefIndex != null && node.msgRefIndex >= 0) {
        // Click on neighbor → context menu: pin or jump
        selectedNodeIndex = index;
        showNodeContextMenu(index);
    }
}

function showNodeContextMenu(index) {
    const node = simNodes[index];
    if (!node || node.msgRefIndex == null) return;

    const ref = messageRefs[node.msgRefIndex];
    if (!ref) return;

    // Remove old context menu if any
    const existing = container.querySelector('.chat-manager-graph-view-context');
    if (existing) existing.remove();

    const screen = worldToScreen(node.x, node.y);

    const menu = document.createElement('div');
    menu.className = 'chat-manager-graph-view-context';
    menu.style.position = 'absolute';
    menu.style.left = `${Math.min(screen.x + 8, canvasWidth - 180)}px`;
    menu.style.top = `${Math.min(screen.y + 8, canvasHeight - 100)}px`;
    menu.style.zIndex = '20';

    const pinBtn = document.createElement('button');
    pinBtn.className = 'chat-manager-btn chat-manager-graph-view-ctx-btn';
    pinBtn.textContent = 'Pin this message';
    pinBtn.addEventListener('click', () => {
        addMessagePin(node.msgRefIndex);
        menu.remove();
    });

    const jumpBtn = document.createElement('button');
    jumpBtn.className = 'chat-manager-btn chat-manager-graph-view-ctx-btn';
    jumpBtn.textContent = 'Jump to message';
    jumpBtn.addEventListener('click', () => {
        menu.remove();
        if (onJumpToChat && ref) {
            onJumpToChat(ref.fileName, ref.msgIndex);
        }
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'chat-manager-btn chat-manager-graph-view-ctx-btn';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => menu.remove());

    menu.appendChild(pinBtn);
    menu.appendChild(jumpBtn);
    menu.appendChild(closeBtn);
    container.appendChild(menu);

    // Auto-dismiss on next canvas click
    const dismiss = (ev) => {
        if (!menu.contains(ev.target)) {
            menu.remove();
            document.removeEventListener('pointerdown', dismiss, true);
        }
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

/* ══════════════════════════════════════════════
   Hit Testing
   ══════════════════════════════════════════════ */

function hitTest(wx, wy) {
    // Test pins first (priority), then neighbors
    let bestDist = Infinity;
    let bestIndex = -1;

    for (let i = 0; i < simNodes.length; i++) {
        const node = simNodes[i];
        const dx = wx - node.x;
        const dy = wy - node.y;
        const distSq = dx * dx + dy * dy;

        const hitRadius = node.isPin
            ? (PIN_RADIUS + 6) / camera.zoom
            : (NEIGHBOR_MAX_RADIUS + 4) / camera.zoom;

        if (distSq < hitRadius * hitRadius && distSq < bestDist) {
            // Prefer pins over neighbors when overlapping
            if (node.isPin || bestIndex < 0 || !simNodes[bestIndex]?.isPin) {
                bestDist = distSq;
                bestIndex = i;
            }
        }
    }

    return bestIndex;
}

/* ══════════════════════════════════════════════
   Camera Helpers
   ══════════════════════════════════════════════ */

function screenToWorld(sx, sy) {
    return {
        x: (sx - canvasWidth / 2) / camera.zoom + camera.x,
        y: (sy - canvasHeight / 2) / camera.zoom + camera.y,
    };
}

function worldToScreen(wx, wy) {
    return {
        x: (wx - camera.x) * camera.zoom + canvasWidth / 2,
        y: (wy - camera.y) * camera.zoom + canvasHeight / 2,
    };
}

function autoFitCamera() {
    if (simNodes.length === 0) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of simNodes) {
        if (node.x < minX) minX = node.x;
        if (node.x > maxX) maxX = node.x;
        if (node.y < minY) minY = node.y;
        if (node.y > maxY) maxY = node.y;
    }

    const spanX = Math.max(100, maxX - minX);
    const spanY = Math.max(100, maxY - minY);
    const padding = 1.3;

    camera.x = (minX + maxX) / 2;
    camera.y = (minY + maxY) / 2;
    camera.zoom = Math.min(
        canvasWidth / (spanX * padding),
        canvasHeight / (spanY * padding),
        3,
    );
    camera.zoom = Math.max(0.1, camera.zoom);
}

/* ══════════════════════════════════════════════
   Utility
   ══════════════════════════════════════════════ */

function truncate(str, maxLen) {
    if (!str) return '';
    const clean = str.replace(/\n/g, ' ').trim();
    return clean.length > maxLen ? clean.slice(0, maxLen - 1) + '…' : clean;
}

function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
}

function setInfo(text) {
    if (infoEl) {
        infoEl.textContent = text;
        infoEl.style.display = text ? '' : 'none';
    }
}

function showLoading(text) {
    if (loadingEl) {
        loadingEl.style.display = 'flex';
        const textEl = loadingEl.querySelector('.chat-manager-graph-view-loading-text');
        if (textEl) textEl.textContent = text;
    }
}

function hideLoading() {
    if (loadingEl) loadingEl.style.display = 'none';
}

function showEmpty(text) {
    if (emptyEl) {
        emptyEl.textContent = text;
        emptyEl.style.display = '';
    }
}

function hideEmpty() {
    if (emptyEl) emptyEl.style.display = 'none';
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
