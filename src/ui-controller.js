/**
 * UI Controller — Panel rendering, state management, event binding.
 */

import {
    buildIndex, getHydrationProgress, getIndex, getSearchableMessages,
    isHydrationComplete, onHydrationUpdate, runDeferredBranchDetection,
} from './chat-reader.js';
import {
    getDisplayName, setDisplayName, getSummary, setSummary,
    migrateFileKey, getDisplayMode,
} from './metadata-store.js';
import {
    generateTitleForActiveChat, generateTitleForChat,
    generateSummaryForActiveChat, generateSummaryForChat,
    isLLMAvailable,
} from './ai-features.js';

const MODULE_NAME = 'chat_manager';

let panelOpen = false;
const RESULTS_PAGE_SIZE = 50;
let hydrationSubscriptionReady = false;
let refreshFromHydrationTimer = null;
let refreshSearchFromHydrationTimer = null;

/**
 * Streaming search state — allows early termination and "load more" resumption.
 * @type {{ query: string, lowerQuery: string, searchable: Array, position: number, results: Array, totalMatches: number } | null}
 */
let searchState = null;

export function resetSearchState() {
    searchState = null;
}

function getIndexingSuffix() {
    const { loaded, total } = getHydrationProgress();
    if (!isHydrationComplete() && total > 0) {
        return ` • Indexing chats... ${loaded}/${total}`;
    }
    return '';
}

function withIndexingSuffix(text) {
    return `${text}${getIndexingSuffix()}`;
}

function getCurrentSearchQuery() {
    const searchInput = document.getElementById('chat-manager-search');
    return searchInput ? searchInput.value.trim() : '';
}

function scheduleHydrationUIRefresh() {
    if (refreshFromHydrationTimer) return;

    refreshFromHydrationTimer = setTimeout(() => {
        refreshFromHydrationTimer = null;
        if (!panelOpen) return;

        const query = getCurrentSearchQuery();
        if (query.length >= 2) return;

        renderThreadCards();
        const activeFile = getActiveFilename();
        runDeferredBranchDetection(activeFile);
        patchBranchIndicators();
    }, 120);
}

function scheduleSearchRefresh(query) {
    if (refreshSearchFromHydrationTimer) {
        clearTimeout(refreshSearchFromHydrationTimer);
    }

    refreshSearchFromHydrationTimer = setTimeout(() => {
        refreshSearchFromHydrationTimer = null;
        if (!panelOpen) return;

        const latestQuery = getCurrentSearchQuery();
        if (latestQuery.length < 2) return;
        performSearch(latestQuery);
    }, 180);
}

function ensureHydrationSubscription() {
    if (hydrationSubscriptionReady) return;

    onHydrationUpdate(() => {
        if (!panelOpen) return;
        const query = getCurrentSearchQuery();
        if (query.length >= 2) {
            scheduleSearchRefresh(query);
        } else {
            scheduleHydrationUIRefresh();
        }
    });

    hydrationSubscriptionReady = true;
}

// ──────────────────────────────────────────────
//  Panel Toggle
// ──────────────────────────────────────────────

export function isPanelOpen() {
    return panelOpen;
}

export async function togglePanel() {
    const mode = getDisplayMode();
    if (mode === 'popup') {
        await togglePopup();
    } else {
        await toggleSidePanel();
    }
}

export function closePanel() {
    const mode = getDisplayMode();
    if (mode === 'popup') {
        closePopup();
    } else {
        closeSidePanel();
    }
}

// ── Side Panel ──

let isToggling = false;

async function toggleSidePanel() {
    if (isToggling) return;
    isToggling = true;
    try {
        const panel = document.getElementById('chat-manager-panel');
        if (!panel) return;

        panelOpen = !panelOpen;

        if (panelOpen) {
            panel.classList.add('open');
            await refreshPanel();
        } else {
            panel.classList.remove('open');
        }
    } finally {
        isToggling = false;
    }
}

function closeSidePanel() {
    const panel = document.getElementById('chat-manager-panel');
    if (panel) panel.classList.remove('open');
    panelOpen = false;
}

