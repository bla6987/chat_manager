/**
 * Icicle View — Canvas-based icicle chart with interactions.
 *
 * Public API mirrors the old timeline-view contract:
 *   mountIcicle(container, mode) / unmountIcicle()
 *   updateIcicleData() / isIcicleMounted()
 *   setIcicleCallbacks({ onJump, getActive })
 *   focusMessageInIcicle(filename, msgIndex, options)
 *   expandToFullScreen() / closeFullScreen()
 */

import { buildIcicleData, reLayoutSubtree } from './icicle-data.js';
import { getIndex } from './chat-reader.js';
import { getDisplayName } from './metadata-store.js';

const MODULE_NAME = 'chat_manager';
const EXTENSION_PATH = '/scripts/extensions/third-party/chat_manager';

// ── Constants ──
const COL_WIDTH = 120;       // pixels per depth column
const GAP = 1;               // pixel gap between sibling blocks
const MIN_LABEL_HEIGHT = 14; // minimum block height to show a label
const MIN_BLOCK_HEIGHT = 2;  // minimum rendered block height
const ANIM_DURATION = 300;   // zoom animation ms
const MIN_VIEW_SPAN = 0.001; // prevents infinite zoom
const MAX_VIEW_SPAN = 1.0;   // full view
const ZOOM_FACTOR = 0.1;     // fraction of span per wheel tick
const DRAG_THRESHOLD = 4;    // pixels before drag activates
const TOUCH_SPEED = 1.8;    // multiplier for touch drag panning (>1 = faster)
const INERTIA_DECAY = 0.92; // velocity decay per frame during momentum scroll
const MIN_INERTIA_V = 0.5;  // stop inertia below this velocity (pixels)

// ── Module state ──
let canvas = null;
let ctx = null;
let container = null;
let currentMode = null;       // 'mini' | 'full'
let mounted = false;
let threadFocusActive = true;

// Data
let icicleRoot = null;
let flatNodes = [];
let maxDepth = 0;
let loadedCount = 0;

// Viewport (free navigation model)
let viewX = 0;               // horizontal offset in world pixels
let viewY0 = 0;              // visible top in [0,1] normalized Y space
let viewY1 = 1;              // visible bottom in [0,1]
let canvasWidth = 0;
let canvasHeight = 0;
let dpr = 1;

// Zoom stack for click-to-zoom (navigation bookmarks for breadcrumbs)
let zoomStack = [];
let zoomRoot = null;

// Explore state (subtree re-rooting)
let exploreRoot = null;       // node being explored (null = full view)
let exploreDepthOffset = 0;   // shifts x-rendering so explore root is at column 0

// Viewport animation
let viewAnimId = null;
let viewAnimFrom = null;     // { x, y0, y1 }
let viewAnimTo = null;       // { x, y0, y1 }
let viewAnimStart = 0;
let viewAnimOnComplete = null;

// Drag state
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartViewX = 0;
let dragStartViewY0 = 0;
let dragStartViewY1 = 0;
let wasDragging = false;

// Touch state
let activeTouches = new Map(); // trackingId → {x, y}
let pinchStartDist = 0;
let pinchStartSpan = 0;
let pinchMidY = 0;
let isPinching = false;
let touchTapCandidate = null; // {x, y, time} for tap detection
const TAP_THRESHOLD = 10;    // max movement to count as tap
const TAP_TIMEOUT = 300;     // max ms to count as tap

// Momentum / inertia state
let inertiaAnimId = null;
let inertiaVx = 0;           // horizontal velocity (pixels/frame)
let inertiaVy = 0;           // vertical velocity (normalized Y-space/frame)
let lastTouchX = 0;
let lastTouchY = 0;
let lastTouchTime = 0;

// Interaction state
let hoveredNode = null;
let resetBtnEl = null;
let focusBtnEl = null;
let jumpToCurrentBtnEl = null;
let tooltipEl = null;
let popupEl = null;
let breadcrumbEl = null;
let modalInjected = false;
let pendingFocusRequest = null;

// Search state
let searchBarEl = null;
let searchInputEl = null;
let searchPrevBtn = null;
let searchNextBtn = null;
let searchCounterEl = null;
let searchQuery = '';
let searchMatches = [];
let searchMatchSet = new Set();
let searchMatchIndex = -1;
let searchDebounceTimer = null;

// Callbacks
let onJumpToChat = null;
let getActiveChatFile = null;
let onThreadFocusChanged = null;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

export function setIcicleCallbacks(callbacks) {
    onJumpToChat = callbacks.onJump;
    getActiveChatFile = callbacks.getActive;
    onThreadFocusChanged = callbacks.onThreadFocusChanged || null;
}

export function setThreadFocus(active) {
    threadFocusActive = active;
}

export function isIcicleMounted() {
    return mounted;
}

/**
 * Focus a specific message node in the graph (thread + message index).
 * If not currently resolvable, stores a pending focus request and retries after mount/data refresh.
 *
 * @param {string} filename
 * @param {number} msgIndex
 * @param {{ openPopup?: boolean, persistIfMissing?: boolean }} options
 * @returns {boolean} true if focus was applied immediately
 */
export function focusMessageInIcicle(filename, msgIndex, options = {}) {
    if (!filename || !Number.isInteger(msgIndex) || msgIndex < 0) return false;

    pendingFocusRequest = {
        filename,
        msgIndex,
        openPopup: options.openPopup !== false,
        persistIfMissing: options.persistIfMissing !== false,
    };

    return tryApplyPendingFocus();
}

