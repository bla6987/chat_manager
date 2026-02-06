/**
 * Icicle View — Canvas-based icicle chart with interactions.
 *
 * Public API mirrors the old timeline-view contract:
 *   mountIcicle(container, mode) / unmountIcicle()
 *   updateIcicleData() / isIcicleMounted()
 *   setIcicleCallbacks({ onJump, getActive })
 *   expandToFullScreen() / closeFullScreen()
 */

import { buildIcicleData } from './icicle-data.js';
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

// ── Module state ──
let canvas = null;
let ctx = null;
let container = null;
let currentMode = null;       // 'mini' | 'full'
let mounted = false;

// Data
let icicleRoot = null;
let flatNodes = [];
let maxDepth = 0;
let loadedCount = 0;

// Viewport
let scrollX = 0;             // horizontal scroll in pixels
let canvasWidth = 0;
let canvasHeight = 0;
let dpr = 1;

// Zoom stack for click-to-zoom
let zoomStack = [];           // stack of { node, prevY0, prevY1 }
let zoomRoot = null;          // current zoom root node (null = full view)

// Animation
let animationId = null;
let animStartTime = 0;
let animFrom = null;          // { y0Map, y1Map } snapshot before zoom
let animTo = null;            // { y0Map, y1Map } snapshot after zoom

// Interaction state
let hoveredNode = null;
let tooltipEl = null;
let popupEl = null;
let breadcrumbEl = null;
let modalInjected = false;

// Callbacks
let onJumpToChat = null;
let getActiveChatFile = null;

// ──────────────────────────────────────────────
//  Public API
// ──────────────────────────────────────────────

export function setIcicleCallbacks(callbacks) {
    onJumpToChat = callbacks.onJump;
    getActiveChatFile = callbacks.getActive;
}

export function isIcicleMounted() {
    return mounted;
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
    const data = buildIcicleData(chatIndex, activeChatFile);

    icicleRoot = data.root;
    flatNodes = data.flatNodes;
    maxDepth = data.maxDepth;
    loadedCount = data.loadedCount;
    scrollX = 0;
    zoomStack = [];
    zoomRoot = null;

    if (!icicleRoot || flatNodes.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No loaded chats to visualize.</div>';
        return;
    }

    // Create canvas
    canvas = document.createElement('canvas');
    canvas.className = 'chat-manager-icicle-canvas';
    container.appendChild(canvas);

    // Create breadcrumb bar
    breadcrumbEl = document.createElement('div');
    breadcrumbEl.className = 'chat-manager-icicle-breadcrumbs';
    container.appendChild(breadcrumbEl);

    // Create tooltip
    createTooltip();

    // Size and render
    resizeCanvas();
    render();

    // Bind events
    bindEvents();

    // Expand button in mini mode
    if (mode === 'mini') {
        addExpandButton();
    }

    mounted = true;
}

export function unmountIcicle() {
    if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
    }
    unbindEvents();
    removeTooltip();
    removePopup();

    if (canvas) {
        canvas.remove();
        canvas = null;
        ctx = null;
    }
    if (breadcrumbEl) {
        breadcrumbEl.remove();
        breadcrumbEl = null;
    }

    container = null;
    currentMode = null;
    icicleRoot = null;
    flatNodes = [];
    zoomStack = [];
    zoomRoot = null;
    hoveredNode = null;
    mounted = false;
}