// ── Popup ──

async function togglePopup() {
    if (isToggling) return;
    isToggling = true;
    try {
        const overlay = document.getElementById('chat-manager-shadow-overlay');
        if (!overlay) return;

        panelOpen = !panelOpen;

        if (panelOpen) {
            overlay.style.display = 'block';
            // Force reflow so the transition triggers
            void overlay.offsetHeight;
            overlay.classList.add('visible');
            await refreshPanel();
        } else {
            closePopup();
        }
    } finally {
        isToggling = false;
    }
}

function closePopup() {
    const overlay = document.getElementById('chat-manager-shadow-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => {
        if (!overlay.classList.contains('visible')) {
            overlay.style.display = 'none';
        }
    }, 300);
    panelOpen = false;
}

// ──────────────────────────────────────────────
//  Panel Refresh
// ──────────────────────────────────────────────

export async function refreshPanel() {
    const context = SillyTavern.getContext();

    // Guard: no character selected or group chat
    if (context.characterId === undefined) {
        renderEmptyState('Select a character to manage chats.');
        return;
    }

    const index = getIndex();
    const hasCache = Object.keys(index).length > 0;

    if (hasCache) {
        // Cache-first: render immediately from existing index
        renderThreadCards();
    } else {
        renderLoading();
    }

    const { changed } = await buildIndex(hasCache ? null : onIndexProgress);

    if (changed || !hasCache) {
        renderThreadCards();
    }

    // Deferred branch detection: run after cards are rendered, then patch indicators
    const activeFile = getActiveFilename();
    setTimeout(() => {
        runDeferredBranchDetection(activeFile);
        patchBranchIndicators();
    }, 0);

    // Invalidate search state since the index may have changed
    if (changed) {
        searchState = null;
    }
}

function onIndexProgress(completed, total) {
    const status = document.getElementById('chat-manager-status');
    if (status) {
        status.textContent = `Indexing chats... ${completed}/${total}`;
    }
}

/**
 * Patch branch indicators into already-rendered cards (called after deferred branch detection).
 */
function patchBranchIndicators() {
    const index = getIndex();
    const activeFile = getActiveFilename();
    const activeEntry = activeFile ? index[activeFile] : null;
    const entries = Object.values(index);

    for (const entry of entries) {
        if (entry.branchPoint === null) continue;
        const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(entry.fileName)}"]`);
        if (!card) continue;

        const meta = card.querySelector('.chat-manager-card-meta');
        if (!meta) continue;

        // Skip if already patched
        if (meta.querySelector('.chat-manager-branch')) continue;

        const distance = activeEntry ? activeEntry.messageCount - entry.branchPoint : null;
        const span = document.createElement('span');
        span.className = 'chat-manager-branch';
        span.textContent = distance !== null ? `Branched ${distance} msgs ago` : `Branched at msg #${entry.branchPoint}`;
        meta.appendChild(span);
    }
}

// ──────────────────────────────────────────────
//  Rendering: Thread Cards
// ──────────────────────────────────────────────

function renderLoading() {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (container) container.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Loading chats...</div>';
    if (status) status.textContent = 'Loading...';
}

function renderEmptyState(message) {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (container) container.innerHTML = `<div class="chat-manager-empty">${escapeHtml(message)}</div>`;
    if (status) status.textContent = '';
}