export function mountIcicle(containerEl, mode) {
    if (mounted) unmountIcicle();

    container = containerEl;
    currentMode = mode;
    container.innerHTML = '';
    container.style.position = 'relative';

    // Build data
    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatIndex = getIndex();
    const data = buildIcicleData(chatIndex, activeChatFile, { threadFocus: threadFocusActive });

    icicleRoot = data.root;
    flatNodes = data.flatNodes;
    maxDepth = data.maxDepth;
    loadedCount = data.loadedCount;
    viewX = 0;
    viewY0 = 0;
    viewY1 = 1;
    zoomStack = [];
    zoomRoot = null;
    exploreRoot = null;
    exploreDepthOffset = 0;
    isDragging = false;
    wasDragging = false;

    if (!icicleRoot || flatNodes.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No loaded chats to visualize.</div>';
        return;
    }

    // Create search bar (inserted first so it sits above canvas)
    createSearchBar();

    // Create canvas
    canvas = document.createElement('canvas');
    canvas.className = 'chat-manager-icicle-canvas';
    canvas.style.touchAction = 'none'; // prevent browser touch gestures on canvas
    container.appendChild(canvas);

    // Create breadcrumb bar
    breadcrumbEl = document.createElement('div');
    breadcrumbEl.className = 'chat-manager-icicle-breadcrumbs';
    container.appendChild(breadcrumbEl);

    // Create reset button
    resetBtnEl = document.createElement('button');
    resetBtnEl.className = 'chat-manager-btn chat-manager-icicle-reset-btn';
    resetBtnEl.textContent = 'Reset';
    resetBtnEl.style.display = 'none';
    resetBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        zoomToRoot();
    });
    container.appendChild(resetBtnEl);

    // Create focus toggle button
    focusBtnEl = document.createElement('button');
    focusBtnEl.className = 'chat-manager-btn chat-manager-icicle-focus-btn' + (threadFocusActive ? ' active' : '');
    focusBtnEl.title = threadFocusActive ? 'Showing current thread — click for all chats' : 'Showing all chats — click for current thread';
    focusBtnEl.innerHTML = '&#x1F500;';
    focusBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        threadFocusActive = !threadFocusActive;
        focusBtnEl.classList.toggle('active', threadFocusActive);
        focusBtnEl.title = threadFocusActive ? 'Showing current thread — click for all chats' : 'Showing all chats — click for current thread';
        if (onThreadFocusChanged) onThreadFocusChanged(threadFocusActive);
        updateIcicleData();
    });
    container.appendChild(focusBtnEl);

    // Create jump-to-current button
    jumpToCurrentBtnEl = document.createElement('button');
    jumpToCurrentBtnEl.className = 'chat-manager-btn chat-manager-icicle-jump-current-btn';
    jumpToCurrentBtnEl.title = 'Jump to current chat';
    jumpToCurrentBtnEl.innerHTML = '&#x1F4CD;';
    jumpToCurrentBtnEl.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToCurrentThread();
    });
    container.appendChild(jumpToCurrentBtnEl);

    // Create tooltip
    createTooltip();

    // Size and render
    resizeCanvas();
    scrollToActiveLeaf(activeChatFile);
    render();

    // Bind events
    bindEvents();

    // Expand button in mini mode
    if (mode === 'mini') {
        addExpandButton();
    }

    mounted = true;
    tryApplyPendingFocus();
}

export function unmountIcicle() {
    cancelViewportAnim();
    cancelInertia();
    unbindEvents();
    removeTooltip();
    removePopup();
    removeSearchBar();

    if (canvas) {
        canvas.remove();
        canvas = null;
        ctx = null;
    }
    if (breadcrumbEl) {
        breadcrumbEl.remove();
        breadcrumbEl = null;
    }
    if (resetBtnEl) {
        resetBtnEl.remove();
        resetBtnEl = null;
    }
    if (focusBtnEl) {
        focusBtnEl.remove();
        focusBtnEl = null;
    }
    if (jumpToCurrentBtnEl) {
        jumpToCurrentBtnEl.remove();
        jumpToCurrentBtnEl = null;
    }

    container = null;
    currentMode = null;
    icicleRoot = null;
    flatNodes = [];
    zoomStack = [];
    zoomRoot = null;
    exploreRoot = null;
    exploreDepthOffset = 0;
    viewX = 0;
    viewY0 = 0;
    viewY1 = 1;
    isDragging = false;
    wasDragging = false;
    hoveredNode = null;
    activeTouches = new Map();
    isPinching = false;
    touchTapCandidate = null;
    inertiaVx = 0;
    inertiaVy = 0;
    mounted = false;
}

export function updateIcicleData() {
    if (!mounted || !canvas) return;

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatIndex = getIndex();
    const data = buildIcicleData(chatIndex, activeChatFile, { threadFocus: threadFocusActive });

    icicleRoot = data.root;
    flatNodes = data.flatNodes;
    maxDepth = data.maxDepth;
    loadedCount = data.loadedCount;
    zoomStack = [];
    zoomRoot = null;
    exploreRoot = null;
    exploreDepthOffset = 0;
    viewX = 0;
    viewY0 = 0;
    viewY1 = 1;
    isDragging = false;
    wasDragging = false;
    cancelViewportAnim();

    if (!icicleRoot || flatNodes.length === 0) return;

    // Re-run search against new data if query is active
    if (searchQuery.length >= 2) {
        executeSearch(searchQuery);
    }

    scrollToActiveLeaf(activeChatFile);
    render();
    updateBreadcrumbs();
    updateResetButton();
    tryApplyPendingFocus();
}

export async function expandToFullScreen() {
    await ensureModalInjected();

    const modal = document.getElementById('chat-manager-timeline-modal');
    if (!modal) return;

    modal.classList.add('visible');

    const modalContainer = document.getElementById('chat-manager-timeline-modal-container');
    if (!modalContainer) return;

    // Destroy mini instance
    if (mounted) unmountIcicle();

    modalContainer.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building chart\u2026</div>';

    const closeBtn = document.getElementById('chat-manager-timeline-modal-close');
    if (closeBtn) closeBtn.onclick = closeFullScreen;

    modal.onclick = (e) => {
        if (e.target === modal) closeFullScreen();
    };

    modal._escHandler = (e) => {
        if (e.key === 'Escape') closeFullScreen();
    };
    document.addEventListener('keydown', modal._escHandler);

    requestAnimationFrame(() => {
        if (!modal.classList.contains('visible')) return;
        mountIcicle(modalContainer, 'full');
    });
}

export function closeFullScreen() {
    const modal = document.getElementById('chat-manager-timeline-modal');
    if (!modal) return;

    modal.classList.remove('visible');
    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
    }

    if (mounted) unmountIcicle();

    // Restore mini in panel
    const panelContainer = document.getElementById('chat-manager-content');
    if (panelContainer) {
        mountIcicle(panelContainer, 'mini');
    }
}

// ──────────────────────────────────────────────
//  Search
// ──────────────────────────────────────────────

function createSearchBar() {
    searchBarEl = document.createElement('div');
    searchBarEl.className = 'chat-manager-icicle-search-bar';

    searchInputEl = document.createElement('input');
    searchInputEl.className = 'chat-manager-search-input chat-manager-icicle-search-input';
    searchInputEl.type = 'text';
    searchInputEl.placeholder = 'Search messages\u2026';

    searchPrevBtn = document.createElement('button');
    searchPrevBtn.className = 'chat-manager-btn chat-manager-icicle-search-nav';
    searchPrevBtn.textContent = '\u25B2';
    searchPrevBtn.title = 'Previous match (Shift+Enter)';
    searchPrevBtn.disabled = true;

    searchNextBtn = document.createElement('button');
    searchNextBtn.className = 'chat-manager-btn chat-manager-icicle-search-nav';
    searchNextBtn.textContent = '\u25BC';
    searchNextBtn.title = 'Next match (Enter)';
    searchNextBtn.disabled = true;

    searchCounterEl = document.createElement('span');
    searchCounterEl.className = 'chat-manager-icicle-search-counter';

    searchBarEl.appendChild(searchInputEl);
    searchBarEl.appendChild(searchPrevBtn);
    searchBarEl.appendChild(searchNextBtn);
    searchBarEl.appendChild(searchCounterEl);

    // Insert as first child so it sits above the canvas
    container.insertBefore(searchBarEl, container.firstChild);

    // Events
    searchInputEl.addEventListener('input', () => {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => executeSearch(searchInputEl.value), 150);
    });

    searchInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            navigateMatch(e.shiftKey ? -1 : 1);
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            searchInputEl.value = '';
            executeSearch('');
            searchInputEl.blur();
        }
    });

    searchPrevBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateMatch(-1);
    });

    searchNextBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigateMatch(1);
    });
}