export function updateIcicleData() {
    if (!mounted || !canvas) return;

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatIndex = getIndex();
    const data = buildIcicleData(chatIndex, activeChatFile);

    icicleRoot = data.root;
    flatNodes = data.flatNodes;
    maxDepth = data.maxDepth;
    loadedCount = data.loadedCount;
    zoomStack = [];
    zoomRoot = null;

    if (!icicleRoot || flatNodes.length === 0) return;

    render();
    updateBreadcrumbs();
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
//  Canvas Sizing
// ──────────────────────────────────────────────

function resizeCanvas() {
    if (!canvas || !container) return;

    dpr = window.devicePixelRatio || 1;
    canvasWidth = container.clientWidth;
    canvasHeight = container.clientHeight;

    // Reserve space for breadcrumbs
    const breadcrumbHeight = breadcrumbEl ? breadcrumbEl.offsetHeight : 0;
    canvasHeight = Math.max(canvasHeight - breadcrumbHeight, 100);

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

    // Determine visible depth range from scrollX
    const minVisibleDepth = Math.floor(scrollX / COL_WIDTH);
    const maxVisibleDepth = Math.ceil((scrollX + canvasWidth) / COL_WIDTH);

    // Determine y range from zoom
    const yStart = zoomRoot ? zoomRoot.y0 : 0;
    const yEnd = zoomRoot ? zoomRoot.y1 : 1;
    const ySpan = yEnd - yStart;

    for (const node of flatNodes) {
        if (node.depth < minVisibleDepth || node.depth > maxVisibleDepth) continue;

        // Skip nodes outside zoomed y range
        if (node.y1 <= yStart || node.y0 >= yEnd) continue;

        // Map node y range to pixel coordinates within zoomed view
        const relY0 = (Math.max(node.y0, yStart) - yStart) / ySpan;
        const relY1 = (Math.min(node.y1, yEnd) - yStart) / ySpan;

        const x = node.depth * COL_WIDTH - scrollX;
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

        // Label
        if (h >= MIN_LABEL_HEIGHT && w > 20) {
            const label = truncate(node.normalizedText, Math.floor(w / 6));
            if (label) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                ctx.font = '11px sans-serif';
                ctx.textBaseline = 'middle';
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, w, h);
                ctx.clip();
                ctx.fillText(label, x + 4, y + h / 2);
                ctx.restore();
            }
        }
    }

    // Depth axis markers
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    for (let d = minVisibleDepth; d <= maxVisibleDepth; d++) {
        const x = d * COL_WIDTH - scrollX;
        if (x >= 0 && x < canvasWidth) {
            ctx.fillText(`${d}`, x + 3, 3);
        }
    }
}

function renderAnimationFrame(timestamp) {
    if (!animFrom || !animTo) return;

    const elapsed = timestamp - animStartTime;
    const t = Math.min(elapsed / ANIM_DURATION, 1);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // Interpolate y0/y1 for all nodes
    for (const node of flatNodes) {
        const fromY0 = animFrom.get(node);
        const toY0 = animTo.get(node);
        if (fromY0 !== undefined && toY0 !== undefined) {
            node.y0 = fromY0.y0 + (toY0.y0 - fromY0.y0) * ease;
            node.y1 = fromY0.y1 + (toY0.y1 - fromY0.y1) * ease;
        }
    }

    render();

    if (t < 1) {
        animationId = requestAnimationFrame(renderAnimationFrame);
    } else {
        animationId = null;
        animFrom = null;
        animTo = null;
    }
}

// ──────────────────────────────────────────────
//  Hit Testing
// ──────────────────────────────────────────────

function hitTest(px, py) {
    const yStart = zoomRoot ? zoomRoot.y0 : 0;
    const yEnd = zoomRoot ? zoomRoot.y1 : 1;
    const ySpan = yEnd - yStart;

    // Determine depth column
    const depth = Math.floor((px + scrollX) / COL_WIDTH);

    // Collect candidates at this depth
    for (const node of flatNodes) {
        if (node.depth !== depth) continue;

        if (node.y1 <= yStart || node.y0 >= yEnd) continue;

        const relY0 = (Math.max(node.y0, yStart) - yStart) / ySpan;
        const relY1 = (Math.min(node.y1, yEnd) - yStart) / ySpan;

        const y = relY0 * canvasHeight;
        const h = Math.max((relY1 - relY0) * canvasHeight - GAP, MIN_BLOCK_HEIGHT);
        const x = node.depth * COL_WIDTH - scrollX;
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
    boundHandlers.onClick = onClick;
    boundHandlers.onWheel = onWheel;
    boundHandlers.onResize = onResize;

    canvas.addEventListener('mousemove', boundHandlers.onMouseMove);
    canvas.addEventListener('mouseleave', boundHandlers.onMouseLeave);
    canvas.addEventListener('click', boundHandlers.onClick);
    canvas.addEventListener('wheel', boundHandlers.onWheel, { passive: false });
    window.addEventListener('resize', boundHandlers.onResize);
}

function unbindEvents() {
    if (canvas) {
        canvas.removeEventListener('mousemove', boundHandlers.onMouseMove);
        canvas.removeEventListener('mouseleave', boundHandlers.onMouseLeave);
        canvas.removeEventListener('click', boundHandlers.onClick);
        canvas.removeEventListener('wheel', boundHandlers.onWheel);
    }
    window.removeEventListener('resize', boundHandlers.onResize);
    boundHandlers = {};
}

function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const node = hitTest(px, py);

    if (node !== hoveredNode) {
        hoveredNode = node;
        render();

        if (node) {
            showTooltip(e.clientX, e.clientY, node);
            canvas.style.cursor = 'pointer';
        } else {
            hideTooltip();
            canvas.style.cursor = 'default';
        }
    } else if (node && tooltipEl) {
        // Update tooltip position
        tooltipEl.style.left = (e.clientX + 15) + 'px';
        tooltipEl.style.top = (e.clientY - 10) + 'px';
    }
}