export function renderThreadCards() {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;

    const index = getIndex();
    const entries = Object.values(index);

    if (entries.length === 0) {
        renderEmptyState('No chats found for this character.');
        return;
    }

    // Sort by last message timestamp, most recent first
    entries.sort((a, b) => {
        const aTime = a.lastMessageTimestamp ? new Date(a.lastMessageTimestamp).getTime() : 0;
        const bTime = b.lastMessageTimestamp ? new Date(b.lastMessageTimestamp).getTime() : 0;
        return bTime - aTime;
    });

    const { moment, DOMPurify } = SillyTavern.libs;
    const context = SillyTavern.getContext();
    const activeChatFile = getActiveFilename();

    const activeEntry = activeChatFile ? index[activeChatFile] : null;

    let html = '';
    for (const entry of entries) {
        const displayName = getDisplayName(entry.fileName) || entry.fileName;
        const summary = getSummary(entry.fileName);
        const isActive = entry.fileName === activeChatFile;

        const firstDate = entry.firstMessageTimestamp ? moment(entry.firstMessageTimestamp).format('MMM D') : '?';
        const lastDate = entry.lastMessageTimestamp ? moment(entry.lastMessageTimestamp).format('MMM D') : '?';
        const lastActive = entry.lastMessageTimestamp ? moment(entry.lastMessageTimestamp).fromNow() : 'unknown';

        const branchDistance = (entry.branchPoint !== null && activeEntry)
            ? activeEntry.messageCount - entry.branchPoint : null;
        const branchInfo = entry.branchPoint !== null
            ? `<span class="chat-manager-branch">${branchDistance !== null ? `Branched ${branchDistance} msgs ago` : `Branched at msg #${entry.branchPoint}`}</span>`
            : '';

        html += `
        <div class="chat-manager-card${isActive ? ' active' : ''}" data-filename="${escapeAttr(entry.fileName)}">
            <div class="chat-manager-card-header">
                <span class="chat-manager-display-name" data-filename="${escapeAttr(entry.fileName)}" title="Click to switch thread">${escapeHtml(displayName)}</span>
                <div class="chat-manager-card-actions">
                    <i class="chat-manager-icon-btn chat-manager-edit-name-btn fa-fw fa-solid fa-pen" data-filename="${escapeAttr(entry.fileName)}" title="Edit display name" tabindex="0"></i>
                    <i class="chat-manager-icon-btn chat-manager-ai-title-btn fa-fw fa-solid fa-robot" data-filename="${escapeAttr(entry.fileName)}" title="Generate AI title" tabindex="0"></i>
                    <i class="chat-manager-icon-btn chat-manager-rename-file-btn fa-fw fa-solid fa-file-pen" data-filename="${escapeAttr(entry.fileName)}" title="Rename original file" tabindex="0"></i>
                </div>
            </div>
            <div class="chat-manager-card-meta">
                <span>${entry.messageCount} messages</span>
                <span>${firstDate} – ${lastDate}</span>
                <span>${lastActive}</span>
                ${branchInfo}
            </div>
            <div class="chat-manager-card-summary" data-filename="${escapeAttr(entry.fileName)}">
                ${summary
                    ? `<p class="chat-manager-summary-text">${escapeHtml(summary)}</p>`
                    : '<p class="chat-manager-summary-text chat-manager-no-summary">No summary yet</p>'
                }
                <div class="chat-manager-summary-actions">
                    <i class="chat-manager-icon-btn chat-manager-edit-summary-btn fa-fw fa-solid fa-pen" data-filename="${escapeAttr(entry.fileName)}" title="Edit summary" tabindex="0"></i>
                    <i class="chat-manager-icon-btn chat-manager-regen-summary-btn fa-fw fa-solid fa-rotate" data-filename="${escapeAttr(entry.fileName)}" title="Generate/regenerate summary" tabindex="0"></i>
                </div>
            </div>
            <div class="chat-manager-card-filename">${escapeHtml(entry.fileName)}</div>
        </div>`;
    }

    container.innerHTML = DOMPurify.sanitize(html);
    if (status) status.textContent = `Showing ${entries.length} threads`;

    bindCardEvents(container);
}

// ──────────────────────────────────────────────
//  Rendering: Search Results
// ──────────────────────────────────────────────