function executeSearch(raw) {
    const query = raw.toLowerCase().trim();
    searchQuery = query;

    if (query.length < 2) {
        searchMatches = [];
        searchMatchSet = new Set();
        searchMatchIndex = -1;
        updateSearchUI();
        render();
        return;
    }

    searchMatches = flatNodes.filter(n => n.normalizedText && n.normalizedText.toLowerCase().includes(query));

    // Sort by recency (newest messages first)
    searchMatches.sort((a, b) => {
        const aRaw = a.representative && a.representative.timestamp;
        const bRaw = b.representative && b.representative.timestamp;
        const aTime = aRaw ? new Date(aRaw).getTime() : 0;
        const bTime = bRaw ? new Date(bRaw).getTime() : 0;
        return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });

    searchMatchSet = new Set(searchMatches);

    if (searchMatches.length > 0) {
        searchMatchIndex = 0;
        panToMatch();
    } else {
        searchMatchIndex = -1;
    }

    updateSearchUI();
    render();
}

function navigateMatch(direction) {
    if (searchMatches.length === 0) return;

    searchMatchIndex += direction;
    if (searchMatchIndex >= searchMatches.length) searchMatchIndex = 0;
    if (searchMatchIndex < 0) searchMatchIndex = searchMatches.length - 1;

    panToMatch();
    updateSearchUI();
    render();
}

function panToMatch() {
    if (searchMatchIndex < 0 || searchMatchIndex >= searchMatches.length) return;

    const node = searchMatches[searchMatchIndex];
    const viewSpan = viewY1 - viewY0;

    // Center viewport on the node, preserving current zoom level
    const nodeMidY = (node.y0 + node.y1) / 2;
    let targetY0 = nodeMidY - viewSpan / 2;
    let targetY1 = nodeMidY + viewSpan / 2;

    // Clamp
    if (targetY0 < 0) { targetY0 = 0; targetY1 = viewSpan; }
    if (targetY1 > 1) { targetY1 = 1; targetY0 = 1 - viewSpan; }

    const targetX = Math.max(0, (node.depth - exploreDepthOffset) * COL_WIDTH - canvasWidth / 2 + COL_WIDTH / 2);

    animateViewportTo(targetX, targetY0, targetY1);
}

function updateSearchUI() {
    if (!searchCounterEl || !searchPrevBtn || !searchNextBtn) return;

    const hasMatches = searchMatches.length > 0;
    searchPrevBtn.disabled = !hasMatches;
    searchNextBtn.disabled = !hasMatches;

    if (searchQuery.length < 2) {
        searchCounterEl.textContent = '';
    } else if (hasMatches) {
        searchCounterEl.textContent = `${searchMatchIndex + 1} of ${searchMatches.length}`;
    } else {
        searchCounterEl.textContent = '0 of 0';
    }
}

function removeSearchBar() {
    clearTimeout(searchDebounceTimer);
    if (searchBarEl) {
        searchBarEl.remove();
        searchBarEl = null;
    }
    searchInputEl = null;
    searchPrevBtn = null;
    searchNextBtn = null;
    searchCounterEl = null;
    searchQuery = '';
    searchMatches = [];
    searchMatchSet = new Set();
    searchMatchIndex = -1;
}

// ──────────────────────────────────────────────
//  Canvas Sizing
// ──────────────────────────────────────────────

function resizeCanvas() {
    if (!canvas || !container) return;

    dpr = window.devicePixelRatio || 1;
    canvasWidth = container.clientWidth;
    canvasHeight = container.clientHeight;

    // Reserve space for search bar and breadcrumbs
    const searchBarHeight = searchBarEl ? searchBarEl.offsetHeight : 0;
    const breadcrumbHeight = breadcrumbEl ? breadcrumbEl.offsetHeight : 0;
    canvasHeight = Math.max(canvasHeight - searchBarHeight - breadcrumbHeight, 100);

    canvas.style.width = canvasWidth + 'px';
    canvas.style.height = canvasHeight + 'px';
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);

    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
}

// ──────────────────────────────────────────────
//  Rendering
// ──────────────────────────────────────────────

function render() {
    if (!ctx) return;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;

    // Determine visible depth range from viewX (offset for explore mode)
    const minVisibleDepth = Math.floor(viewX / COL_WIDTH) + exploreDepthOffset;
    const maxVisibleDepth = Math.ceil((viewX + canvasWidth) / COL_WIDTH) + exploreDepthOffset;

    // Y range from viewport state
    const yStart = viewY0;
    const yEnd = viewY1;
    const ySpan = yEnd - yStart;
    if (ySpan <= 0) return;

    for (const node of flatNodes) {
        if (node.depth < minVisibleDepth || node.depth > maxVisibleDepth) continue;

        // Skip nodes outside viewport y range
        if (node.y1 <= yStart || node.y0 >= yEnd) continue;

        // Map node y range to pixel coordinates within viewport
        const relY0 = (Math.max(node.y0, yStart) - yStart) / ySpan;
        const relY1 = (Math.min(node.y1, yEnd) - yStart) / ySpan;

        const x = (node.depth - exploreDepthOffset) * COL_WIDTH - viewX;
        const y = relY0 * canvasHeight;
        const w = COL_WIDTH - 2;
        const h = Math.max((relY1 - relY0) * canvasHeight - GAP, MIN_BLOCK_HEIGHT);

        if (x + w < 0 || x > canvasWidth) continue;
        if (y + h < 0 || y > canvasHeight) continue;

        // Color
        const isActive = activeChatFile && node.chatFiles.includes(activeChatFile);
        const isDivergence = node.children.size > 1;
        const isHovered = node === hoveredNode;

        let fillColor;
        if (isHovered) {
            fillColor = isActive ? 'rgba(110, 195, 255, 0.85)' : 'rgba(180, 190, 210, 0.7)';
        } else if (isActive) {
            fillColor = node.role === 'user'
                ? 'rgba(90, 165, 240, 0.7)'
                : 'rgba(70, 145, 220, 0.6)';
        } else if (isDivergence) {
            fillColor = node.role === 'user'
                ? 'rgba(200, 170, 80, 0.6)'
                : 'rgba(180, 155, 75, 0.55)';
        } else {
            fillColor = node.role === 'user'
                ? 'rgba(180, 130, 100, 0.5)'
                : 'rgba(100, 130, 170, 0.5)';
        }

        ctx.fillStyle = fillColor;
        ctx.fillRect(x, y, w, h);

        // Active path stroke
        if (isActive && !isHovered) {
            ctx.strokeStyle = 'rgba(100, 180, 255, 0.8)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }

        // Search match highlight
        if (searchMatchSet.has(node)) {
            const isFocused = searchMatches[searchMatchIndex] === node;
            ctx.strokeStyle = isFocused ? 'rgba(255, 180, 50, 1.0)' : 'rgba(255, 180, 50, 0.7)';
            ctx.lineWidth = isFocused ? 3 : 1.5;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        }

        // Label
        if (h >= MIN_LABEL_HEIGHT && w > 20) {
            const vertical = h > w;
            const maxChars = vertical ? Math.floor(h / 6) : Math.floor(w / 6);
            const label = truncate(node.normalizedText, maxChars);
            if (label) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.font = '11px sans-serif';
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();

                if (vertical) {
                    ctx.textBaseline = 'middle';
                    ctx.translate(x + w / 2, y + h - 4);
                    ctx.rotate(-Math.PI / 2);
                    ctx.fillText(label, 0, 0);
                } else {
                    ctx.textBaseline = 'middle';
                    ctx.fillText(label, x + 4, y + h / 2);
                }

                ctx.restore();
            }
        }
    }

    // Depth axis markers
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    for (let d = minVisibleDepth; d <= maxVisibleDepth; d++) {
        const x = (d - exploreDepthOffset) * COL_WIDTH - viewX;
        if (x >= 0 && x < canvasWidth) {
            ctx.fillText(`${d - exploreDepthOffset}`, x + 3, 3);
        }
    }

    updateResetButton();
}

