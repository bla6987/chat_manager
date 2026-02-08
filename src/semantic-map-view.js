/**
 * Semantic Map View — WebGL-first 2D semantic projection of message embeddings.
 */

import { getIndex } from './chat-reader.js';
import { embedText, isEmbeddingConfigured } from './embedding-service.js';
import { clusterColor } from './semantic-engine.js';
import { getDisplayName, getEmbeddingSettings, setEmbeddingSettings } from './metadata-store.js';

const MODULE_NAME = 'chat_manager';
const EXTENSION_PATH = '/scripts/extensions/third-party/chat_manager';

const MIN_QUERY_CHARS = 3;
const MAX_QUERY_CACHE = 32;
const DENSITY_TARGET_POINTS = 22000;
const AUTO_DENSITY_POINT_THRESHOLD = 40000;
const AUTO_DENSITY_ZOOM_THRESHOLD = 0.8;
const MIN_ZOOM = 0.03;
const MAX_ZOOM = 16;

let mounted = false;
let container = null;
let canvas = null;
let overlayEl = null;
let toolbarEl = null;
let infoEl = null;
let queryInputEl = null;
let queryBtnEl = null;
let clearBtnEl = null;
let lodBtnEl = null;
let simBtnEl = null;
let jumpBtnEl = null;
let emptyEl = null;
let loadingEl = null;

let gl = null;
let fallbackCtx = null;
let glProgram = null;
let glAttribs = null;
let glUniforms = null;
let dpr = 1;
let canvasWidth = 0;
let canvasHeight = 0;

let worker = null;
let workerBuildJobId = 0;
let workerScoreJobId = 0;

let messageRefs = [];
let messageLookup = new Map();
let dims = 0;
let points2d = new Float32Array(0);
let labels = new Uint16Array(0);
let centroids2d = new Float32Array(0);
let clusterSizes = new Uint32Array(0);
let bounds = { minX: -1, maxX: 1, minY: -1, maxY: 1 };

let fullRenderColors = new Float32Array(0);
let fullRenderSizes = new Float32Array(0);
let sampledPositions = new Float32Array(0);
let sampledColors = new Float32Array(0);
let sampledSizes = new Float32Array(0);
let sampledIndices = new Uint32Array(0);

let scoreValues = null;
let scoreMin = 0;
let scoreMax = 0;
let queryText = '';
let queryVectorCache = new Map();

let activePointIndex = -1;
let hoveredPointIndex = -1;
let selectedPointIndices = new Set();
let pendingFocus = null;

const gridIndex = {
    cols: 96,
    rows: 96,
    buckets: [],
    minX: -1,
    minY: -1,
    spanX: 2,
    spanY: 2,
};

const camera = {
    initialX: -1,
    initialY: -1,
    initialW: 2,
    initialH: 2,
    x: -1,
    y: -1,
    w: 2,
    h: 2,
};

let interaction = {
    mode: null, // 'pan' | 'brush'
    dragStartX: 0,
    dragStartY: 0,
    dragLastX: 0,
    dragLastY: 0,
    cameraStartX: 0,
    cameraStartY: 0,
    brushX0: 0,
    brushY0: 0,
    brushX1: 0,
    brushY1: 0,
    moved: false,
};

let renderPending = false;
let rafId = null;

let onJumpToChat = null;
let getActiveChatFile = null;

const glState = {
    posBuffer: null,
    colorBuffer: null,
    sizeBuffer: null,
    sampledPosBuffer: null,
    sampledColorBuffer: null,
    sampledSizeBuffer: null,
};

export function setSemanticMapCallbacks(callbacks) {
    onJumpToChat = callbacks.onJump || null;
    getActiveChatFile = callbacks.getActive || null;
}

export function isSemanticMapMounted() {
    return mounted;
}

export async function mountSemanticMap(containerEl, mode = 'mini') {
    if (mounted) {
        unmountSemanticMap();
    }

    container = containerEl;
    container.innerHTML = '';
    container.style.position = 'relative';

    createCanvas();
    createOverlay();
    showLoading('Preparing semantic map…');

    if (!ensureWorker()) {
        hideLoading();
        showEmpty('Semantic map unavailable: worker initialization failed.');
        mounted = true;
        return;
    }

    const data = collectMessageVectors();
    if (data.count === 0) {
        hideLoading();
        showEmpty('No message embeddings found. Generate message embeddings to use Semantic Map.');
        mounted = true;
        return;
    }

    mounted = true;
    setInfo(`Building map for ${data.count.toLocaleString()} messages…`);
    queueBuild(data);

    bindEvents();
    resizeCanvas();
    queueRender();

    void mode; // reserved for future full-screen tuning
}

export function unmountSemanticMap() {
    if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
    }
    renderPending = false;

    unbindEvents();

    if (worker) {
        worker.terminate();
        worker = null;
    }

    destroyGLResources();

    if (overlayEl) {
        overlayEl.remove();
        overlayEl = null;
    }
    if (canvas) {
        canvas.remove();
        canvas = null;
    }

    container = null;
    toolbarEl = null;
    infoEl = null;
    queryInputEl = null;
    queryBtnEl = null;
    clearBtnEl = null;
    lodBtnEl = null;
    simBtnEl = null;
    jumpBtnEl = null;
    emptyEl = null;
    loadingEl = null;

    gl = null;
    fallbackCtx = null;
    glProgram = null;
    glAttribs = null;
    glUniforms = null;

    messageRefs = [];
    messageLookup = new Map();
    dims = 0;
    points2d = new Float32Array(0);
    labels = new Uint16Array(0);
    centroids2d = new Float32Array(0);
    clusterSizes = new Uint32Array(0);
    scoreValues = null;
    scoreMin = 0;
    scoreMax = 0;
    queryText = '';
    queryVectorCache = new Map();
    selectedPointIndices = new Set();
    activePointIndex = -1;
    hoveredPointIndex = -1;
    pendingFocus = null;

    mounted = false;
}

