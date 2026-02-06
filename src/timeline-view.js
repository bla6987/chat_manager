/**
 * Timeline View — Cytoscape rendering, interactions, minimap + full-screen modes.
 * Only loaded/initialized when the user clicks the timeline toggle.
 */

import { buildTimelineData } from './timeline-data.js';
import { getIndex } from './chat-reader.js';
import { getDisplayName } from './metadata-store.js';

const MODULE_NAME = 'chat_manager';
const EXTENSION_PATH = '/scripts/extensions/third-party/chat_manager';

let cyInstance = null;
let currentMode = null; // 'mini' | 'full'
let nodeDetailsMap = null;
let tooltipEl = null;
let popupEl = null;
let modalInjected = false;

// Callbacks set by ui-controller
let onJumpToChat = null;
let getActiveChatFile = null;

/**
 * Set external callbacks for navigation.
 * @param {{ onJump: Function, getActive: Function }} callbacks
 */
export function setTimelineCallbacks(callbacks) {
    onJumpToChat = callbacks.onJump;
    getActiveChatFile = callbacks.getActive;
}

/**
 * Check if a Cytoscape timeline is currently mounted.
 */
export function isTimelineMounted() {
    return cyInstance !== null;
}

/**
 * Mount a Cytoscape timeline into the given container.
 * @param {HTMLElement} container - DOM element to render into
 * @param {'mini'|'full'} mode
 */
export function mountTimeline(container, mode) {
    if (cyInstance) {
        unmountTimeline();
    }

    currentMode = mode;
    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatIndex = getIndex();
    const { elements, nodeDetails } = buildTimelineData(chatIndex, activeChatFile, mode);

    nodeDetailsMap = nodeDetails;

    if (elements.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No loaded chats to visualize.</div>';
        return;
    }

    // Ensure container has proper sizing for Cytoscape
    container.innerHTML = '';
    container.style.position = 'relative';

    const cyContainer = document.createElement('div');
    cyContainer.className = 'chat-manager-cy-container';
    container.appendChild(cyContainer);

    cyInstance = cytoscape({
        container: cyContainer,
        elements,
        style: getCytoscapeStyle(mode),
        layout: getLayoutConfig(mode),
        minZoom: 0.1,
        maxZoom: 3.0,
        wheelSensitivity: 0.3,
        boxSelectionEnabled: false,
        autounselectify: true,
    });

    // Create tooltip element
    createTooltip();

    // Bind interactions
    bindCytoscapeEvents();

    // Add expand button in mini mode
    if (mode === 'mini') {
        addExpandButton(container);
    }
}

/**
 * Unmount the Cytoscape instance and clean up.
 */
export function unmountTimeline() {
    if (cyInstance) {
        cyInstance.destroy();
        cyInstance = null;
    }
    currentMode = null;
    nodeDetailsMap = null;
    removeTooltip();
    removePopup();
}

/**
 * Update timeline with fresh data (e.g., after hydration).
 */
export function updateTimelineData() {
    if (!cyInstance) return;

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;
    const chatIndex = getIndex();
    const { elements, nodeDetails } = buildTimelineData(chatIndex, activeChatFile, currentMode);

    nodeDetailsMap = nodeDetails;

    if (elements.length === 0) return;

    cyInstance.elements().remove();
    cyInstance.add(elements);
    cyInstance.layout(getLayoutConfig(currentMode)).run();
}

/**
 * Open the full-screen modal timeline.
 */
export async function expandToFullScreen() {
    await ensureModalInjected();

    const modal = document.getElementById('chat-manager-timeline-modal');
    if (!modal) return;

    modal.classList.add('visible');

    const container = document.getElementById('chat-manager-timeline-modal-container');
    if (!container) return;

    // Destroy the mini instance so we don't have two
    if (cyInstance) {
        cyInstance.destroy();
        cyInstance = null;
    }

    // Show loading state, then defer mount to next frame
    container.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building graph\u2026</div>';

    // Bind modal close
    const closeBtn = document.getElementById('chat-manager-timeline-modal-close');
    if (closeBtn) {
        closeBtn.onclick = closeFullScreen;
    }

    // Close on backdrop click
    modal.onclick = (e) => {
        if (e.target === modal) closeFullScreen();
    };

    // Close on Escape
    modal._escHandler = (e) => {
        if (e.key === 'Escape') closeFullScreen();
    };
    document.addEventListener('keydown', modal._escHandler);

    requestAnimationFrame(() => {
        if (!modal.classList.contains('visible')) return;
        mountTimeline(container, 'full');
    });
}

/**
 * Close the full-screen modal and restore minimap if panel is still open.
 */
export function closeFullScreen() {
    const modal = document.getElementById('chat-manager-timeline-modal');
    if (!modal) return;

    modal.classList.remove('visible');

    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
    }

    // Destroy full-screen instance
    if (cyInstance) {
        cyInstance.destroy();
        cyInstance = null;
    }

    // Restore minimap in panel content
    const panelContainer = document.getElementById('chat-manager-content');
    if (panelContainer) {
        mountTimeline(panelContainer, 'mini');
    }
}