// ── Viewport Animation ──

function animateViewportTo(targetX, targetY0, targetY1, onComplete = null) {
    cancelViewportAnim();
    viewAnimFrom = { x: viewX, y0: viewY0, y1: viewY1 };
    viewAnimTo = { x: targetX, y0: targetY0, y1: targetY1 };
    viewAnimStart = performance.now();
    viewAnimOnComplete = onComplete;
    viewAnimId = requestAnimationFrame(viewAnimFrame);
}

function viewAnimFrame(timestamp) {
    if (!viewAnimFrom || !viewAnimTo) return;

    const elapsed = timestamp - viewAnimStart;
    const t = Math.min(elapsed / ANIM_DURATION, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    if (t >= 1) {
        // Snap to exact targets to avoid IEEE 754 imprecision
        viewX = viewAnimTo.x;
        viewY0 = viewAnimTo.y0;
        viewY1 = viewAnimTo.y1;
        viewAnimId = null;
        viewAnimFrom = null;
        viewAnimTo = null;
        const complete = viewAnimOnComplete;
        viewAnimOnComplete = null;
        if (typeof complete === 'function') {
            complete();
        }
    } else {
        viewX = viewAnimFrom.x + (viewAnimTo.x - viewAnimFrom.x) * ease;
        viewY0 = viewAnimFrom.y0 + (viewAnimTo.y0 - viewAnimFrom.y0) * ease;
        viewY1 = viewAnimFrom.y1 + (viewAnimTo.y1 - viewAnimFrom.y1) * ease;
    }

    render();

    if (t < 1) {
        viewAnimId = requestAnimationFrame(viewAnimFrame);
    }
}

function cancelViewportAnim() {
    if (viewAnimId) {
        cancelAnimationFrame(viewAnimId);
        viewAnimId = null;
    }
    viewAnimFrom = null;
    viewAnimTo = null;
    viewAnimOnComplete = null;
}

// ──────────────────────────────────────────────
//  Hit Testing
// ──────────────────────────────────────────────

function hitTest(px, py) {
    const yStart = viewY0;
    const yEnd = viewY1;
    const ySpan = yEnd - yStart;
    if (ySpan <= 0) return null;

    // Determine depth column (offset for explore mode)
    const depth = Math.floor((px + viewX) / COL_WIDTH) + exploreDepthOffset;

    // Collect candidates at this depth
    for (const node of flatNodes) {
        if (node.depth !== depth) continue;

        if (node.y1 <= yStart || node.y0 >= yEnd) continue;

        const relY0 = (Math.max(node.y0, yStart) - yStart) / ySpan;
        const relY1 = (Math.min(node.y1, yEnd) - yStart) / ySpan;

        const y = relY0 * canvasHeight;
        const h = Math.max((relY1 - relY0) * canvasHeight - GAP, MIN_BLOCK_HEIGHT);
        const x = (node.depth - exploreDepthOffset) * COL_WIDTH - viewX;
        const w = COL_WIDTH - 2;

        if (px >= x && px <= x + w && py >= y && py <= y + h) {
            return node;
        }
    }

    return null;
}

// ──────────────────────────────────────────────
//  Event Binding
// ──────────────────────────────────────────────

let boundHandlers = {};

function bindEvents() {
    if (!canvas) return;

    boundHandlers.onMouseMove = onMouseMove;
    boundHandlers.onMouseLeave = onMouseLeave;
    boundHandlers.onMouseDown = onMouseDown;
    boundHandlers.onMouseUp = onMouseUp;
    boundHandlers.onClick = onClick;
    boundHandlers.onWheel = onWheel;
    boundHandlers.onResize = onResize;
    boundHandlers.onTouchStart = onTouchStart;
    boundHandlers.onTouchMove = onTouchMove;
    boundHandlers.onTouchEnd = onTouchEnd;

    canvas.addEventListener('mousemove', boundHandlers.onMouseMove);
    canvas.addEventListener('mouseleave', boundHandlers.onMouseLeave);
    canvas.addEventListener('mousedown', boundHandlers.onMouseDown);
    canvas.addEventListener('click', boundHandlers.onClick);
    canvas.addEventListener('wheel', boundHandlers.onWheel, { passive: false });
    canvas.addEventListener('touchstart', boundHandlers.onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', boundHandlers.onTouchMove, { passive: false });
    canvas.addEventListener('touchend', boundHandlers.onTouchEnd, { passive: false });
    window.addEventListener('mouseup', boundHandlers.onMouseUp);
    window.addEventListener('resize', boundHandlers.onResize);
}

function unbindEvents() {
    if (canvas) {
        canvas.removeEventListener('mousemove', boundHandlers.onMouseMove);
        canvas.removeEventListener('mouseleave', boundHandlers.onMouseLeave);
        canvas.removeEventListener('mousedown', boundHandlers.onMouseDown);
        canvas.removeEventListener('click', boundHandlers.onClick);
        canvas.removeEventListener('wheel', boundHandlers.onWheel);
        canvas.removeEventListener('touchstart', boundHandlers.onTouchStart);
        canvas.removeEventListener('touchmove', boundHandlers.onTouchMove);
        canvas.removeEventListener('touchend', boundHandlers.onTouchEnd);
    }
    window.removeEventListener('mouseup', boundHandlers.onMouseUp);
    window.removeEventListener('resize', boundHandlers.onResize);
    boundHandlers = {};
}

function onMouseDown(e) {
    if (e.button !== 0) return; // left button only
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragStartViewX = viewX;
    dragStartViewY0 = viewY0;
    dragStartViewY1 = viewY1;
    isDragging = true;
    wasDragging = false;
    cancelViewportAnim();
}

function onMouseUp() {
    isDragging = false;
    if (canvas) {
        // Restore cursor based on hover
        canvas.style.cursor = hoveredNode ? 'pointer' : 'grab';
    }
}

function onMouseMove(e) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (isDragging) {
        const dx = e.clientX - dragStartX;
        const dy = e.clientY - dragStartY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > DRAG_THRESHOLD) {
            wasDragging = true;
            hideTooltip();

            // Pan horizontally: pixel movement maps 1:1
            viewX = dragStartViewX - dx;

            // Pan vertically: pixel movement maps to Y-space proportionally
            const viewSpan = dragStartViewY1 - dragStartViewY0;
            const yShift = -(dy / canvasHeight) * viewSpan;
            viewY0 = dragStartViewY0 + yShift;
            viewY1 = dragStartViewY1 + yShift;

            clampViewport();
            render();
            canvas.style.cursor = 'grabbing';
        }
        return;
    }

    // Normal hover behavior
    const node = hitTest(px, py);

    if (node !== hoveredNode) {
        hoveredNode = node;
        render();

        if (node) {
            showTooltip(e.clientX, e.clientY, node);
            canvas.style.cursor = 'pointer';
        } else {
            hideTooltip();
            canvas.style.cursor = 'grab';
        }
    } else if (node && tooltipEl) {
        // Update tooltip position
        tooltipEl.style.left = (e.clientX + 15) + 'px';
        tooltipEl.style.top = (e.clientY - 10) + 'px';
    }
}