export async function updateSemanticMapData() {
    if (!mounted || !container) return;

    const data = collectMessageVectors();
    if (data.count === 0) {
        hideLoading();
        showEmpty('No message embeddings found. Generate message embeddings to use Semantic Map.');
        return;
    }

    hideEmpty();
    showLoading('Refreshing semantic map…');
    setInfo(`Refreshing map (${data.count.toLocaleString()} messages)…`);
    queueBuild(data);
}

export function focusMessageInSemanticMap(filename, msgIndex, options = {}) {
    if (!filename || !Number.isInteger(msgIndex) || msgIndex < 0) return false;

    pendingFocus = {
        filename,
        msgIndex,
        openPopup: options.openPopup !== false,
        persistIfMissing: options.persistIfMissing !== false,
    };

    return tryApplyPendingFocus();
}

function ensureWorker() {
    if (worker) return true;
    try {
        worker = new Worker(`${EXTENSION_PATH}/src/semantic-map-worker.js`, { type: 'module' });
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Failed to create semantic worker:`, err);
        return false;
    }

    worker.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.type === 'mapDataReady') {
            if (msg.jobId !== workerBuildJobId) return;
            handleMapDataReady(msg);
            return;
        }

        if (msg.type === 'queryScoresReady') {
            if (msg.jobId !== workerScoreJobId) return;
            handleQueryScoresReady(msg);
            return;
        }

        if (msg.type === 'error') {
            console.warn(`[${MODULE_NAME}] Semantic worker error:`, msg.message);
            if (msg.jobId === workerBuildJobId) {
                hideLoading();
                showEmpty('Failed to build semantic map. Check console for details.');
                setInfo('Failed to build semantic map.');
            }
            if (msg.jobId === workerScoreJobId) {
                setInfo('Semantic query scoring failed.');
            }
        }
    };

    worker.onerror = (err) => {
        console.warn(`[${MODULE_NAME}] Semantic worker crashed:`, err);
        setInfo('Semantic map worker crashed.');
    };

    return true;
}

function collectMessageVectors() {
    const index = getIndex();
    const refs = [];
    const vectors = [];
    let detectedDims = 0;

    for (const [fileName, entry] of Object.entries(index)) {
        if (!entry?.isLoaded || !(entry.messageEmbeddings instanceof Map) || entry.messageEmbeddings.size === 0) {
            continue;
        }

        const displayName = getDisplayName(fileName) || fileName;
        for (const msg of entry.messages || []) {
            const vec = entry.messageEmbeddings.get(msg.index);
            if (!Array.isArray(vec) || vec.length === 0) continue;

            if (!detectedDims) {
                detectedDims = vec.length;
            }
            if (vec.length !== detectedDims) continue;

            vectors.push(vec);
            refs.push({
                fileName,
                displayName,
                msgIndex: msg.index,
                role: msg.role,
                timestamp: msg.timestamp || '',
                text: typeof msg.text === 'string' ? msg.text : '',
            });
        }
    }

    const count = vectors.length;
    if (!detectedDims || count === 0) {
        messageRefs = [];
        messageLookup = new Map();
        dims = 0;
        return { count: 0, dims: 0, vectorsFlat: new Float32Array(0) };
    }

    const vectorsFlat = new Float32Array(count * detectedDims);
    for (let i = 0; i < count; i++) {
        const row = vectors[i];
        const offset = i * detectedDims;
        for (let d = 0; d < detectedDims; d++) {
            vectorsFlat[offset + d] = row[d];
        }
    }

    messageRefs = refs;
    dims = detectedDims;
    messageLookup = new Map();
    for (let i = 0; i < refs.length; i++) {
        messageLookup.set(makePointKey(refs[i].fileName, refs[i].msgIndex), i);
    }

    return { count, dims: detectedDims, vectorsFlat };
}

function queueBuild({ count, dims: vectorDims, vectorsFlat }) {
    if (!worker) return;

    workerBuildJobId += 1;
    workerScoreJobId += 1; // invalidate in-flight score jobs after rebuild
    scoreValues = null;
    scoreMin = 0;
    scoreMax = 0;
    selectedPointIndices = new Set();
    hoveredPointIndex = -1;

    const settings = getEmbeddingSettings();
    const fixedK = Number.isFinite(settings.mapFixedK) ? settings.mapFixedK : null;

    worker.postMessage({
        type: 'buildMapData',
        jobId: workerBuildJobId,
        dims: vectorDims,
        vectorsFlatBuffer: vectorsFlat.buffer,
        fixedK,
        maxK: 8,
    }, [vectorsFlat.buffer]);

    showLoading(`Building map for ${count.toLocaleString()} messages…`);
    setInfo(`Projecting ${count.toLocaleString()} vectors…`);
}

function handleMapDataReady(msg) {
    points2d = new Float32Array(msg.points2dBuffer || new ArrayBuffer(0));
    labels = new Uint16Array(msg.labelsBuffer || new ArrayBuffer(0));
    centroids2d = new Float32Array(msg.centroids2dBuffer || new ArrayBuffer(0));
    clusterSizes = new Uint32Array(msg.clusterSizesBuffer || new ArrayBuffer(0));
    bounds = msg.bounds || { minX: -1, maxX: 1, minY: -1, maxY: 1 };

    hideLoading();
    initializeCamera(bounds);
    buildGridIndex();
    rebuildRenderBuffers();
    hideEmpty();

    const count = getPointCount();
    setInfo(`${count.toLocaleString()} points · ${Math.max(1, clusterSizes.length)} clusters`);

    if (queryText.length >= MIN_QUERY_CHARS) {
        void runSemanticQuery(queryText);
    }

    tryApplyPendingFocus();
    queueRender();
}

function handleQueryScoresReady(msg) {
    scoreValues = new Float32Array(msg.scoresBuffer || new ArrayBuffer(0));
    scoreMin = Number.isFinite(msg.min) ? msg.min : 0;
    scoreMax = Number.isFinite(msg.max) ? msg.max : 0;

    rebuildRenderBuffers();
    const count = getPointCount();
    setInfo(`Scored ${count.toLocaleString()} points for "${queryText}"`);
    queueRender();
}

function initializeCamera(nextBounds) {
    const spanX = Math.max(1e-6, nextBounds.maxX - nextBounds.minX);
    const spanY = Math.max(1e-6, nextBounds.maxY - nextBounds.minY);
    const padX = spanX * 0.08;
    const padY = spanY * 0.08;

    camera.initialX = nextBounds.minX - padX;
    camera.initialY = nextBounds.minY - padY;
    camera.initialW = spanX + (padX * 2);
    camera.initialH = spanY + (padY * 2);

    camera.x = camera.initialX;
    camera.y = camera.initialY;
    camera.w = camera.initialW;
    camera.h = camera.initialH;
}

function buildGridIndex() {
    gridIndex.buckets = new Array(gridIndex.cols * gridIndex.rows);
    for (let i = 0; i < gridIndex.buckets.length; i++) {
        gridIndex.buckets[i] = [];
    }

    gridIndex.minX = bounds.minX;
    gridIndex.minY = bounds.minY;
    gridIndex.spanX = Math.max(1e-6, bounds.maxX - bounds.minX);
    gridIndex.spanY = Math.max(1e-6, bounds.maxY - bounds.minY);

    const n = getPointCount();
    for (let i = 0; i < n; i++) {
        const x = points2d[i * 2];
        const y = points2d[(i * 2) + 1];
        const cellIdx = getGridCellIndex(x, y);
        gridIndex.buckets[cellIdx].push(i);
    }
}

function getGridCellIndex(x, y) {
    const tx = clamp01((x - gridIndex.minX) / gridIndex.spanX);
    const ty = clamp01((y - gridIndex.minY) / gridIndex.spanY);
    const gx = Math.max(0, Math.min(gridIndex.cols - 1, Math.floor(tx * gridIndex.cols)));
    const gy = Math.max(0, Math.min(gridIndex.rows - 1, Math.floor(ty * gridIndex.rows)));
    return (gy * gridIndex.cols) + gx;
}

function rebuildRenderBuffers() {
    const n = getPointCount();
    if (n === 0) {
        fullRenderColors = new Float32Array(0);
        fullRenderSizes = new Float32Array(0);
        sampledIndices = new Uint32Array(0);
        sampledPositions = new Float32Array(0);
        sampledColors = new Float32Array(0);
        sampledSizes = new Float32Array(0);
        uploadBuffersToGPU();
        return;
    }

    const settings = getEmbeddingSettings();
    const baseSize = Number.isFinite(settings.mapPointSize) ? settings.mapPointSize : 2.5;
    const simMode = settings.mapSimilarityChannel || 'both';
    const activeFile = getActiveChatFile ? getActiveChatFile() : null;

    fullRenderColors = new Float32Array(n * 4);
    fullRenderSizes = new Float32Array(n);

    const range = scoreMax - scoreMin;
    const hasScore = scoreValues instanceof Float32Array && scoreValues.length === n;

    for (let i = 0; i < n; i++) {
        const label = labels[i] || 0;
        const [r, g, b] = hexToRgb(clusterColor(label));

        let t = 0;
        if (hasScore) {
            const raw = scoreValues[i];
            t = range > 1e-9 ? (raw - scoreMin) / range : 1;
            t = clamp01(t);
        }

        const isActive = activeFile && messageRefs[i]?.fileName === activeFile;
        const alphaBoost = isActive ? 0.12 : 0;

        const alpha = hasScore && (simMode === 'alpha' || simMode === 'both')
            ? (0.1 + (0.9 * t) + alphaBoost)
            : (0.56 + alphaBoost);
        const size = hasScore && (simMode === 'size' || simMode === 'both')
            ? (baseSize + (t * 4.0) + (isActive ? 0.7 : 0))
            : (baseSize + (isActive ? 0.6 : 0));

        fullRenderColors[(i * 4)] = r / 255;
        fullRenderColors[(i * 4) + 1] = g / 255;
        fullRenderColors[(i * 4) + 2] = b / 255;
        fullRenderColors[(i * 4) + 3] = Math.max(0.04, Math.min(1, alpha));
        fullRenderSizes[i] = Math.max(1, Math.min(10, size));
    }

    buildSampledBuffers();
    uploadBuffersToGPU();
}

function buildSampledBuffers() {
    const n = getPointCount();
    if (n === 0) {
        sampledIndices = new Uint32Array(0);
        sampledPositions = new Float32Array(0);
        sampledColors = new Float32Array(0);
        sampledSizes = new Float32Array(0);
        return;
    }

    const stride = Math.max(1, Math.ceil(n / DENSITY_TARGET_POINTS));
    if (stride === 1) {
        sampledIndices = new Uint32Array(0);
        sampledPositions = new Float32Array(0);
        sampledColors = new Float32Array(0);
        sampledSizes = new Float32Array(0);
        return;
    }

    const sampleCount = Math.ceil(n / stride);
    sampledIndices = new Uint32Array(sampleCount);
    sampledPositions = new Float32Array(sampleCount * 2);
    sampledColors = new Float32Array(sampleCount * 4);
    sampledSizes = new Float32Array(sampleCount);

    let cursor = 0;
    for (let i = 0; i < n; i += stride) {
        sampledIndices[cursor] = i;

        sampledPositions[cursor * 2] = points2d[i * 2];
        sampledPositions[(cursor * 2) + 1] = points2d[(i * 2) + 1];

        sampledColors[cursor * 4] = fullRenderColors[i * 4];
        sampledColors[(cursor * 4) + 1] = fullRenderColors[(i * 4) + 1];
        sampledColors[(cursor * 4) + 2] = fullRenderColors[(i * 4) + 2];
        sampledColors[(cursor * 4) + 3] = Math.min(1, fullRenderColors[(i * 4) + 3] + 0.15);

        sampledSizes[cursor] = Math.max(1.3, fullRenderSizes[i] * 1.08);
        cursor += 1;
    }
}

function createCanvas() {
    canvas = document.createElement('canvas');
    canvas.className = 'chat-manager-semantic-map-canvas';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);

    gl = canvas.getContext('webgl2', { antialias: true, alpha: true })
        || canvas.getContext('webgl', { antialias: true, alpha: true });

    if (gl) {
        initGL();
    } else {
        fallbackCtx = canvas.getContext('2d');
    }
}

function createOverlay() {
    overlayEl = document.createElement('div');
    overlayEl.className = 'chat-manager-semantic-map-overlay';

    toolbarEl = document.createElement('div');
    toolbarEl.className = 'chat-manager-semantic-map-toolbar';

    queryInputEl = document.createElement('input');
    queryInputEl.className = 'chat-manager-semantic-map-query';
    queryInputEl.type = 'text';
    queryInputEl.placeholder = 'Semantic query…';

    queryBtnEl = document.createElement('button');
    queryBtnEl.className = 'chat-manager-btn chat-manager-semantic-map-btn';
    queryBtnEl.textContent = 'Search';

    clearBtnEl = document.createElement('button');
    clearBtnEl.className = 'chat-manager-btn chat-manager-semantic-map-btn';
    clearBtnEl.textContent = 'Clear';

    lodBtnEl = document.createElement('button');
    lodBtnEl.className = 'chat-manager-btn chat-manager-semantic-map-btn';

    simBtnEl = document.createElement('button');
    simBtnEl.className = 'chat-manager-btn chat-manager-semantic-map-btn';

    jumpBtnEl = document.createElement('button');
    jumpBtnEl.className = 'chat-manager-btn chat-manager-semantic-map-btn';
    jumpBtnEl.textContent = 'Jump';
    jumpBtnEl.disabled = true;

    infoEl = document.createElement('div');
    infoEl.className = 'chat-manager-semantic-map-info';

    toolbarEl.appendChild(queryInputEl);
    toolbarEl.appendChild(queryBtnEl);
    toolbarEl.appendChild(clearBtnEl);
    toolbarEl.appendChild(lodBtnEl);
    toolbarEl.appendChild(simBtnEl);
    toolbarEl.appendChild(jumpBtnEl);

    overlayEl.appendChild(toolbarEl);
    overlayEl.appendChild(infoEl);

    emptyEl = document.createElement('div');
    emptyEl.className = 'chat-manager-semantic-map-empty';
    emptyEl.style.display = 'none';
    overlayEl.appendChild(emptyEl);

    loadingEl = document.createElement('div');
    loadingEl.className = 'chat-manager-semantic-map-loading';
    loadingEl.style.display = 'none';
    loadingEl.innerHTML = `
        <div class="chat-manager-spinner"></div>
        <div class="chat-manager-semantic-map-loading-text"></div>
    `;
    overlayEl.appendChild(loadingEl);

    container.appendChild(overlayEl);

    updateLodButtonLabel();
    updateSimButtonLabel();
    bindOverlayEvents();
}

function bindOverlayEvents() {
    queryBtnEl?.addEventListener('click', () => {
        const query = (queryInputEl?.value || '').trim();
        void runSemanticQuery(query);
    });

    clearBtnEl?.addEventListener('click', () => {
        queryText = '';
        if (queryInputEl) queryInputEl.value = '';
        scoreValues = null;
        scoreMin = 0;
        scoreMax = 0;
        rebuildRenderBuffers();
        setInfo(`${getPointCount().toLocaleString()} points`);
        queueRender();
    });

    queryInputEl?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            void runSemanticQuery((queryInputEl?.value || '').trim());
        }
    });

    lodBtnEl?.addEventListener('click', () => {
        const settings = getEmbeddingSettings();
        const current = settings.mapLodMode || 'auto';
        const next = current === 'auto' ? 'points' : (current === 'points' ? 'density' : 'auto');
        setEmbeddingSettings({ mapLodMode: next });
        updateLodButtonLabel();
        queueRender();
    });

    simBtnEl?.addEventListener('click', () => {
        const settings = getEmbeddingSettings();
        const current = settings.mapSimilarityChannel || 'both';
        const next = current === 'both' ? 'alpha' : (current === 'alpha' ? 'size' : 'both');
        setEmbeddingSettings({ mapSimilarityChannel: next });
        updateSimButtonLabel();
        rebuildRenderBuffers();
        queueRender();
    });

    jumpBtnEl?.addEventListener('click', () => {
        jumpToSelectedPoint();
    });
}

async function runSemanticQuery(query) {
    if (!mounted) return;
    const requestedQuery = (query || '').trim();
    queryText = requestedQuery;

    if (requestedQuery.length < MIN_QUERY_CHARS) {
        scoreValues = null;
        scoreMin = 0;
        scoreMax = 0;
        rebuildRenderBuffers();
        setInfo(`${getPointCount().toLocaleString()} points`);
        queueRender();
        return;
    }

    if (!isEmbeddingConfigured()) {
        setInfo('Embeddings are not configured for semantic query scoring.');
        return;
    }

    let queryVector = queryVectorCache.get(requestedQuery);
    if (!queryVector) {
        setInfo('Embedding query…');
        try {
            queryVector = await embedText(requestedQuery, { level: 'query' });
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Failed to embed map query:`, err);
            setInfo('Failed to embed query.');
            return;
        }

        if (queryText !== requestedQuery) {
            return;
        }

        queryVectorCache.set(requestedQuery, queryVector);
        if (queryVectorCache.size > MAX_QUERY_CACHE) {
            const oldestKey = queryVectorCache.keys().next().value;
            queryVectorCache.delete(oldestKey);
        }
    }

    if (queryText !== requestedQuery) {
        return;
    }

    if (!worker) return;

    workerScoreJobId += 1;
    const jobId = workerScoreJobId;
    setInfo(`Scoring "${requestedQuery}"…`);
    worker.postMessage({
        type: 'scoreQuery',
        jobId,
        queryVector,
    });
}