export function performSearch(query) {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;

    if (!query || query.trim().length < 2) {
        renderThreadCards();
        return;
    }

    const trimmed = query.trim();
    const lowerQuery = trimmed.toLowerCase();

    // Initialize streaming search state
    searchState = {
        query: trimmed,
        lowerQuery,
        searchable: getSearchableMessages(),
        position: 0,
        results: [],
        totalMatches: 0,
        exhausted: false,
    };

    // Find the first page of results
    searchMoreResults(RESULTS_PAGE_SIZE);

    if (status) {
        const threadSet = new Set(searchState.results.map(r => r.item.filename));
        const countLabel = searchState.exhausted
            ? `Found ${searchState.totalMatches} match${searchState.totalMatches !== 1 ? 'es' : ''}`
            : `Found ${searchState.totalMatches}+ match${searchState.totalMatches !== 1 ? 'es' : ''}`;
        status.textContent = `${countLabel} across ${threadSet.size}${searchState.exhausted ? '' : '+'} thread${threadSet.size !== 1 ? 's' : ''} for: ${trimmed}`;
    }

    if (searchState.results.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No results found.</div>';
        return;
    }

    container.innerHTML = '';
    renderSearchPage(container, 0);
}

/**
 * Search forward from the current position until we find `count` more matches or exhaust all messages.
 */
function searchMoreResults(count) {
    if (!searchState || searchState.exhausted) return;

    const { lowerQuery, searchable } = searchState;
    let found = 0;

    while (searchState.position < searchable.length && found < count) {
        const msg = searchable[searchState.position];
        const matchIndex = msg.textLower.indexOf(lowerQuery);
        if (matchIndex !== -1) {
            searchState.results.push({ item: msg, matchIndex });
            searchState.totalMatches++;
            found++;
        }
        searchState.position++;
    }

    if (searchState.position >= searchable.length) {
        searchState.exhausted = true;
    }
}

/**
 * Render a page of search results starting from `fromIndex` within searchState.results.
 * @param {HTMLElement} container
 * @param {number} fromIndex - index into searchState.results to render from
 */
function renderSearchPage(container, fromIndex) {
    if (!searchState) return;

    const { DOMPurify, moment } = SillyTavern.libs;
    const prevButtonCount = container.querySelectorAll('.chat-manager-jump-btn').length;
    const end = Math.min(fromIndex + RESULTS_PAGE_SIZE, searchState.results.length);
    let html = '';

    for (let i = fromIndex; i < end; i++) {
        const result = searchState.results[i];
        const item = result.item;
        const displayName = getDisplayName(item.filename) || item.filename;
        const roleLabel = item.role === 'user' ? 'User' : 'Character';
        const dateStr = item.timestamp ? moment(item.timestamp).format('MMM D') : '';

        // Build highlighted excerpt
        const excerpt = buildHighlightedExcerpt(item.text, searchState.query);

        html += `
        <div class="chat-manager-search-result" data-filename="${escapeAttr(item.filename)}" data-msg-index="${item.index}">
            <div class="chat-manager-result-header">
                <span class="chat-manager-result-thread">${escapeHtml(displayName)}</span>
            </div>
            <div class="chat-manager-result-meta">
                Message #${item.index} (${roleLabel}${dateStr ? ', ' + dateStr : ''})
            </div>
            <div class="chat-manager-result-excerpt">${excerpt}</div>
            <button class="chat-manager-btn chat-manager-jump-btn" data-filename="${escapeAttr(item.filename)}" data-msg-index="${item.index}">Jump to message</button>
        </div>`;
    }

    // Create fragment
    const temp = document.createElement('div');
    temp.innerHTML = DOMPurify.sanitize(html);
    while (temp.firstChild) {
        container.appendChild(temp.firstChild);
    }

    // Remove any existing load-more button
    const existingBtn = container.querySelector('.chat-manager-load-more');
    if (existingBtn) existingBtn.remove();

    // Add load more button if there are more results already found, or more to search
    const displayedUpTo = end;
    const hasMoreFound = displayedUpTo < searchState.results.length;
    const canSearchMore = !searchState.exhausted;

    if (hasMoreFound || canSearchMore) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'chat-manager-btn chat-manager-load-more';

        if (searchState.exhausted) {
            loadMoreBtn.textContent = `Load more (${searchState.results.length - displayedUpTo} remaining)`;
        } else {
            loadMoreBtn.textContent = 'Load more results...';
        }

        loadMoreBtn.addEventListener('click', () => {
            // If we need more results beyond what we've found, search for more
            if (displayedUpTo >= searchState.results.length && !searchState.exhausted) {
                searchMoreResults(RESULTS_PAGE_SIZE);
            }

            // Update status
            const status = document.getElementById('chat-manager-status');
            if (status) {
                const threadSet = new Set(searchState.results.map(r => r.item.filename));
                const countLabel = searchState.exhausted
                    ? `Found ${searchState.totalMatches} match${searchState.totalMatches !== 1 ? 'es' : ''}`
                    : `Found ${searchState.totalMatches}+ match${searchState.totalMatches !== 1 ? 'es' : ''}`;
                status.textContent = `${countLabel} across ${threadSet.size}${searchState.exhausted ? '' : '+'} thread${threadSet.size !== 1 ? 's' : ''} for: ${searchState.query}`;
            }

            if (searchState.results.length > displayedUpTo) {
                renderSearchPage(container, displayedUpTo);
            } else {
                // Nothing more found
                loadMoreBtn.remove();
            }
        });
        container.appendChild(loadMoreBtn);
    }

    // Bind jump buttons (only newly added ones)
    const allButtons = container.querySelectorAll('.chat-manager-jump-btn');
    for (let i = prevButtonCount; i < allButtons.length; i++) {
        allButtons[i].addEventListener('click', handleJumpToMessage);
    }
}