function onMouseLeave() {
    if (isDragging) return; // don't clear hover mid-drag
    if (hoveredNode) {
        hoveredNode = null;
        render();
    }
    hideTooltip();
    if (canvas) canvas.style.cursor = 'grab';
}

function onClick(e) {
    // Suppress click if we just finished dragging
    if (wasDragging) {
        wasDragging = false;
        return;
    }

    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const node = hitTest(px, py);
    if (!node) {
        removePopup();
        return;
    }

    // If node has children, zoom into it
    if (node.children.size > 0) {
        zoomTo(node);
    }

    // Show popup with chat list
    showNodePopup(e.clientX, e.clientY, node);
}

function onWheel(e) {
    e.preventDefault();
    cancelViewportAnim();

    if (e.ctrlKey || e.metaKey) {
        // ── Ctrl+wheel: zoom around cursor ──
        const rect = canvas.getBoundingClientRect();
        const py = e.clientY - rect.top;

        // Cursor position in normalized Y space
        const viewSpan = viewY1 - viewY0;
        const cursorY = viewY0 + (py / canvasHeight) * viewSpan;

        // Scale factor: scroll up = zoom in, scroll down = zoom out
        const delta = e.deltaY > 0 ? 1 : -1;
        const scale = 1 + delta * ZOOM_FACTOR;
        let newSpan = viewSpan * scale;
        newSpan = Math.max(MIN_VIEW_SPAN, Math.min(MAX_VIEW_SPAN, newSpan));

        // Keep cursor point fixed: adjust y0/y1 around cursorY
        const ratio = (cursorY - viewY0) / viewSpan;
        viewY0 = cursorY - ratio * newSpan;
        viewY1 = cursorY + (1 - ratio) * newSpan;

        // Free zoom clears zoom context and explore mode
        zoomStack = [];
        zoomRoot = null;
        if (exploreRoot) {
            exploreRoot = null;
            exploreDepthOffset = 0;
            // Rebuild full data in background, but keep current viewport
            const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
            const chatIndex = getIndex();
            const data = buildIcicleData(chatIndex, activeChatFile, { threadFocus: threadFocusActive });
            icicleRoot = data.root;
            flatNodes = data.flatNodes;
            maxDepth = data.maxDepth;
            loadedCount = data.loadedCount;
            if (searchQuery.length >= 2) executeSearch(searchQuery);
        }
        updateBreadcrumbs();

        clampViewport();
        render();
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        // ── Shift+wheel or horizontal trackpad: horizontal pan ──
        const delta = e.shiftKey ? e.deltaY : e.deltaX;
        viewX += delta;
        clampViewport();
        render();
    } else {
        // ── Plain wheel: vertical pan ──
        const viewSpan = viewY1 - viewY0;
        const yShift = (e.deltaY / canvasHeight) * viewSpan;
        viewY0 += yShift;
        viewY1 += yShift;
        clampViewport();
        render();
    }
}

// ── Touch Handlers ──

function getTouchDistance(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
}

function onTouchStart(e) {
    e.preventDefault();

    for (const touch of e.changedTouches) {
        activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }

    if (activeTouches.size === 1) {
        // Single finger: start drag (same as mousedown)
        const touch = e.changedTouches[0];
        dragStartX = touch.clientX;
        dragStartY = touch.clientY;
        dragStartViewX = viewX;
        dragStartViewY0 = viewY0;
        dragStartViewY1 = viewY1;
        isDragging = true;
        wasDragging = false;
        isPinching = false;
        cancelViewportAnim();
        cancelInertia();

        // Initialize velocity tracking
        lastTouchX = touch.clientX;
        lastTouchY = touch.clientY;
        lastTouchTime = performance.now();
        inertiaVx = 0;
        inertiaVy = 0;

        // Track for tap detection
        touchTapCandidate = { x: touch.clientX, y: touch.clientY, time: Date.now() };
    } else if (activeTouches.size === 2) {
        // Two fingers: start pinch-to-zoom
        isPinching = true;
        isDragging = false;
        touchTapCandidate = null;
        hideTooltip();

        const touches = Array.from(activeTouches.values());
        pinchStartDist = Math.sqrt(
            (touches[0].x - touches[1].x) ** 2 +
            (touches[0].y - touches[1].y) ** 2,
        );
        pinchStartSpan = viewY1 - viewY0;

        // Midpoint in canvas-relative Y for zoom anchor
        const rect = canvas.getBoundingClientRect();
        const ids = Array.from(activeTouches.keys());
        const t0 = findTouch(e.touches, ids[0]);
        const t1 = findTouch(e.touches, ids[1]);
        if (t0 && t1) {
            pinchMidY = ((t0.clientY + t1.clientY) / 2) - rect.top;
        }

        cancelViewportAnim();
    }
}