function updateLodButtonLabel() {
    if (!lodBtnEl) return;
    const lod = getEmbeddingSettings().mapLodMode || 'auto';
    lodBtnEl.textContent = `LOD: ${lod}`;
}

function updateSimButtonLabel() {
    if (!simBtnEl) return;
    const mode = getEmbeddingSettings().mapSimilarityChannel || 'both';
    simBtnEl.textContent = `Sim: ${mode}`;
}

function showEmpty(message) {
    if (!emptyEl) return;
    emptyEl.textContent = message;
    emptyEl.style.display = '';
}

function hideEmpty() {
    if (!emptyEl) return;
    emptyEl.style.display = 'none';
}

function showLoading(message) {
    if (!loadingEl) return;
    const textEl = loadingEl.querySelector('.chat-manager-semantic-map-loading-text');
    if (textEl) textEl.textContent = message || 'Loading…';
    loadingEl.style.display = '';
}

function hideLoading() {
    if (!loadingEl) return;
    loadingEl.style.display = 'none';
}

function setInfo(text) {
    if (!infoEl) return;
    infoEl.textContent = text;
}

function bindEvents() {
    if (!canvas) return;

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    window.addEventListener('resize', onResize);
}

function unbindEvents() {
    if (!canvas) return;

    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseMove);
    canvas.removeEventListener('mouseup', onMouseUp);
    canvas.removeEventListener('mouseleave', onMouseLeave);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('dblclick', onDoubleClick);
    window.removeEventListener('resize', onResize);
}