function buildHighlightedExcerpt(text, query) {
    const { DOMPurify } = SillyTavern.libs;
    const lowerText = text.toLowerCase();
    const lowerQuery = query.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerQuery);

    if (matchIndex === -1) {
        const truncated = text.length > 120 ? text.substring(0, 120) + '...' : text;
        return DOMPurify.sanitize(escapeHtml(truncated));
    }

    const contextChars = 50;
    const start = Math.max(0, matchIndex - contextChars);
    const end = Math.min(text.length, matchIndex + query.length + contextChars);

    const before = text.substring(start, matchIndex);
    const match = text.substring(matchIndex, matchIndex + query.length);
    const after = text.substring(matchIndex + query.length, end);

    const prefix = start > 0 ? '...' : '';
    const suffix = end < text.length ? '...' : '';

    const highlighted = `${prefix}${escapeHtml(before)}<span class="chat-manager-highlight">${escapeHtml(match)}</span>${escapeHtml(after)}${suffix}`;

    return DOMPurify.sanitize(highlighted);
}

// ──────────────────────────────────────────────
//  Event Handling for Cards
// ──────────────────────────────────────────────

function bindCardEvents(container) {
    // Click on card to switch thread
    container.querySelectorAll('.chat-manager-display-name').forEach(el => {
        el.addEventListener('click', handleSwitchThread);
    });

    // Edit display name
    container.querySelectorAll('.chat-manager-edit-name-btn').forEach(btn => {
        btn.addEventListener('click', handleEditDisplayName);
    });

    // AI title
    container.querySelectorAll('.chat-manager-ai-title-btn').forEach(btn => {
        btn.addEventListener('click', handleAITitle);
    });

    // Rename file
    container.querySelectorAll('.chat-manager-rename-file-btn').forEach(btn => {
        btn.addEventListener('click', handleRenameFile);
    });

    // Edit summary
    container.querySelectorAll('.chat-manager-edit-summary-btn').forEach(btn => {
        btn.addEventListener('click', handleEditSummary);
    });

    // Regenerate summary
    container.querySelectorAll('.chat-manager-regen-summary-btn').forEach(btn => {
        btn.addEventListener('click', handleRegenSummary);
    });
}

async function handleSwitchThread(e) {
    const filename = e.currentTarget.dataset.filename;
    if (!filename) return;

    const activeChatFile = getActiveFilename();
    if (filename === activeChatFile) return;

    const context = SillyTavern.getContext();
    await context.openCharacterChat(filename.replace(/\.jsonl$/i, ''));

    if (getDisplayMode() === 'popup') {
        closePanel();
    }
}