function onTouchMove(e) {
    e.preventDefault();

    // Update tracked positions
    for (const touch of e.changedTouches) {
        if (activeTouches.has(touch.identifier)) {
            activeTouches.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
        }
    }

    if (isPinching && activeTouches.size >= 2) {
        // Pinch-to-zoom
        const touches = Array.from(activeTouches.values());
        const dist = Math.sqrt(
            (touches[0].x - touches[1].x) ** 2 +
            (touches[0].y - touches[1].y) ** 2,
        );

        if (pinchStartDist > 0) {
            const scale = pinchStartDist / dist; // pinch out = smaller scale = zoom in
            let newSpan = pinchStartSpan * scale;
            newSpan = Math.max(MIN_VIEW_SPAN, Math.min(MAX_VIEW_SPAN, newSpan));

            // Zoom around the midpoint
            const cursorY = viewY0 + (pinchMidY / canvasHeight) * (viewY1 - viewY0);
            const ratio = pinchMidY / canvasHeight;
            viewY0 = cursorY - ratio * newSpan;
            viewY1 = cursorY + (1 - ratio) * newSpan;

            clampViewport();
            render();
        }
        return;
    }

    if (isDragging && activeTouches.size === 1) {
        const touch = e.changedTouches[0];
        const dx = touch.clientX - dragStartX;
        const dy = touch.clientY - dragStartY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > DRAG_THRESHOLD) {
            wasDragging = true;
            touchTapCandidate = null;
            hideTooltip();

            // Pan horizontally (amplified by touch speed multiplier)
            viewX = dragStartViewX - dx * TOUCH_SPEED;

            // Pan vertically (amplified by touch speed multiplier)
            const viewSpan = dragStartViewY1 - dragStartViewY0;
            const yShift = -(dy / canvasHeight) * viewSpan * TOUCH_SPEED;
            viewY0 = dragStartViewY0 + yShift;
            viewY1 = dragStartViewY1 + yShift;

            clampViewport();
            render();

            // Track velocity for momentum (use instantaneous movement)
            const now = performance.now();
            const dt = now - lastTouchTime;
            if (dt > 0) {
                const instantDx = touch.clientX - lastTouchX;
                const instantDy = touch.clientY - lastTouchY;
                // Blend with previous velocity to smooth out jitter
                inertiaVx = 0.4 * inertiaVx + 0.6 * (instantDx / dt * 16) * TOUCH_SPEED;
                inertiaVy = 0.4 * inertiaVy + 0.6 * (instantDy / dt * 16 / canvasHeight * viewSpan) * TOUCH_SPEED;
            }
            lastTouchX = touch.clientX;
            lastTouchY = touch.clientY;
            lastTouchTime = now;
        }
    }
}

function onTouchEnd(e) {
    e.preventDefault();

    for (const touch of e.changedTouches) {
        activeTouches.delete(touch.identifier);
    }

    if (activeTouches.size < 2) {
        isPinching = false;
    }

    if (activeTouches.size === 0) {
        isDragging = false;

        // Check for tap (single quick touch without much movement)
        if (touchTapCandidate && !wasDragging) {
            const elapsed = Date.now() - touchTapCandidate.time;
            if (elapsed < TAP_TIMEOUT) {
                const touch = e.changedTouches[0];
                const dx = touch.clientX - touchTapCandidate.x;
                const dy = touch.clientY - touchTapCandidate.y;
                if (Math.sqrt(dx * dx + dy * dy) < TAP_THRESHOLD) {
                    handleTouchTap(touch.clientX, touch.clientY);
                }
            }
        }

        // Start momentum scrolling if finger was still moving
        if (wasDragging && (Math.abs(inertiaVx) > MIN_INERTIA_V || Math.abs(inertiaVy) > 0.0001)) {
            const timeSinceLast = performance.now() - lastTouchTime;
            // Only apply inertia if the last move event was recent (finger was still moving)
            if (timeSinceLast < 100) {
                startInertia();
            }
        }

        touchTapCandidate = null;
        wasDragging = false;
    }
}

function handleTouchTap(clientX, clientY) {
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;

    const node = hitTest(px, py);
    if (!node) {
        removePopup();
        return;
    }

    // Zoom into node if it has children
    if (node.children.size > 0) {
        zoomTo(node);
    }

    // Show popup
    showNodePopup(clientX, clientY, node);
}

function findTouch(touchList, id) {
    for (let i = 0; i < touchList.length; i++) {
        if (touchList[i].identifier === id) return touchList[i];
    }
    return null;
}

// ── Touch Momentum / Inertia ──

function startInertia() {
    cancelInertia();
    inertiaAnimId = requestAnimationFrame(inertiaFrame);
}

function inertiaFrame() {
    // Decay velocity
    inertiaVx *= INERTIA_DECAY;
    inertiaVy *= INERTIA_DECAY;

    // Stop when velocity is negligible
    if (Math.abs(inertiaVx) < MIN_INERTIA_V && Math.abs(inertiaVy) < 0.0001) {
        cancelInertia();
        return;
    }

    // Apply velocity (negative because dragging left should scroll right)
    viewX -= inertiaVx;
    viewY0 -= inertiaVy;
    viewY1 -= inertiaVy;

    clampViewport();
    render();

    inertiaAnimId = requestAnimationFrame(inertiaFrame);
}

function cancelInertia() {
    if (inertiaAnimId) {
        cancelAnimationFrame(inertiaAnimId);
        inertiaAnimId = null;
    }
    inertiaVx = 0;
    inertiaVy = 0;
}

/**
 * Scroll viewport so the active chat's deepest node is visible on screen.
 */
function scrollToActiveLeaf(activeChatFile) {
    if (!activeChatFile || flatNodes.length === 0) return;

    let deepest = null;
    for (const node of flatNodes) {
        if (node.chatFiles.includes(activeChatFile)) {
            if (!deepest || node.depth > deepest.depth) {
                deepest = node;
            }
        }
    }
    if (!deepest) return;

    // Position so the leaf column's right edge aligns with the canvas right edge
    viewX = Math.max(0, ((deepest.depth - exploreDepthOffset) + 1) * COL_WIDTH - canvasWidth);
}

/**
 * Animated jump to the current active chat's deepest node.
 */
function jumpToCurrentThread() {
    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    if (!activeChatFile || flatNodes.length === 0) return;

    let deepest = null;
    for (const node of flatNodes) {
        if (node.chatFiles.includes(activeChatFile)) {
            if (!deepest || node.depth > deepest.depth) {
                deepest = node;
            }
        }
    }
    if (!deepest) return;

    // Compute target viewport: center on the leaf node vertically, scroll to its column horizontally
    const nodeSpan = deepest.y1 - deepest.y0;
    const viewSpan = viewY1 - viewY0;
    const nodeMidY = (deepest.y0 + deepest.y1) / 2;

    let targetY0, targetY1;
    if (nodeSpan >= viewSpan) {
        // Node is bigger than the view — zoom to fit the node
        targetY0 = deepest.y0;
        targetY1 = deepest.y1;
    } else {
        // Center the node in the current zoom level
        targetY0 = nodeMidY - viewSpan / 2;
        targetY1 = nodeMidY + viewSpan / 2;
        // Clamp to [0,1]
        if (targetY0 < 0) { targetY1 -= targetY0; targetY0 = 0; }
        if (targetY1 > 1) { targetY0 -= (targetY1 - 1); targetY1 = 1; }
    }

    const targetX = Math.max(0, ((deepest.depth - exploreDepthOffset) + 1) * COL_WIDTH - canvasWidth);
    animateViewportTo(targetX, targetY0, targetY1);
}

