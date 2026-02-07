/**
 * Stats View — Render stats dashboard with summary grid and activity heatmap.
 * Follows icicle-view.js pattern: module state, mount/unmount lifecycle, canvas rendering.
 */

import { getIndex, getIndexVersion, getHydrationProgress, isHydrationComplete } from './chat-reader.js';
import { getDisplayName } from './metadata-store.js';
import { computeStats, computeHeatmapData } from './stats-engine.js';

// ── Constants ──

const CELL_SIZE = 13;
const CELL_GAP = 2;
const DAY_LABEL_WIDTH = 28;
const MONTH_LABEL_HEIGHT = 16;
const ROWS = 7; // Mon-Sun

const LEVEL_COLORS = [
    'rgba(255,255,255, 0.04)',
    'rgba(70,140,220, 0.25)',
    'rgba(70,140,220, 0.45)',
    'rgba(70,140,220, 0.65)',
    'rgba(70,140,220, 0.85)',
];

const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

// ── Module State ──

let mounted = false;
let containerEl = null;
let canvasEl = null;
let ctx = null;
let tooltipEl = null;
let callbacks = { onDayClick: null, getActive: null };

/** Cached layout data for hit-testing */
let cellLayout = []; // { x, y, w, h, dateKey, count, chatCount }

/**
 * Set callbacks for stats view interactions.
 * @param {{ onDayClick?: Function, getActive?: Function }} cbs
 */
export function setStatsCallbacks(cbs) {
    Object.assign(callbacks, cbs);
}

/**
 * Check if stats view is currently mounted.
 * @returns {boolean}
 */
export function isStatsMounted() {
    return mounted;
}

/**
 * Mount the stats view into a container element.
 * @param {HTMLElement} container
 */
export function mountStatsView(container) {
    if (mounted) unmountStatsView();

    containerEl = container;
    mounted = true;
    container.innerHTML = '';

    // Build DOM structure
    const wrapper = document.createElement('div');
    wrapper.className = 'chat-manager-stats-container';

    // Title
    const title = document.createElement('h4');
    title.className = 'chat-manager-stats-title';
    const context = SillyTavern.getContext();
    const charName = context.name2 || 'Character';
    title.textContent = `Stats for ${charName}`;
    wrapper.appendChild(title);

    // Progress indicator
    const progress = document.createElement('div');
    progress.className = 'chat-manager-stats-progress';
    progress.id = 'chat-manager-stats-progress';
    wrapper.appendChild(progress);

    // Stats grid
    const grid = document.createElement('div');
    grid.className = 'chat-manager-stats-grid';
    grid.id = 'chat-manager-stats-grid';
    wrapper.appendChild(grid);

    // Heatmap section
    const heatSection = document.createElement('div');
    heatSection.className = 'chat-manager-heatmap-section';

    const heatTitle = document.createElement('h4');
    heatTitle.className = 'chat-manager-heatmap-title';
    heatTitle.textContent = 'Activity';
    heatSection.appendChild(heatTitle);

    const heatWrapper = document.createElement('div');
    heatWrapper.className = 'chat-manager-heatmap-wrapper';

    canvasEl = document.createElement('canvas');
    canvasEl.className = 'chat-manager-heatmap-canvas';
    heatWrapper.appendChild(canvasEl);
    heatSection.appendChild(heatWrapper);
    wrapper.appendChild(heatSection);

    container.appendChild(wrapper);

    ctx = canvasEl.getContext('2d');

    // Tooltip
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'chat-manager-heatmap-tooltip';
    tooltipEl.style.display = 'none';
    document.body.appendChild(tooltipEl);

    // Events
    canvasEl.addEventListener('mousemove', handleCanvasMouseMove);
    canvasEl.addEventListener('mouseleave', handleCanvasMouseLeave);
    canvasEl.addEventListener('click', handleCanvasClick);

    // Initial render
    updateStatsView();
}

/**
 * Unmount and clean up the stats view.
 */
export function unmountStatsView() {
    if (!mounted) return;
    mounted = false;

    if (canvasEl) {
        canvasEl.removeEventListener('mousemove', handleCanvasMouseMove);
        canvasEl.removeEventListener('mouseleave', handleCanvasMouseLeave);
        canvasEl.removeEventListener('click', handleCanvasClick);
        canvasEl = null;
    }

    ctx = null;

    if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
    }

    if (containerEl) {
        containerEl.innerHTML = '';
        containerEl = null;
    }

    cellLayout = [];
}

/**
 * Update the stats view with fresh data.
 */