function onResize() {
    resizeCanvas();
    queueRender();
}

function resizeCanvas() {
    if (!canvas || !container) return;

    dpr = window.devicePixelRatio || 1;
    canvasWidth = Math.max(1, container.clientWidth);
    canvasHeight = Math.max(1, container.clientHeight);

    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;

    if (gl) {
        gl.viewport(0, 0, canvas.width, canvas.height);
    } else if (fallbackCtx) {
        fallbackCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
}

function onMouseDown(e) {
    if (!canvas) return;

    interaction.dragStartX = e.offsetX;
    interaction.dragStartY = e.offsetY;
    interaction.dragLastX = e.offsetX;
    interaction.dragLastY = e.offsetY;
    interaction.cameraStartX = camera.x;
    interaction.cameraStartY = camera.y;
    interaction.moved = false;

    if (e.shiftKey) {
        interaction.mode = 'brush';
        interaction.brushX0 = e.offsetX;
        interaction.brushY0 = e.offsetY;
        interaction.brushX1 = e.offsetX;
        interaction.brushY1 = e.offsetY;
    } else {
        interaction.mode = 'pan';
    }
}

function onMouseMove(e) {
    if (!canvas) return;

    if (interaction.mode === 'pan') {
        const dx = e.offsetX - interaction.dragStartX;
        const dy = e.offsetY - interaction.dragStartY;
        if (Math.abs(dx) + Math.abs(dy) > 1) {
            interaction.moved = true;
        }

        const worldPerPixelX = camera.w / Math.max(1, canvasWidth);
        const worldPerPixelY = camera.h / Math.max(1, canvasHeight);
        camera.x = interaction.cameraStartX - (dx * worldPerPixelX);
        camera.y = interaction.cameraStartY - (dy * worldPerPixelY);

        clampCamera();
        queueRender();
        return;
    }

    if (interaction.mode === 'brush') {
        interaction.moved = true;
        interaction.brushX1 = e.offsetX;
        interaction.brushY1 = e.offsetY;
        queueRender();
        return;
    }

    const hit = hitTestPoint(e.offsetX, e.offsetY);
    if (hit !== hoveredPointIndex) {
        hoveredPointIndex = hit;
        updateJumpButtonState();
        queueRender();
    }
}

function onMouseUp(e) {
    if (!canvas) return;

    if (interaction.mode === 'brush') {
        applyBrushSelection();
        interaction.mode = null;
        queueRender();
        return;
    }

    if (interaction.mode === 'pan') {
        const moved = interaction.moved;
        interaction.mode = null;

        if (!moved) {
            const hit = hitTestPoint(e.offsetX, e.offsetY);
            if (hit >= 0) {
                selectedPointIndices = new Set([hit]);
                hoveredPointIndex = hit;
                updateSelectionInfo();
                queueRender();
            } else {
                selectedPointIndices.clear();
                updateSelectionInfo();
                queueRender();
            }
        }
    }
}

function onMouseLeave() {
    if (interaction.mode === 'brush') {
        applyBrushSelection();
    }
    interaction.mode = null;
}

function onWheel(e) {
    if (!canvas) return;
    e.preventDefault();

    const zoomFactor = e.deltaY > 0 ? 1.1 : 0.9;
    const before = screenToWorld(e.offsetX, e.offsetY);

    camera.w = Math.max(camera.initialW * MIN_ZOOM, Math.min(camera.initialW * MAX_ZOOM, camera.w * zoomFactor));
    camera.h = Math.max(camera.initialH * MIN_ZOOM, Math.min(camera.initialH * MAX_ZOOM, camera.h * zoomFactor));

    const after = screenToWorld(e.offsetX, e.offsetY);
    camera.x += before.x - after.x;
    camera.y += before.y - after.y;

    clampCamera();
    queueRender();
}

function onDoubleClick(e) {
    const hit = hitTestPoint(e.offsetX, e.offsetY);
    if (hit >= 0) {
        selectedPointIndices = new Set([hit]);
        jumpToSelectedPoint();
    }
}

function applyBrushSelection() {
    const x0 = Math.min(interaction.brushX0, interaction.brushX1);
    const x1 = Math.max(interaction.brushX0, interaction.brushX1);
    const y0 = Math.min(interaction.brushY0, interaction.brushY1);
    const y1 = Math.max(interaction.brushY0, interaction.brushY1);

    if ((x1 - x0) < 2 || (y1 - y0) < 2) {
        return;
    }

    const worldA = screenToWorld(x0, y0);
    const worldB = screenToWorld(x1, y1);
    const minX = Math.min(worldA.x, worldB.x);
    const maxX = Math.max(worldA.x, worldB.x);
    const minY = Math.min(worldA.y, worldB.y);
    const maxY = Math.max(worldA.y, worldB.y);

    const next = new Set();
    const n = getPointCount();
    for (let i = 0; i < n; i++) {
        const x = points2d[i * 2];
        const y = points2d[(i * 2) + 1];
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
            next.add(i);
        }
    }

    selectedPointIndices = next;
    hoveredPointIndex = next.size > 0 ? next.values().next().value : -1;
    updateSelectionInfo();
}