function clampViewport() {
    // Clamp horizontal (offset for explore mode)
    const maxScrollX = Math.max(0, (maxDepth - exploreDepthOffset + 1) * COL_WIDTH - canvasWidth);
    viewX = Math.max(0, Math.min(viewX, maxScrollX));

    // Clamp vertical: keep view within [0, 1]
    const span = viewY1 - viewY0;
    if (viewY0 < 0) {
        viewY0 = 0;
        viewY1 = span;
    }
    if (viewY1 > 1) {
        viewY1 = 1;
        viewY0 = 1 - span;
    }
    // Final safety clamp
    viewY0 = Math.max(0, viewY0);
    viewY1 = Math.min(1, viewY1);
}

function updateResetButton() {
    if (!resetBtnEl) return;
    const isDefault = viewX === 0 && viewY0 === 0 && viewY1 === 1;
    resetBtnEl.style.display = isDefault ? 'none' : 'block';
}

function onResize() {
    if (!mounted) return;
    resizeCanvas();
    render();
}

// ──────────────────────────────────────────────
//  Zoom
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
//  Explore Thread (subtree re-rooting)
// ──────────────────────────────────────────────

function exploreThread(node) {
    removePopup();

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const result = reLayoutSubtree(node, activeChatFile);

    exploreRoot = node;
    exploreDepthOffset = result.depthOffset;
    flatNodes = result.flatNodes;
    maxDepth = result.maxDepth;

    // Reset zoom and viewport
    zoomStack = [];
    zoomRoot = null;
    viewX = 0;
    viewY0 = 0;
    viewY1 = 1;
    cancelViewportAnim();

    // Re-run search if active
    if (searchQuery.length >= 2) {
        executeSearch(searchQuery);
    }

    updateBreadcrumbs();
    render();
}

function exitExplore() {
    exploreRoot = null;
    exploreDepthOffset = 0;
    updateIcicleData();
}

function zoomTo(node) {
    removePopup();

    // Push zoom stack
    if (zoomRoot) {
        zoomStack.push(zoomRoot);
    }
    zoomRoot = node;

    // Animate viewport to the node's range
    const targetX = Math.max(0, (node.depth - exploreDepthOffset) * COL_WIDTH - 20);
    animateViewportTo(targetX, node.y0, node.y1);

    updateBreadcrumbs();
}

function zoomOut() {
    removePopup();

    zoomRoot = zoomStack.length > 0 ? zoomStack.pop() : null;

    const targetY0 = zoomRoot ? zoomRoot.y0 : 0;
    const targetY1 = zoomRoot ? zoomRoot.y1 : 1;
    const targetX = zoomRoot ? Math.max(0, (zoomRoot.depth - exploreDepthOffset) * COL_WIDTH - 20) : 0;
    animateViewportTo(targetX, targetY0, targetY1);

    updateBreadcrumbs();
}

function zoomToRoot() {
    removePopup();

    zoomStack = [];
    zoomRoot = null;

    animateViewportTo(0, 0, 1);

    updateBreadcrumbs();
}

// ──────────────────────────────────────────────
//  Breadcrumbs
// ──────────────────────────────────────────────

function updateBreadcrumbs() {
    if (!breadcrumbEl) return;

    if (!exploreRoot && !zoomRoot) {
        breadcrumbEl.innerHTML = '';
        breadcrumbEl.style.display = 'none';
        // Resize canvas to reclaim breadcrumb space
        resizeCanvas();
        render();
        return;
    }

    breadcrumbEl.style.display = 'flex';

    let html = '';

    // Explore context
    if (exploreRoot) {
        html += '<span class="chat-manager-icicle-crumb chat-manager-icicle-crumb-explore-exit">\u2716 Exit</span>';
        const exploreLabel = truncate(exploreRoot.normalizedText || `msg #${exploreRoot.depth}`, 25);
        html += '<span class="chat-manager-icicle-crumb-explore-label">Exploring: ' + escapeHtml(exploreLabel) + '</span>';

        if (zoomRoot) {
            html += '<span class="chat-manager-icicle-crumb-sep">\u203A</span>';
        }
    }

    // Zoom breadcrumbs (shown even inside explore mode)
    if (zoomRoot) {
        html += '<span class="chat-manager-icicle-crumb chat-manager-icicle-crumb-root">Root</span>';

        const path = [...zoomStack, zoomRoot];
        for (let i = 0; i < path.length; i++) {
            const node = path[i];
            const label = truncate(node.normalizedText || `depth ${node.depth}`, 20);
            const isLast = i === path.length - 1;
            html += '<span class="chat-manager-icicle-crumb-sep">\u203A</span>';
            html += `<span class="chat-manager-icicle-crumb${isLast ? ' chat-manager-icicle-crumb-current' : ''}" data-idx="${i}">${escapeHtml(label)}</span>`;
        }
    }

    breadcrumbEl.innerHTML = html;

    // Bind explore exit
    breadcrumbEl.querySelector('.chat-manager-icicle-crumb-explore-exit')?.addEventListener('click', exitExplore);

    // Bind zoom root click
    breadcrumbEl.querySelector('.chat-manager-icicle-crumb-root')?.addEventListener('click', zoomToRoot);

    // Bind zoom crumb clicks
    breadcrumbEl.querySelectorAll('.chat-manager-icicle-crumb[data-idx]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            if (isNaN(idx)) return;
            const path = [...zoomStack, zoomRoot];
            const target = path[idx];
            zoomStack = path.slice(0, idx);
            zoomRoot = null;
            zoomTo(target);
        });
    });

    // Resize to account for breadcrumb height change
    resizeCanvas();
    render();
}

// ──────────────────────────────────────────────
//  Tooltip
// ──────────────────────────────────────────────

function createTooltip() {
    removeTooltip();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chat-manager-timeline-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);
}

function showTooltip(clientX, clientY, node) {
    if (!tooltipEl) return;

    const { moment } = SillyTavern.libs;
    const role = node.role === 'user' ? 'User' : 'Character';
    const time = node.representative.timestamp && moment
        ? moment(node.representative.timestamp).format('MMM D, h:mm A')
        : '';
    const rawText = node.representative.text || node.normalizedText || '';
    const preview = rawText.replace(/\s+/g, ' ').trim();
    const chatCount = node.chatFiles.length;
    const branchCount = node.children.size;
    const branchInfo = branchCount > 1
        ? `<div class="chat-manager-timeline-tooltip-branches">${branchCount} branches</div>`
        : '';

    tooltipEl.innerHTML =
        `<div class="chat-manager-timeline-tooltip-role">${role} — msg #${node.depth}</div>` +
        branchInfo +
        (time ? `<div class="chat-manager-timeline-tooltip-time">${time}</div>` : '') +
        `<div class="chat-manager-timeline-tooltip-preview">${escapeHtml(preview)}</div>` +
        `<div class="chat-manager-timeline-tooltip-count">${chatCount} chat${chatCount !== 1 ? 's' : ''}</div>`;

    tooltipEl.style.display = 'block';
    tooltipEl.style.left = (clientX + 15) + 'px';
    tooltipEl.style.top = (clientY - 10) + 'px';

    // Keep on screen
    requestAnimationFrame(() => {
        if (!tooltipEl) return;
        const tipRect = tooltipEl.getBoundingClientRect();
        if (tipRect.right > window.innerWidth) {
            tooltipEl.style.left = (clientX - tipRect.width - 15) + 'px';
        }
        if (tipRect.bottom > window.innerHeight) {
            tooltipEl.style.top = (clientY - tipRect.height) + 'px';
        }
    });
}