function onMouseLeave() {
    if (hoveredNode) {
        hoveredNode = null;
        render();
    }
    hideTooltip();
    if (canvas) canvas.style.cursor = 'default';
}

function onClick(e) {
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

    const maxScroll = Math.max(0, (maxDepth + 1) * COL_WIDTH - canvasWidth);
    scrollX = Math.max(0, Math.min(scrollX + e.deltaX + e.deltaY, maxScroll));
    render();
}

function onResize() {
    if (!mounted) return;
    resizeCanvas();
    render();
}

// ──────────────────────────────────────────────
//  Zoom
// ──────────────────────────────────────────────

function zoomTo(node) {
    removePopup();

    // Save current y positions for animation
    const fromMap = new Map();
    for (const n of flatNodes) {
        fromMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    // Push zoom stack
    if (zoomRoot) {
        zoomStack.push(zoomRoot);
    }
    zoomRoot = node;

    // Scroll to show the zoomed node's depth
    scrollX = Math.max(0, node.depth * COL_WIDTH - 20);

    // Save target positions
    const toMap = new Map();
    for (const n of flatNodes) {
        toMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    // Animate
    animFrom = fromMap;
    animTo = toMap;
    animStartTime = performance.now();
    if (animationId) cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(renderAnimationFrame);

    updateBreadcrumbs();
}

function zoomOut() {
    removePopup();

    const fromMap = new Map();
    for (const n of flatNodes) {
        fromMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    zoomRoot = zoomStack.length > 0 ? zoomStack.pop() : null;

    const toMap = new Map();
    for (const n of flatNodes) {
        toMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    animFrom = fromMap;
    animTo = toMap;
    animStartTime = performance.now();
    if (animationId) cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(renderAnimationFrame);

    updateBreadcrumbs();
}

function zoomToRoot() {
    removePopup();

    const fromMap = new Map();
    for (const n of flatNodes) {
        fromMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    zoomStack = [];
    zoomRoot = null;

    const toMap = new Map();
    for (const n of flatNodes) {
        toMap.set(n, { y0: n.y0, y1: n.y1 });
    }

    animFrom = fromMap;
    animTo = toMap;
    animStartTime = performance.now();
    if (animationId) cancelAnimationFrame(animationId);
    animationId = requestAnimationFrame(renderAnimationFrame);

    scrollX = 0;
    updateBreadcrumbs();
}

// ──────────────────────────────────────────────
//  Breadcrumbs
// ──────────────────────────────────────────────

function updateBreadcrumbs() {
    if (!breadcrumbEl) return;

    if (!zoomRoot) {
        breadcrumbEl.innerHTML = '';
        breadcrumbEl.style.display = 'none';
        // Resize canvas to reclaim breadcrumb space
        resizeCanvas();
        render();
        return;
    }

    breadcrumbEl.style.display = 'flex';

    let html = '<span class="chat-manager-icicle-crumb chat-manager-icicle-crumb-root">Root</span>';

    // Build path from zoom stack + current
    const path = [...zoomStack, zoomRoot];
    for (let i = 0; i < path.length; i++) {
        const node = path[i];
        const label = truncate(node.normalizedText || `depth ${node.depth}`, 20);
        const isLast = i === path.length - 1;
        html += '<span class="chat-manager-icicle-crumb-sep">\u203A</span>';
        html += `<span class="chat-manager-icicle-crumb${isLast ? ' chat-manager-icicle-crumb-current' : ''}" data-idx="${i}">${escapeHtml(label)}</span>`;
    }

    breadcrumbEl.innerHTML = html;

    // Bind clicks
    breadcrumbEl.querySelector('.chat-manager-icicle-crumb-root')?.addEventListener('click', zoomToRoot);

    breadcrumbEl.querySelectorAll('.chat-manager-icicle-crumb[data-idx]').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            if (isNaN(idx)) return;
            // Zoom to this level: pop stack down to idx
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
    const preview = truncateForTooltip(node.representative.text || node.normalizedText, 100);
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

function showNodePopup(clientX, clientY, node) {
    removePopup();
    hideTooltip();

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatFiles = node.chatFiles || [];
    if (chatFiles.length === 0) return;

    let html = '<div class="chat-manager-timeline-popup-inner">';
    html += `<div class="chat-manager-timeline-popup-title">Message #${node.depth}</div>`;
    html += `<div class="chat-manager-timeline-popup-preview">${escapeHtml(truncateForTooltip(node.representative.text || node.normalizedText, 120))}</div>`;
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