function updateSelectionInfo() {
    if (selectedPointIndices.size === 0) {
        setInfo(`${getPointCount().toLocaleString()} points` + (queryText ? ` · query: "${queryText}"` : ''));
    } else if (selectedPointIndices.size === 1) {
        const idx = selectedPointIndices.values().next().value;
        setInfo(formatPointInfo(idx));
    } else {
        setInfo(`Selected ${selectedPointIndices.size.toLocaleString()} points`);
    }
    updateJumpButtonState();
}

function updateJumpButtonState() {
    if (!jumpBtnEl) return;
    const hasTarget = selectedPointIndices.size > 0 || hoveredPointIndex >= 0;
    jumpBtnEl.disabled = !hasTarget;
}

function jumpToSelectedPoint() {
    let idx = -1;
    if (selectedPointIndices.size > 0) {
        idx = selectedPointIndices.values().next().value;
    } else if (hoveredPointIndex >= 0) {
        idx = hoveredPointIndex;
    }
    if (idx < 0) return;

    const ref = messageRefs[idx];
    if (!ref) return;
    if (typeof onJumpToChat === 'function') {
        void onJumpToChat(ref.fileName, ref.msgIndex);
    }
}

function tryApplyPendingFocus() {
    if (!pendingFocus) return false;

    const key = makePointKey(pendingFocus.filename, pendingFocus.msgIndex);
    const idx = messageLookup.get(key);
    if (!Number.isInteger(idx)) {
        if (!pendingFocus.persistIfMissing) {
            pendingFocus = null;
        }
        return false;
    }

    selectedPointIndices = new Set([idx]);
    hoveredPointIndex = idx;
    centerCameraOnPoint(idx);
    updateSelectionInfo();
    queueRender();
    pendingFocus = null;
    return true;
}