function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
}

function removeTooltip() {
    if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
    }
}

// ──────────────────────────────────────────────
//  Popup (click navigation)
// ──────────────────────────────────────────────

function findNodeForTarget(filename, msgIndex) {
    for (const node of flatNodes) {
        if (node.depth !== msgIndex) continue;
        if (!node.chatFiles.includes(filename)) continue;
        return node;
    }
    return null;
}

function focusNode(node, openPopup) {
    zoomStack = [];
    zoomRoot = node;
    updateBreadcrumbs();

    const targetX = Math.max(0, (node.depth - exploreDepthOffset) * COL_WIDTH - 20);
    if (openPopup) {
        animateViewportTo(targetX, node.y0, node.y1, () => {
            if (!mounted || !canvas) return;
            const rect = canvas.getBoundingClientRect();
            const ySpan = viewY1 - viewY0;
            if (ySpan <= 0) return;

            const relY0 = (node.y0 - viewY0) / ySpan;
            const relY1 = (node.y1 - viewY0) / ySpan;
            const centerX = Math.max(0, Math.min(canvasWidth - 1, ((node.depth - exploreDepthOffset) * COL_WIDTH - viewX) + (COL_WIDTH / 2)));
            const centerYNorm = (relY0 + relY1) / 2;
            const centerY = Math.max(0, Math.min(canvasHeight - 1, centerYNorm * canvasHeight));

            showNodePopup(rect.left + centerX, rect.top + centerY, node);
        });
    } else {
        animateViewportTo(targetX, node.y0, node.y1);
    }
}

function tryApplyPendingFocus() {
    if (!pendingFocusRequest) return false;
    if (!mounted || !canvas || flatNodes.length === 0) return false;

    const node = findNodeForTarget(pendingFocusRequest.filename, pendingFocusRequest.msgIndex);
    if (!node) {
        if (!pendingFocusRequest.persistIfMissing) {
            pendingFocusRequest = null;
        }
        return false;
    }

    const { openPopup } = pendingFocusRequest;
    pendingFocusRequest = null;
    focusNode(node, openPopup);
    return true;
}

function showNodePopup(clientX, clientY, node) {
    removePopup();
    hideTooltip();

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatFiles = node.chatFiles || [];
    if (chatFiles.length === 0) return;

    let html = '<div class="chat-manager-timeline-popup-inner">';
    html += `<div class="chat-manager-timeline-popup-title">Message #${node.depth}</div>`;
    html += `<div class="chat-manager-timeline-popup-preview">${escapeHtml(truncateForTooltip(node.representative.text || node.normalizedText, 120))}</div>`;

    // Explore Thread button — only when node has branches to explore
    if (node.children.size > 0) {
        html += '<button class="chat-manager-btn chat-manager-timeline-explore-btn">Explore Thread</button>';
    }

    html += '<div class="chat-manager-timeline-popup-list">';

    // Deduplicate chat files
    const uniqueFiles = [...new Set(chatFiles)];

    for (const file of uniqueFiles) {
        const displayName = getDisplayName(file) || file;
        const isCurrentChat = file === activeChatFile;
        const activeTag = isCurrentChat ? ' <span class="chat-manager-timeline-popup-active">(current)</span>' : '';
        const label = isCurrentChat ? 'Scroll' : 'Jump';

        html += '<div class="chat-manager-timeline-popup-entry">';
        html += `<span class="chat-manager-timeline-popup-name">${escapeHtml(displayName)}${activeTag}</span>`;
        html += `<button class="chat-manager-btn chat-manager-timeline-jump-btn" data-filename="${escapeAttr(file)}" data-msg-index="${node.depth}">${label}</button>`;
        html += '</div>';
    }

    html += '</div></div>';

    popupEl = document.createElement('div');
    popupEl.className = 'chat-manager-timeline-popup';
    popupEl.innerHTML = html;
    popupEl.style.left = (clientX + 10) + 'px';
    popupEl.style.top = (clientY + 10) + 'px';
    document.body.appendChild(popupEl);

    // Adjust if off-screen
    requestAnimationFrame(() => {
        if (!popupEl) return;
        const popRect = popupEl.getBoundingClientRect();
        if (popRect.right > window.innerWidth - 10) {
            popupEl.style.left = Math.max(10, clientX - popRect.width - 10) + 'px';
        }
        if (popRect.bottom > window.innerHeight - 10) {
            popupEl.style.top = Math.max(10, clientY - popRect.height - 10) + 'px';
        }
    });

    // Bind jump buttons
    popupEl.querySelectorAll('.chat-manager-timeline-jump-btn').forEach(btn => {
        btn.addEventListener('click', handleJump);
    });

    // Bind explore thread button
    const exploreBtn = popupEl.querySelector('.chat-manager-timeline-explore-btn');
    if (exploreBtn) {
        exploreBtn.addEventListener('click', () => exploreThread(node));
    }
}

function handleJump(e) {
    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;
    removePopup();
    if (onJumpToChat) {
        onJumpToChat(filename, msgIndex);
    }
}

function removePopup() {
    if (popupEl) {
        popupEl.remove();
        popupEl = null;
    }
}

// ──────────────────────────────────────────────
//  Expand Button (mini mode)
// ──────────────────────────────────────────────

function addExpandButton() {
    if (!container) return;
    const btn = document.createElement('button');
    btn.className = 'chat-manager-btn chat-manager-timeline-expand-btn';
    btn.title = 'Expand to full screen';
    btn.innerHTML = '&#x26F6;';
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandToFullScreen();
    });
    container.appendChild(btn);
}

// ──────────────────────────────────────────────
//  Modal
// ──────────────────────────────────────────────

async function ensureModalInjected() {
    if (modalInjected && document.getElementById('chat-manager-timeline-modal')) return;

    const context = SillyTavern.getContext();
    const response = await fetch(`${EXTENSION_PATH}/templates/timeline-modal.html`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to load timeline-modal.html`);
        return;
    }

    const html = await response.text();
    const { DOMPurify } = SillyTavern.libs;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = DOMPurify.sanitize(html);
    const root = wrapper.firstElementChild;
    if (root) {
        document.body.appendChild(root);
        modalInjected = true;
    }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

function truncate(text, max) {
    if (!text) return '';
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + '\u2026';
}

function truncateForTooltip(text, max) {
    if (!text) return '';
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= max) return clean;
    return clean.substring(0, max - 1) + '\u2026';
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    return escapeHtml(str);
}