function handleEditDisplayName(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const card = e.currentTarget.closest('.chat-manager-card');
    if (!card) return;

    const nameEl = card.querySelector('.chat-manager-display-name');
    const currentName = getDisplayName(filename) || filename;

    // Replace with input
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'chat-manager-inline-edit';
    input.value = currentName;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let cancelled = false;
    const save = () => {
        const span = document.createElement('span');
        span.className = 'chat-manager-display-name';
        span.dataset.filename = filename;
        span.title = 'Click to switch thread';
        span.addEventListener('click', handleSwitchThread);

        if (cancelled) {
            span.textContent = currentName;
            input.replaceWith(span);
            return;
        }

        const newName = input.value.trim();
        if (newName && newName !== filename) {
            setDisplayName(filename, newName);
        }
        span.textContent = newName || filename;
        input.replaceWith(span);
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            input.blur();
        } else if (ev.key === 'Escape') {
            cancelled = true;
            input.blur();
        }
    });
}

async function handleAITitle(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const filename = btn.dataset.filename;
    if (btn.classList.contains('disabled')) return;

    btn.classList.add('disabled', 'fa-spin');
    btn.classList.replace('fa-robot', 'fa-gear');

    try {
        const activeChatFile = getActiveFilename();
        let title;

        if (filename === activeChatFile) {
            title = await generateTitleForActiveChat();
        } else {
            const index = getIndex();
            const chatData = index[filename];
            if (!chatData || !chatData.messages.length) {
                toastr.warning('No messages in this chat.');
                return;
            }
            const context = SillyTavern.getContext();
            title = await generateTitleForChat(chatData.messages, context.name2);
        }

        if (title) {
            setDisplayName(filename, title);
            // Update the UI
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card) {
                const nameEl = card.querySelector('.chat-manager-display-name');
                if (nameEl) nameEl.textContent = title;
            }
            toastr.success('Title generated!');
        }
    } finally {
        btn.classList.remove('disabled', 'fa-spin');
        btn.classList.replace('fa-gear', 'fa-robot');
    }
}

async function handleRenameFile(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const context = SillyTavern.getContext();

    // Use ST's Popup for confirmation
    const { Popup, POPUP_TYPE, POPUP_RESULT } = context;

    const baseName = filename.replace(/\.jsonl$/, '');

    const popup = new Popup(
        `<div class="chat-manager-rename-dialog">
            <p><strong>Warning:</strong> This will rename the actual chat file on disk. Checkpoints or bookmarks referencing the old filename may break.</p>
            <p>Current filename: <code>${escapeHtml(filename)}</code></p>
            <label>New filename:<br>
                <input type="text" id="chat-manager-rename-input" value="${escapeAttr(baseName)}" style="width:100%">
            </label>
            <p class="chat-manager-rename-suffix">.jsonl will be added automatically</p>
        </div>`,
        POPUP_TYPE.CONFIRM,
        '',
        {
            okButton: 'Rename',
            cancelButton: 'Cancel',
        },
    );

    const result = await popup.show();

    if (result !== POPUP_RESULT.AFFIRMATIVE) return;

    const inputEl = document.getElementById('chat-manager-rename-input');
    if (!inputEl) return;

    let newBase = inputEl.value.trim();

    // Sanitize: allow a-z, 0-9, -, _ only
    newBase = newBase.replace(/[^a-zA-Z0-9\-_]/g, '_');

    if (!newBase) {
        toastr.error('Invalid filename.');
        return;
    }

    const newFilename = newBase + '.jsonl';
    if (newFilename === filename) {
        toastr.info('Filename unchanged.');
        return;
    }

    try {
        await context.renameChat(baseName, newBase);
        migrateFileKey(filename, newFilename);
        toastr.success(`Renamed to ${newFilename}`);
        await refreshPanel();
    } catch (err) {
        console.error(`[${MODULE_NAME}] Rename failed:`, err);
        toastr.error('Failed to rename chat file.');
    }
}