function centerCameraOnPoint(idx) {
    if (idx < 0 || idx >= getPointCount()) return;
    const x = points2d[idx * 2];
    const y = points2d[(idx * 2) + 1];

    camera.x = x - (camera.w * 0.5);
    camera.y = y - (camera.h * 0.5);
    clampCamera();
}

function hitTestPoint(px, py) {
    if (getPointCount() === 0) return -1;

    const world = screenToWorld(px, py);
    const thresholdWorld = Math.max(
        (camera.w / Math.max(1, canvasWidth)) * 10,
        (camera.h / Math.max(1, canvasHeight)) * 10,
    );
    const thresholdSq = thresholdWorld * thresholdWorld;

    const tx = clamp01((world.x - gridIndex.minX) / gridIndex.spanX);
    const ty = clamp01((world.y - gridIndex.minY) / gridIndex.spanY);
    const gx = Math.max(0, Math.min(gridIndex.cols - 1, Math.floor(tx * gridIndex.cols)));
    const gy = Math.max(0, Math.min(gridIndex.rows - 1, Math.floor(ty * gridIndex.rows)));

    let best = -1;
    let bestDist = Infinity;

    for (let oy = -1; oy <= 1; oy++) {
        const y = gy + oy;
        if (y < 0 || y >= gridIndex.rows) continue;
        for (let ox = -1; ox <= 1; ox++) {
            const x = gx + ox;
            if (x < 0 || x >= gridIndex.cols) continue;

            const bucket = gridIndex.buckets[(y * gridIndex.cols) + x];
            for (const idx of bucket) {
                const dx = points2d[idx * 2] - world.x;
                const dy = points2d[(idx * 2) + 1] - world.y;
                const dist = (dx * dx) + (dy * dy);
                if (dist < bestDist && dist <= thresholdSq) {
                    best = idx;
                    bestDist = dist;
                }
            }
        }
    }

    return best;
}

function clampCamera() {
    const minX = camera.initialX - (camera.initialW * 0.5);
    const maxX = camera.initialX + camera.initialW;
    const minY = camera.initialY - (camera.initialH * 0.5);
    const maxY = camera.initialY + camera.initialH;

    if (camera.x < minX) camera.x = minX;
    if (camera.y < minY) camera.y = minY;
    if (camera.x + camera.w > maxX) camera.x = maxX - camera.w;
    if (camera.y + camera.h > maxY) camera.y = maxY - camera.h;
}

function screenToWorld(px, py) {
    const x = camera.x + ((px / Math.max(1, canvasWidth)) * camera.w);
    const y = camera.y + ((py / Math.max(1, canvasHeight)) * camera.h);
    return { x, y };
}

function worldToScreen(x, y) {
    const px = ((x - camera.x) / camera.w) * canvasWidth;
    const py = ((y - camera.y) / camera.h) * canvasHeight;
    return { x: px, y: py };
}

function queueRender() {
    if (!mounted || renderPending) return;
    renderPending = true;
    rafId = requestAnimationFrame(() => {
        renderPending = false;
        render();
    });
}

function render() {
    if (!canvas) return;

    if (gl && glProgram) {
        renderWebGL();
    } else if (fallbackCtx) {
        renderFallback2D();
    }

    renderOverlayHud();
}