export function updateStatsView() {
    if (!mounted) return;

    const chatIndex = getIndex();
    const version = getIndexVersion();
    const stats = computeStats(chatIndex, version);
    const heatmap = computeHeatmapData(chatIndex, version);

    renderStatsGrid(stats);
    renderProgress(stats);
    renderHeatmap(heatmap);
}

// ── Stats Grid Rendering ──

function renderStatsGrid(stats) {
    const grid = document.getElementById('chat-manager-stats-grid');
    if (!grid) return;

    const { moment } = SillyTavern.libs;

    const longestName = stats.longestChat
        ? (getDisplayName(stats.longestChat.fileName) || stats.longestChat.fileName.replace(/\.jsonl$/, ''))
        : '-';
    const mostActiveName = stats.mostActiveChat
        ? (getDisplayName(stats.mostActiveChat.fileName) || stats.mostActiveChat.fileName.replace(/\.jsonl$/, ''))
        : '-';

    const oldestStr = stats.oldestTimestamp ? moment(stats.oldestTimestamp).format('MMM D') : '?';
    const newestStr = stats.newestTimestamp ? moment(stats.newestTimestamp).format('MMM D') : '?';

    grid.innerHTML = `
        ${statCell('Total Chats', stats.totalChats.toLocaleString())}
        ${statCell('Total Messages', stats.totalMessages.toLocaleString())}
        ${statCell('Avg / Chat', stats.avgMessagesPerChat.toFixed(1))}
        ${statCell('Longest', stats.longestChat ? stats.longestChat.count.toLocaleString() + ' msgs' : '-', longestName)}
        ${statCell('User Messages', stats.userMessages.toLocaleString())}
        ${statCell('Asst Messages', stats.assistantMessages.toLocaleString())}
        ${statCell('Date Range', stats.oldestTimestamp ? `${oldestStr} \u2013 ${newestStr}` : '-')}
        ${statCell('Most Active', stats.mostActiveChat ? stats.mostActiveChat.count.toLocaleString() + ' msgs' : '-', mostActiveName)}
    `;
}

function statCell(label, value, detail = '') {
    return `<div class="chat-manager-stat-cell">
        <span class="chat-manager-stat-label">${escapeHtml(label)}</span>
        <span class="chat-manager-stat-value">${escapeHtml(String(value))}</span>
        ${detail ? `<span class="chat-manager-stat-detail" title="${escapeAttr(detail)}">${escapeHtml(detail)}</span>` : ''}
    </div>`;
}

function renderProgress(stats) {
    const el = document.getElementById('chat-manager-stats-progress');
    if (!el) return;

    if (stats.isComplete) {
        el.style.display = 'none';
    } else {
        el.style.display = '';
        el.textContent = `Indexing\u2026 ${stats.loadedChats}/${stats.totalChats} chats`;
    }
}

// ── Heatmap Rendering ──