function handleEditSummary(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const summaryBlock = e.currentTarget.closest('.chat-manager-card-summary');
    if (!summaryBlock) return;

    const textEl = summaryBlock.querySelector('.chat-manager-summary-text');
    const currentSummary = getSummary(filename) || '';

    const textarea = document.createElement('textarea');
    textarea.className = 'chat-manager-inline-edit chat-manager-summary-edit';
    textarea.value = currentSummary;
    textarea.rows = 3;
    textEl.replaceWith(textarea);
    textarea.focus();

    const save = () => {
        const newSummary = textarea.value.trim();
        setSummary(filename, newSummary, true);

        const p = document.createElement('p');
        p.className = 'chat-manager-summary-text' + (newSummary ? '' : ' chat-manager-no-summary');
        p.textContent = newSummary || 'No summary yet';
        textarea.replaceWith(p);
    };

    textarea.addEventListener('blur', save);
    textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
            ev.preventDefault();
            textarea.blur();
        } else if (ev.key === 'Escape') {
            textarea.value = currentSummary;
            textarea.blur();
        }
    });
}

async function handleRegenSummary(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const filename = btn.dataset.filename;
    if (btn.classList.contains('disabled')) return;

    btn.classList.add('disabled', 'fa-spin');

    try {
        const activeChatFile = getActiveFilename();
        let summary;

        if (filename === activeChatFile) {
            summary = await generateSummaryForActiveChat();
        } else {
            const index = getIndex();
            const chatData = index[filename];
            if (!chatData || !chatData.messages.length) {
                toastr.warning('No messages in this chat.');
                return;
            }
            const context = SillyTavern.getContext();
            summary = await generateSummaryForChat(chatData.messages, context.name2);
        }

        if (summary) {
            setSummary(filename, summary, false);
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card) {
                const textEl = card.querySelector('.chat-manager-summary-text');
                if (textEl) {
                    textEl.textContent = summary;
                    textEl.classList.remove('chat-manager-no-summary');
                }
            }
            toastr.success('Summary generated!');
        }
    } finally {
        btn.classList.remove('disabled', 'fa-spin');
    }
}

async function handleJumpToMessage(e) {
    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;

    const activeChatFile = getActiveFilename();
    const context = SillyTavern.getContext();

    if (filename !== activeChatFile) {
        const displayName = getDisplayName(filename) || filename;

        const { Popup, POPUP_TYPE, POPUP_RESULT } = context;
        const popup = new Popup(
            `<p>Switch to thread <strong>${escapeHtml(displayName)}</strong>?</p>`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Switch', cancelButton: 'Cancel' },
        );

        const result = await popup.show();
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        await context.openCharacterChat(filename.replace(/\.jsonl$/i, ''));
        // Wait a moment for chat to render
        await new Promise(r => setTimeout(r, 500));
    }

    if (getDisplayMode() === 'popup') {
        closePanel();
    }

    // Scroll to message
    const messageEl = document.querySelector(`#chat .mes[mesid="${msgIndex}"]`);
    if (messageEl) {
        messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        messageEl.classList.add('chat-manager-flash');
        setTimeout(() => messageEl.classList.remove('chat-manager-flash'), 1500);
    }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Get the currently active chat filename by matching against the index.
 */
function getActiveFilename() {
    const context = SillyTavern.getContext();

    // Try chatMetadata first (most reliable)
    if (context.chatMetadata && context.chatMetadata.chat_file_name) {
        return context.chatMetadata.chat_file_name;
    }

    // Fallback: match the current chat's first message against the index
    const index = getIndex();
    if (context.chat && context.chat.length > 0) {
        const firstMsg = context.chat[0];
        const firstText = firstMsg?.mes;
        const lastMsg = context.chat[context.chat.length - 1];
        const lastText = lastMsg?.mes;

        for (const [filename, entry] of Object.entries(index)) {
            if (entry.messages.length !== context.chat.length) continue;
            const entryFirst = entry.messages[0]?.text;
            const entryLast = entry.messages[entry.messages.length - 1]?.text;
            if (entryFirst === firstText && entryLast === lastText) {
                return filename;
            }
        }
    }

    return null;
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

/**
 * Called from index.js when the search input changes.
 * @param {string} query
 */
export function onSearchInput(query) {
    if (!query || query.trim().length < 2) {
        renderThreadCards();
    } else {
        performSearch(query);
    }
}