// ──────────────────────────────────────────────
//  Cytoscape Configuration
// ──────────────────────────────────────────────

function getLayoutConfig(mode) {
    return {
        name: 'preset',
        fit: true,
        padding: mode === 'full' ? 30 : 15,
    };
}

function getCytoscapeStyle(mode) {
    const isFull = mode === 'full';
    const nodeSize = isFull ? 22 : 14;
    const fontSize = isFull ? 10 : 0; // No labels in mini mode
    const edgeWidth = isFull ? 1.5 : 1;
    const activeEdgeWidth = isFull ? 3.5 : 2.5;

    return [
        // ── Default node ──
        {
            selector: 'node',
            style: {
                'width': nodeSize,
                'height': nodeSize,
                'background-color': '#b0b8c8',
                'border-width': 1,
                'border-color': 'rgba(255,255,255,0.15)',
                'label': isFull ? 'data(label)' : '',
                'font-size': fontSize,
                'color': '#ccc',
                'text-halign': 'right',
                'text-valign': 'center',
                'text-margin-x': 8,
                'text-max-width': 120,
                'text-wrap': 'ellipsis',
                'shape': isFull ? 'ellipse' : 'ellipse',
            },
        },
        // ── Root node ──
        {
            selector: 'node[?isRoot]',
            style: {
                'background-color': '#6a8caf',
                'border-width': 2,
                'border-color': 'rgba(100,180,255,0.5)',
                'width': nodeSize + 4,
                'height': nodeSize + 4,
                'label': isFull ? 'data(label)' : '',
            },
        },
        // ── User message node ──
        {
            selector: 'node[?isUser]',
            style: {
                'background-color': '#7badd8',
            },
        },
        // ── Character/assistant node ──
        {
            selector: 'node[role = "assistant"]',
            style: {
                'background-color': '#c8ccd4',
            },
        },
        // ── Active path node ──
        {
            selector: 'node[?isActive]',
            style: {
                'background-color': '#5ba3e6',
                'border-width': 2,
                'border-color': 'rgba(100,180,255,0.7)',
            },
        },
        // ── Multi-chat node (shared across branches) ──
        {
            selector: 'node[sharedCount > 1]',
            style: {
                'border-width': 2,
            },
        },
        // ── Default edge ──
        {
            selector: 'edge',
            style: {
                'width': edgeWidth,
                'line-color': 'rgba(180,180,200,0.3)',
                'target-arrow-color': 'rgba(180,180,200,0.3)',
                'target-arrow-shape': 'triangle',
                'arrow-scale': isFull ? 0.6 : 0.4,
                'curve-style': 'taxi',
                'taxi-direction': isFull ? 'rightward' : 'downward',
            },
        },
        // ── Active path edge ──
        {
            selector: 'edge[?isActive]',
            style: {
                'width': activeEdgeWidth,
                'line-color': 'rgba(100,180,255,0.6)',
                'target-arrow-color': 'rgba(100,180,255,0.6)',
            },
        },
    ];
}

// ──────────────────────────────────────────────
//  Interactions
// ──────────────────────────────────────────────

function bindCytoscapeEvents() {
    if (!cyInstance) return;

    // Hover → tooltip
    cyInstance.on('mouseover', 'node', onNodeMouseOver);
    cyInstance.on('mouseout', 'node', onNodeMouseOut);

    // Click → popup with navigation
    cyInstance.on('tap', 'node', onNodeTap);

    // Tap on background → dismiss popup
    cyInstance.on('tap', (e) => {
        if (e.target === cyInstance) {
            removePopup();
        }
    });

    // Double-click → auto-navigate to active or first chat
    cyInstance.on('dbltap', 'node', onNodeDoubleTap);
}

function onNodeMouseOver(e) {
    const node = e.target;
    const data = node.data();
    const details = nodeDetailsMap ? nodeDetailsMap.get(data.id) : null;
    const { moment } = SillyTavern.libs;
    const role = data.isUser ? 'User' : 'Character';
    const time = details?.timestamp && moment
        ? moment(details.timestamp).format('MMM D, h:mm A')
        : '';
    const preview = truncateForTooltip(details?.msg || '', 100);
    const chatCount = details?.chatFiles ? details.chatFiles.length : 0;

    showTooltip(
        e.renderedPosition,
        `<div class="chat-manager-timeline-tooltip-role">${role} — msg #${data.msgIndex}</div>` +
        (time ? `<div class="chat-manager-timeline-tooltip-time">${time}</div>` : '') +
        `<div class="chat-manager-timeline-tooltip-preview">${escapeHtml(preview)}</div>` +
        `<div class="chat-manager-timeline-tooltip-count">${chatCount} chat${chatCount !== 1 ? 's' : ''}</div>`,
    );
}

function onNodeMouseOut() {
    hideTooltip();
}