function getEffectiveLodMode() {
    const settings = getEmbeddingSettings();
    const mode = settings.mapLodMode || 'auto';
    if (mode !== 'auto') return mode;

    const points = getPointCount();
    const zoomRatio = camera.w / Math.max(1e-6, camera.initialW);
    if (points >= AUTO_DENSITY_POINT_THRESHOLD && zoomRatio >= AUTO_DENSITY_ZOOM_THRESHOLD) {
        return 'density';
    }
    return 'points';
}

function renderWebGL() {
    const n = getPointCount();
    if (n === 0 || !gl) return;

    gl.clearColor(0.06, 0.07, 0.09, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(glProgram);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniform4f(glUniforms.view, camera.x, camera.y, camera.w, camera.h);

    const mode = getEffectiveLodMode();
    const useDensity = mode === 'density' && sampledPositions.length > 0;

    const posBuffer = useDensity ? glState.sampledPosBuffer : glState.posBuffer;
    const colorBuffer = useDensity ? glState.sampledColorBuffer : glState.colorBuffer;
    const sizeBuffer = useDensity ? glState.sampledSizeBuffer : glState.sizeBuffer;
    const count = useDensity ? Math.floor(sampledPositions.length / 2) : n;

    bindPointBuffer(glAttribs.pos, posBuffer, 2);
    bindPointBuffer(glAttribs.color, colorBuffer, 4);
    bindPointBuffer(glAttribs.size, sizeBuffer, 1);

    gl.drawArrays(gl.POINTS, 0, count);

    if (hoveredPointIndex >= 0) {
        drawSelectionRing(hoveredPointIndex, [1.0, 0.85, 0.3, 0.95], 9.5);
    }

    if (selectedPointIndices.size > 0) {
        for (const idx of selectedPointIndices) {
            drawSelectionRing(idx, [1.0, 1.0, 1.0, 0.98], 10.5);
        }
    }
}

function renderFallback2D() {
    if (!fallbackCtx) return;

    fallbackCtx.clearRect(0, 0, canvasWidth, canvasHeight);
    fallbackCtx.fillStyle = 'rgba(14, 16, 20, 1)';
    fallbackCtx.fillRect(0, 0, canvasWidth, canvasHeight);

    const n = getPointCount();
    const mode = getEffectiveLodMode();
    const useDensity = mode === 'density' && sampledPositions.length > 0;

    const positions = useDensity ? sampledPositions : points2d;
    const colors = useDensity ? sampledColors : fullRenderColors;
    const sizes = useDensity ? sampledSizes : fullRenderSizes;

    const count = Math.floor(positions.length / 2);
    for (let i = 0; i < count; i++) {
        const x = positions[i * 2];
        const y = positions[(i * 2) + 1];
        const screen = worldToScreen(x, y);
        if (screen.x < -20 || screen.x > canvasWidth + 20 || screen.y < -20 || screen.y > canvasHeight + 20) continue;

        const r = Math.round(colors[i * 4] * 255);
        const g = Math.round(colors[(i * 4) + 1] * 255);
        const b = Math.round(colors[(i * 4) + 2] * 255);
        const a = colors[(i * 4) + 3];
        fallbackCtx.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;

        const size = sizes[i] || 2;
        fallbackCtx.beginPath();
        fallbackCtx.arc(screen.x, screen.y, Math.max(1, size * 0.5), 0, Math.PI * 2);
        fallbackCtx.fill();
    }

    if (hoveredPointIndex >= 0) {
        drawFallbackRing(hoveredPointIndex, 'rgba(255,220,80,0.95)', 9);
    }
    for (const idx of selectedPointIndices) {
        drawFallbackRing(idx, 'rgba(255,255,255,0.95)', 11);
    }
}

function renderOverlayHud() {
    if (!canvas || !container) return;

    // Brush rectangle
    if (interaction.mode === 'brush' && overlayEl) {
        const x = Math.min(interaction.brushX0, interaction.brushX1);
        const y = Math.min(interaction.brushY0, interaction.brushY1);
        const w = Math.abs(interaction.brushX1 - interaction.brushX0);
        const h = Math.abs(interaction.brushY1 - interaction.brushY0);

        let brush = overlayEl.querySelector('.chat-manager-semantic-map-brush');
        if (!brush) {
            brush = document.createElement('div');
            brush.className = 'chat-manager-semantic-map-brush';
            overlayEl.appendChild(brush);
        }
        brush.style.display = '';
        brush.style.left = `${x}px`;
        brush.style.top = `${y}px`;
        brush.style.width = `${w}px`;
        brush.style.height = `${h}px`;
    } else if (overlayEl) {
        const brush = overlayEl.querySelector('.chat-manager-semantic-map-brush');
        if (brush) brush.style.display = 'none';
    }

    // Hover tooltip-like info (bottom-right text)
    if (hoveredPointIndex >= 0 && selectedPointIndices.size <= 1) {
        setInfo(formatPointInfo(hoveredPointIndex));
    }
}

function formatPointInfo(idx) {
    const ref = messageRefs[idx];
    if (!ref) return `${getPointCount().toLocaleString()} points`;

    const snippet = truncate(ref.text || '', 84);
    const scorePart = (scoreValues && scoreValues.length > idx)
        ? ` · sim ${Math.round(scoreValues[idx] * 100)}%`
        : '';

    return `${ref.displayName} · #${ref.msgIndex}${scorePart} · ${snippet}`;
}

function drawFallbackRing(idx, color, size) {
    if (!fallbackCtx) return;
    const x = points2d[idx * 2];
    const y = points2d[(idx * 2) + 1];
    const screen = worldToScreen(x, y);

    fallbackCtx.strokeStyle = color;
    fallbackCtx.lineWidth = 1.5;
    fallbackCtx.beginPath();
    fallbackCtx.arc(screen.x, screen.y, size * 0.5, 0, Math.PI * 2);
    fallbackCtx.stroke();
}

function initGL() {
    if (!gl) return;

    const vertSrc = `
attribute vec2 a_pos;
attribute vec4 a_color;
attribute float a_size;
varying vec4 v_color;
uniform vec4 u_view;

void main() {
    float nx = ((a_pos.x - u_view.x) / max(u_view.z, 0.000001)) * 2.0 - 1.0;
    float ny = 1.0 - (((a_pos.y - u_view.y) / max(u_view.w, 0.000001)) * 2.0);
    gl_Position = vec4(nx, ny, 0.0, 1.0);
    gl_PointSize = a_size;
    v_color = a_color;
}
`;

    const fragSrc = `
precision mediump float;
varying vec4 v_color;

void main() {
    vec2 p = gl_PointCoord - vec2(0.5, 0.5);
    float d = dot(p, p);
    if (d > 0.25) discard;
    gl_FragColor = v_color;
}
`;

    const vert = compileShader(gl.VERTEX_SHADER, vertSrc);
    const frag = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    if (!vert || !frag) {
        fallbackCtx = canvas.getContext('2d');
        return;
    }

    glProgram = gl.createProgram();
    gl.attachShader(glProgram, vert);
    gl.attachShader(glProgram, frag);
    gl.linkProgram(glProgram);

    if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
        console.warn(`[${MODULE_NAME}] Semantic map shader link failed:`, gl.getProgramInfoLog(glProgram));
        gl.deleteProgram(glProgram);
        glProgram = null;
        fallbackCtx = canvas.getContext('2d');
        return;
    }

    glAttribs = {
        pos: gl.getAttribLocation(glProgram, 'a_pos'),
        color: gl.getAttribLocation(glProgram, 'a_color'),
        size: gl.getAttribLocation(glProgram, 'a_size'),
    };

    glUniforms = {
        view: gl.getUniformLocation(glProgram, 'u_view'),
    };

    glState.posBuffer = gl.createBuffer();
    glState.colorBuffer = gl.createBuffer();
    glState.sizeBuffer = gl.createBuffer();
    glState.sampledPosBuffer = gl.createBuffer();
    glState.sampledColorBuffer = gl.createBuffer();
    glState.sampledSizeBuffer = gl.createBuffer();
}