function renderHeatmap(heatmap) {
    if (!canvasEl || !ctx) return;

    cellLayout = [];

    if (!heatmap.minDate || !heatmap.maxDate) {
        // No data — show minimal canvas
        const dpr = window.devicePixelRatio || 1;
        canvasEl.width = 200 * dpr;
        canvasEl.height = 40 * dpr;
        canvasEl.style.width = '200px';
        canvasEl.style.height = '40px';
        ctx.scale(dpr, dpr);
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '12px sans-serif';
        ctx.fillText('No activity data yet', 20, 24);
        return;
    }

    const minD = parseDate(heatmap.minDate);
    const maxD = parseDate(heatmap.maxDate);

    // Adjust to start on Monday
    const startDate = new Date(minD);
    const dayOfWeek = startDate.getDay();
    // getDay: 0=Sun, 1=Mon, ... Shift so Monday=0
    const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    startDate.setDate(startDate.getDate() - mondayOffset);

    // Count weeks
    const endDate = new Date(maxD);
    const totalDays = Math.ceil((endDate - startDate) / 86400000) + 1;
    const totalWeeks = Math.ceil(totalDays / 7);

    const step = CELL_SIZE + CELL_GAP;
    const canvasW = DAY_LABEL_WIDTH + totalWeeks * step;
    const canvasH = MONTH_LABEL_HEIGHT + ROWS * step;

    const dpr = window.devicePixelRatio || 1;
    canvasEl.width = canvasW * dpr;
    canvasEl.height = canvasH * dpr;
    canvasEl.style.width = `${canvasW}px`;
    canvasEl.style.height = `${canvasH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Compute quartiles for color levels
    const counts = [...heatmap.dayCounts.values()].filter(c => c > 0).sort((a, b) => a - b);
    const q1 = counts.length > 0 ? counts[Math.floor(counts.length * 0.25)] : 1;
    const q2 = counts.length > 0 ? counts[Math.floor(counts.length * 0.5)] : 2;
    const q3 = counts.length > 0 ? counts[Math.floor(counts.length * 0.75)] : 3;

    // Clear
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Day labels
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'middle';
    for (let row = 0; row < ROWS; row++) {
        if (DAY_LABELS[row]) {
            ctx.fillText(DAY_LABELS[row], 0, MONTH_LABEL_HEIGHT + row * step + CELL_SIZE / 2);
        }
    }

    // Month labels
    let lastMonth = -1;
    const cursor = new Date(startDate);
    for (let week = 0; week < totalWeeks; week++) {
        const monthDay = new Date(cursor);
        monthDay.setDate(monthDay.getDate() + week * 7);
        const month = monthDay.getMonth();
        if (month !== lastMonth) {
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '10px sans-serif';
            ctx.textBaseline = 'top';
            ctx.fillText(monthNames[month], DAY_LABEL_WIDTH + week * step, 0);
            lastMonth = month;
        }
    }

    // Cells
    const iterDate = new Date(startDate);
    for (let week = 0; week < totalWeeks; week++) {
        for (let row = 0; row < ROWS; row++) {
            const dateKey = formatDateKey(iterDate);
            const count = heatmap.dayCounts.get(dateKey) || 0;
            const chatSet = heatmap.dayChats.get(dateKey);
            const chatCount = chatSet ? chatSet.size : 0;
            const level = getLevel(count, q1, q2, q3);

            const x = DAY_LABEL_WIDTH + week * step;
            const y = MONTH_LABEL_HEIGHT + row * step;

            ctx.fillStyle = LEVEL_COLORS[level];
            ctx.beginPath();
            roundRect(ctx, x, y, CELL_SIZE, CELL_SIZE, 2);
            ctx.fill();

            cellLayout.push({ x, y, w: CELL_SIZE, h: CELL_SIZE, dateKey, count, chatCount });

            iterDate.setDate(iterDate.getDate() + 1);
        }
    }
}

function getLevel(count, q1, q2, q3) {
    if (count === 0) return 0;
    if (count <= q1) return 1;
    if (count <= q2) return 2;
    if (count <= q3) return 3;
    return 4;
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
}

function parseDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, m - 1, d);
}

function formatDateKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ── Canvas Interactions ──

function getCellAtPoint(canvasX, canvasY) {
    for (const cell of cellLayout) {
        if (canvasX >= cell.x && canvasX <= cell.x + cell.w &&
            canvasY >= cell.y && canvasY <= cell.y + cell.h) {
            return cell;
        }
    }
    return null;
}

function getCanvasCoords(e) {
    const rect = canvasEl.getBoundingClientRect();
    return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
    };
}

function handleCanvasMouseMove(e) {
    if (!tooltipEl || !canvasEl) return;

    const { x, y } = getCanvasCoords(e);
    const cell = getCellAtPoint(x, y);

    if (!cell) {
        tooltipEl.style.display = 'none';
        return;
    }

    const d = parseDate(cell.dateKey);
    const { moment } = SillyTavern.libs;
    const dateStr = moment(d).format('ddd, MMM D, YYYY');

    tooltipEl.innerHTML = `<strong>${escapeHtml(dateStr)}</strong><br>${cell.count} message${cell.count !== 1 ? 's' : ''} in ${cell.chatCount} chat${cell.chatCount !== 1 ? 's' : ''}`;
    tooltipEl.style.display = '';

    // Position near cursor
    tooltipEl.style.left = `${e.clientX + 12}px`;
    tooltipEl.style.top = `${e.clientY - 8}px`;

    // Keep on screen
    requestAnimationFrame(() => {
        if (!tooltipEl) return;
        const tr = tooltipEl.getBoundingClientRect();
        if (tr.right > window.innerWidth - 8) {
            tooltipEl.style.left = `${e.clientX - tr.width - 12}px`;
        }
        if (tr.bottom > window.innerHeight - 8) {
            tooltipEl.style.top = `${e.clientY - tr.height - 8}px`;
        }
    });
}

function handleCanvasMouseLeave() {
    if (tooltipEl) tooltipEl.style.display = 'none';
}

function handleCanvasClick(e) {
    const { x, y } = getCanvasCoords(e);
    const cell = getCellAtPoint(x, y);

    if (!cell || cell.count === 0) return;

    // Get chat file names for this day
    const chatIndex = getIndex();
    const version = getIndexVersion();
    const heatmap = computeHeatmapData(chatIndex, version);
    const chatFileNames = heatmap.dayChats.get(cell.dateKey);

    if (callbacks.onDayClick && chatFileNames) {
        callbacks.onDayClick(cell.dateKey, [...chatFileNames]);
    }
}

// ── Helpers ──

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