function onNodeTap(e) {
    const node = e.target;
    const data = node.data();
    removePopup();

    const details = nodeDetailsMap ? nodeDetailsMap.get(data.id) : null;
    const chatFiles = details?.chatFiles || [];
    if (chatFiles.length === 0) return;

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;

    let html = '<div class="chat-manager-timeline-popup-inner">';
    html += `<div class="chat-manager-timeline-popup-title">Message #${data.msgIndex}</div>`;
    html += `<div class="chat-manager-timeline-popup-preview">${escapeHtml(truncateForTooltip(details?.msg || '', 120))}</div>`;
    html += '<div class="chat-manager-timeline-popup-list">';

    const chatLengths = details?.chatLengths || {};
    for (const file of chatFiles) {
        const displayName = getDisplayName(file) || file;
        const totalMsgs = chatLengths[file] || '?';
        const isCurrentChat = file === activeChatFile;
        const label = isCurrentChat ? 'Scroll' : 'Jump';
        const activeTag = isCurrentChat ? ' <span class="chat-manager-timeline-popup-active">(current)</span>' : '';

        html += `<div class="chat-manager-timeline-popup-entry">`;
        html += `<span class="chat-manager-timeline-popup-name">${escapeHtml(displayName)}${activeTag}</span>`;
        html += `<span class="chat-manager-timeline-popup-meta">${totalMsgs} msgs</span>`;
        html += `<button class="chat-manager-btn chat-manager-timeline-jump-btn" data-filename="${escapeAttr(file)}" data-msg-index="${data.msgIndex}">${label}</button>`;
        html += '</div>';
    }

    html += '</div></div>';

    showPopup(e.renderedPosition, html);

    // Bind jump buttons
    if (popupEl) {
        popupEl.querySelectorAll('.chat-manager-timeline-jump-btn').forEach(btn => {
            btn.addEventListener('click', handleTimelineJump);
        });
    }
}

function onNodeDoubleTap(e) {
    const data = e.target.data();
    const details = nodeDetailsMap ? nodeDetailsMap.get(data.id) : null;
    const chatFiles = details?.chatFiles || [];
    if (chatFiles.length === 0) return;

    const activeChatFile = getActiveChatFile ? getActiveChatFile() : null;

    // Prefer active chat, otherwise first
    const targetFile = chatFiles.includes(activeChatFile) ? activeChatFile : chatFiles[0];
    if (onJumpToChat) {
        onJumpToChat(targetFile, data.msgIndex);
    }
}

function handleTimelineJump(e) {
    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;
    removePopup();
    if (onJumpToChat) {
        onJumpToChat(filename, msgIndex);
    }
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

function showTooltip(position, html) {
    if (!tooltipEl) return;

    tooltipEl.innerHTML = html;
    tooltipEl.style.display = 'block';

    // Get the Cytoscape container's bounding rect to offset position
    const cyContainer = cyInstance?.container();
    if (!cyContainer) return;
    const rect = cyContainer.getBoundingClientRect();

    const x = rect.left + position.x + 15;
    const y = rect.top + position.y - 10;

    tooltipEl.style.left = x + 'px';
    tooltipEl.style.top = y + 'px';

    // Keep on screen
    requestAnimationFrame(() => {
        if (!tooltipEl) return;
        const tipRect = tooltipEl.getBoundingClientRect();
        if (tipRect.right > window.innerWidth) {
            tooltipEl.style.left = (x - tipRect.width - 30) + 'px';
        }
        if (tipRect.bottom > window.innerHeight) {
            tooltipEl.style.top = (y - tipRect.height) + 'px';
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

function showPopup(position, html) {
    removePopup();

    popupEl = document.createElement('div');
    popupEl.className = 'chat-manager-timeline-popup';
    popupEl.innerHTML = html;

    // Get the Cytoscape container rect
    const cyContainer = cyInstance?.container();
    if (!cyContainer) return;
    const rect = cyContainer.getBoundingClientRect();

    const x = rect.left + position.x + 10;
    const y = rect.top + position.y + 10;

    popupEl.style.left = x + 'px';
    popupEl.style.top = y + 'px';

    document.body.appendChild(popupEl);

    // Adjust if off-screen
    requestAnimationFrame(() => {
        if (!popupEl) return;
        const popRect = popupEl.getBoundingClientRect();
        if (popRect.right > window.innerWidth - 10) {
            popupEl.style.left = Math.max(10, x - popRect.width - 20) + 'px';
        }
        if (popRect.bottom > window.innerHeight - 10) {
            popupEl.style.top = Math.max(10, y - popRect.height - 20) + 'px';
        }
    });
}

function removePopup() {
    if (popupEl) {
        popupEl.remove();
        popupEl = null;
    }
}

// ──────────────────────────────────────────────
//  Expand Button
// ──────────────────────────────────────────────

function addExpandButton(container) {
    const btn = document.createElement('button');
    btn.className = 'chat-manager-btn chat-manager-timeline-expand-btn';
    btn.title = 'Expand to full screen';
    btn.innerHTML = '&#x26F6;'; // ⛶ expand icon
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        expandToFullScreen();
    });
    container.appendChild(btn);
}

// ──────────────────────────────────────────────
//  Modal Injection
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