function destroyGLResources() {
    if (!gl) return;

    const buffers = [
        glState.posBuffer,
        glState.colorBuffer,
        glState.sizeBuffer,
        glState.sampledPosBuffer,
        glState.sampledColorBuffer,
        glState.sampledSizeBuffer,
    ];

    for (const buffer of buffers) {
        if (buffer) gl.deleteBuffer(buffer);
    }

    glState.posBuffer = null;
    glState.colorBuffer = null;
    glState.sizeBuffer = null;
    glState.sampledPosBuffer = null;
    glState.sampledColorBuffer = null;
    glState.sampledSizeBuffer = null;

    if (glProgram) {
        gl.deleteProgram(glProgram);
        glProgram = null;
    }
}

function uploadBuffersToGPU() {
    if (!gl || !glProgram) return;

    uploadBuffer(glState.posBuffer, points2d, gl.ARRAY_BUFFER);
    uploadBuffer(glState.colorBuffer, fullRenderColors, gl.ARRAY_BUFFER);
    uploadBuffer(glState.sizeBuffer, fullRenderSizes, gl.ARRAY_BUFFER);

    uploadBuffer(glState.sampledPosBuffer, sampledPositions, gl.ARRAY_BUFFER);
    uploadBuffer(glState.sampledColorBuffer, sampledColors, gl.ARRAY_BUFFER);
    uploadBuffer(glState.sampledSizeBuffer, sampledSizes, gl.ARRAY_BUFFER);
}

function uploadBuffer(buffer, data, target) {
    if (!gl || !buffer) return;
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data || new Float32Array(0), gl.DYNAMIC_DRAW);
}

function bindPointBuffer(attribLoc, buffer, size) {
    if (!gl || attribLoc < 0 || !buffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(attribLoc);
    gl.vertexAttribPointer(attribLoc, size, gl.FLOAT, false, 0, 0);
}

function drawSelectionRing(idx, colorRgba, size) {
    if (!gl || !glProgram || idx < 0 || idx >= getPointCount()) return;

    const x = points2d[idx * 2];
    const y = points2d[(idx * 2) + 1];

    const pos = new Float32Array([x, y]);
    const col = new Float32Array(colorRgba);
    const siz = new Float32Array([size]);

    const tempPos = gl.createBuffer();
    const tempCol = gl.createBuffer();
    const tempSize = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, tempPos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STREAM_DRAW);
    gl.vertexAttribPointer(glAttribs.pos, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(glAttribs.pos);

    gl.bindBuffer(gl.ARRAY_BUFFER, tempCol);
    gl.bufferData(gl.ARRAY_BUFFER, col, gl.STREAM_DRAW);
    gl.vertexAttribPointer(glAttribs.color, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(glAttribs.color);

    gl.bindBuffer(gl.ARRAY_BUFFER, tempSize);
    gl.bufferData(gl.ARRAY_BUFFER, siz, gl.STREAM_DRAW);
    gl.vertexAttribPointer(glAttribs.size, 1, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(glAttribs.size);

    gl.drawArrays(gl.POINTS, 0, 1);

    gl.deleteBuffer(tempPos);
    gl.deleteBuffer(tempCol);
    gl.deleteBuffer(tempSize);
}

function compileShader(type, source) {
    if (!gl) return null;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn(`[${MODULE_NAME}] Semantic map shader compile failed:`, gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function getPointCount() {
    return Math.floor(points2d.length / 2);
}

function makePointKey(fileName, msgIndex) {
    return `${fileName}::${msgIndex}`;
}

function truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen - 1) + '…';
}

function clamp01(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex) {
    if (typeof hex !== 'string') return [160, 160, 160];
    const clean = hex.trim().replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [160, 160, 160];
    return [
        parseInt(clean.slice(0, 2), 16),
        parseInt(clean.slice(2, 4), 16),
        parseInt(clean.slice(4, 6), 16),
    ];
}
