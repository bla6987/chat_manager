/**
 * UI Controller — Panel rendering, state management, event binding.
 */

import {
    buildIndex, didLastBuildFail, getHydrationProgress, getIndex, getIndexCharacterAvatar, getSortedEntries,
    getFilteredSortedEntries, getIndexVersion, isBuilding,
    isHydrationComplete, onHydrationUpdate, prioritizeInQueue, prioritizeHydrationFiles, runDeferredBranchDetection,
    readChatMessages, trimBodyCache,
    ensureMessageEmbeddingMap, getMessageActiveSwipeIndex, getMessageEmbedding, setMessageEmbedding, setChatEmbedding, clearResidentVectors, makeMessageEmbeddingKey,
} from './chat-reader.js';
import {
    getDisplayName, getSummary,
    migrateFileKey, getDisplayMode, getChatMeta, setChatMeta,
    getThreadFocus, setThreadFocus as persistThreadFocus,
    getBranchContextEnabled, setBranchContextEnabled,
    getTagDefinitions, createTagDefinition, updateTagDefinition, deleteTagDefinition, safeTagColor,
    getChatTags, addChatTag, removeChatTag,
    getFilterState, setFilterState, clearFilterState, hasActiveFilter,
    getSortState, setSortState, getEmbeddingSettings,
    getSelectedEmbeddingChats, setSelectedEmbeddingChats,
    isEmbeddingChatSelected, setEmbeddingChatSelected,
} from './metadata-store.js';
import {
    updateBranchContextInjection, clearBranchContextInjection, formatBranchContextForSummary, getSiblingMessagesAsync,
} from './branch-context.js';
import {
    generateTitleForChat, generateSummaryForChat,
} from './ai-features.js';
import {
    mountIcicle, unmountIcicle, updateIcicleData,
    focusMessageInIcicle, isIcicleMounted, setIcicleCallbacks,
    invalidateIcicleEmbeddings,
    setThreadFocus as setIcicleThreadFocus,
} from './icicle-view.js';
import {
    mountSemanticMap, unmountSemanticMap, updateSemanticMapData,
    focusMessageInSemanticMap, isSemanticMapMounted, setSemanticMapCallbacks,
    invalidateSemanticMapEmbeddings,
} from './semantic-map-view.js';
import {
    mountGraphView, unmountGraphView, updateGraphViewData,
    isGraphViewMounted, setGraphViewCallbacks, setGraphScope,
    invalidateGraphEmbeddings,
} from './graph-view.js';
import {
    mountStatsView, unmountStatsView, updateStatsView,
    isStatsMounted, setStatsCallbacks,
} from './stats-view.js';
import {
    embedText, embedTexts, getCachedEmbeddingForText, getCachedEmbeddingsForTexts, hashEmbeddingText, isEmbeddingConfigured,
    captureEmbeddingOperation, isEmbeddingOperationCurrent, invalidateEmbeddingOperations, isStaleEmbeddingOperationError,
    onEmbeddingDimensionsInvalidated,
} from './embedding-service.js';
import { clusterColor, cosineSimilarity, findOptimalKAsync, kMeansAsync } from './semantic-engine.js';
import { resolveActiveChatFilename } from './active-chat.js';
import { getRepresentativeEmbeddingText } from './embedding-text.js';
import { navigateToChat } from './chat-navigation.js';
import { timestampMs } from './timestamps.js';
import { isVector } from './vector-utils.js';
import { iterateVariantBatches } from './archive-data.js';
import { searchArchivePage } from './archive-search.js';
import { computeArchiveClusters } from './archive-clusters.js';
import { computeArchiveDriftSummary } from './archive-drift.js';
import { messagePreview } from './message-descriptors.js';

const MODULE_NAME = 'chat_manager';
const HYBRID_SEARCH_MIN_CHARS = 5;
const HYBRID_SEARCH_LIMIT = 100;
const RECLUSTER_IDLE_MS = 60000;
const RECLUSTER_IMMEDIATE_THRESHOLD = 5;
const RECLUSTER_CHAT_DELTA_RATIO = 0.2;
const SWIPE_BACKGROUND_EMBED_DELAY_MS = 650;
const SUMMARY_SIBLING_BRANCH_LIMIT = 3;

// Keep the text readable while only the decorative icon spins.
function setActionBusy(btn, busy) {
    btn.disabled = busy;
    btn.ariaBusy = String(busy);
    btn.classList.toggle('disabled', busy);
    const icon = btn.querySelector('i');
    if (!icon) return;
    if (busy) {
        icon.dataset.idleClass = icon.className;
        icon.className = 'fa-solid fa-spinner fa-spin';
    } else if (icon.dataset.idleClass) {
        icon.className = icon.dataset.idleClass;
        delete icon.dataset.idleClass;
    }
}

function setToggleState(btn, active) {
    if (!btn) return;
    btn.classList.toggle('active', active);
    btn.ariaPressed = String(active);
}

function renderCardAction(actionClass, fileName, icon, label, title, disabled = false) {
    return `<button type="button" class="chat-manager-btn chat-manager-labeled-btn chat-manager-card-action ${actionClass}${disabled ? ' disabled' : ''}" data-filename="${escapeAttr(fileName)}" title="${escapeAttr(title)}"${disabled ? ' disabled' : ''}><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
}

let panelOpen = false;
let timelineActive = false;
let semanticMapActive = false;
let graphViewActive = false;
let statsActive = false;
let branchContextActive = false;
const RESULTS_PAGE_SIZE = 50;
const threadLists = new WeakMap();
let hydrationSubscriptionReady = false;
let refreshFromHydrationTimer = null;
let refreshSearchFromHydrationTimer = null;
let refreshTimelineFromHydrationTimer = null;
let refreshSemanticMapFromHydrationTimer = null;
let refreshGraphViewFromHydrationTimer = null;
let refreshStatsFromHydrationTimer = null;
let embedBootstrapTimer = null;
let branchDetectionTask = null;
let embedIncrementalTimer = null;
const EMBED_INCREMENTAL_DELAY_MS = 1200;
export const AUTOMATIC_MESSAGE_RESTORE_LIMIT = 256;
const pendingIncrementalEmbedFiles = new Set();
let embedRunPromise = null;
let generationActive = false;
let deferredBootstrapFile = null;
let deferredBootstrapRequested = false;
let pendingClusterChanges = 0;
let reclusterIdleTimer = null;
let lastClusterK = null;
let lastClusterChatCount = 0;
let lastClusterResult = 0;
let backgroundSwipeEmbedTimer = null;
let backgroundSwipeEmbedActive = false;
const pendingBackgroundSwipeCandidates = new Map();
let latestSearchRequestId = 0;
const queryEmbeddingCache = new Map();
const queryEmbeddingInFlight = new Map();
let clusterResultCache = null;
const clusterComputationsInFlight = new Map();
const clusterVectorIds = new WeakMap();
let nextClusterInputId = 1;
let queryEmbeddingEpoch = 0;
let driftSummaryCache = new WeakMap();
const pendingDriftFiles = new Set();
let driftWorkTimer = null;
let driftWorkController = null;

// A view can discover provider dimension drift before a foreground run does.
// Retire every transient vector with the persistent cache in that same event.
onEmbeddingDimensionsInvalidated(() => clearInMemoryEmbeddings({ rerender: false }));

/**
 * Streaming search state — allows early termination and "load more" resumption.
 * @type {{ query: string, lowerQuery: string, searchable: Array, position: number, results: Array, totalMatches: number, exhausted?: boolean, mode?: 'keyword'|'semantic' } | null}
 */
let searchState = null;
let searchPageAbort = null;
let searchRefreshPending = false;
/** @type {null|'keyword'|'semantic'} — null = auto, otherwise forced mode */
let searchModeOverride = null;

/* ── DOM element cache — avoids repeated querySelector calls ── */
const _domCache = {
    searchWrapper: null,
    filterToolbar: null,
    content: null,
    status: null,
    searchInput: null,
};

function _getSearchWrapper() {
    if (!_domCache.searchWrapper || !_domCache.searchWrapper.isConnected) {
        _domCache.searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    }
    return _domCache.searchWrapper;
}

function _getFilterToolbar() {
    if (!_domCache.filterToolbar || !_domCache.filterToolbar.isConnected) {
        _domCache.filterToolbar = document.querySelector('.chat-manager-filter-toolbar');
    }
    return _domCache.filterToolbar;
}

function _getContent() {
    if (!_domCache.content || !_domCache.content.isConnected) {
        _domCache.content = document.getElementById('chat-manager-content');
    }
    return _domCache.content;
}

function _getStatus() {
    if (!_domCache.status || !_domCache.status.isConnected) {
        _domCache.status = document.getElementById('chat-manager-status');
    }
    return _domCache.status;
}

function _getSearchInput() {
    if (!_domCache.searchInput || !_domCache.searchInput.isConnected) {
        _domCache.searchInput = document.getElementById('chat-manager-search');
    }
    return _domCache.searchInput;
}

function _invalidateDomCache() {
    _domCache.searchWrapper = null;
    _domCache.filterToolbar = null;
    _domCache.content = null;
    _domCache.status = null;
    _domCache.searchInput = null;
}

export function resetSearchState() {
    cancelSearchRefresh();
    searchPageAbort?.abort();
    searchPageAbort = null;
    latestSearchRequestId += 1;
    searchState = null;
    setSearchModeBadge('keyword');
}

export function isTimelineActive() {
    return timelineActive;
}

export function isSemanticMapActive() {
    return semanticMapActive;
}

export function isStatsActive() {
    return statsActive;
}

export function isBranchContextActive() {
    return branchContextActive;
}

function isAnyViewActive() {
    return timelineActive || semanticMapActive || graphViewActive || statsActive;
}

function canSemanticSearch() {
    const settings = getEmbeddingSettings();
    return isEmbeddingLevelOn(settings, 'message')
        && isEmbeddingLevelOn(settings, 'query')
        && isEmbeddingConfigured();
}

function ensureSearchModeBadge() {
    const row = document.querySelector('.chat-manager-search-row');
    if (!row) return null;

    let badge = row.querySelector('.chat-manager-search-mode-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'chat-manager-search-mode-badge';
        badge.textContent = 'Keyword';
        badge.addEventListener('click', onSearchModeBadgeClick);
        row.appendChild(badge);
    }
    return badge;
}

function onSearchModeBadgeClick() {
    if (!canSemanticSearch()) return;
    // Cycle: null (auto) → 'keyword' → 'semantic' → null
    if (searchModeOverride === null) searchModeOverride = 'keyword';
    else if (searchModeOverride === 'keyword') searchModeOverride = 'semantic';
    else searchModeOverride = null;

    // Re-run current search with the new mode
    const input = document.getElementById('chat-manager-search');
    const query = input?.value?.trim() || '';
    updateSearchModeBadgeDisplay();
    if (query.length >= 2) performSearch(query);
}

function updateSearchModeBadgeDisplay() {
    const badge = ensureSearchModeBadge();
    if (!badge) return;
    const available = canSemanticSearch();
    badge.classList.toggle('clickable', available);

    if (searchModeOverride === 'semantic') {
        badge.textContent = 'Semantic';
        badge.classList.add('semantic');
        badge.classList.remove('forced-keyword');
        badge.title = 'Forced semantic — click to cycle (Auto)';
    } else if (searchModeOverride === 'keyword') {
        badge.textContent = 'Keyword';
        badge.classList.remove('semantic');
        badge.classList.add('forced-keyword');
        badge.title = 'Forced keyword — click to cycle (Semantic)';
    } else {
        // auto — show what would actually be used
        badge.classList.remove('forced-keyword');
        badge.title = available ? 'Auto — click to force Keyword' : 'Semantic search unavailable';
    }
}

function setSearchModeBadge(mode) {
    const badge = ensureSearchModeBadge();
    if (!badge) return;
    // If override is active, updateSearchModeBadgeDisplay handles text/style
    if (searchModeOverride !== null) {
        updateSearchModeBadgeDisplay();
        return;
    }
    const semantic = mode === 'semantic';
    badge.textContent = semantic ? 'Semantic' : 'Keyword';
    badge.classList.toggle('semantic', semantic);
    badge.classList.remove('forced-keyword');
    updateSearchModeBadgeDisplay();
}

function hasMessageEmbeddings() {
    const entries = Object.values(getIndex());
    return entries.some(entry => (entry.messageEmbeddings instanceof Map && entry.messageEmbeddings.size > 0) || entry.cachedMessageEmbeddingKeys?.size > 0);
}

function isEmbeddingLevelOn(settings, level) {
    return settings.enabled === true && settings.embeddingLevels?.[level] === true;
}

function getVisibleEntryFileNames() {
    const filterState = getFilterState();
    const sortState = getSortState();
    return getFilteredSortedEntries(filterState, sortState, getChatMeta).map(entry => entry.fileName);
}

/**
 * Re-render whichever results view is currently active after a filter change.
 * The graph view honors the same date/tag filters as the list; its scope
 * provider (installed in toggleGraphView) re-reads the filter on each refresh,
 * so here we only need to trigger the re-collect and refresh the toolbar state.
 */
function refreshAfterFilterChange() {
    if (graphViewActive) {
        if (isGraphViewMounted()) updateGraphViewData();
        ensureFilterToolbar();
        return;
    }
    renderThreadCards();
}

/**
 * Live scope provider for the graph view: the set of fileNames matching the
 * current filter, or null when no filter is active (so the unfiltered graph
 * keeps showing every thread, including ones not present in the list).
 * Evaluated fresh on every graph re-collect — never a stale snapshot.
 */
function currentGraphScope() {
    return hasActiveFilter() ? new Set(getVisibleEntryFileNames()) : null;
}

function getScopeFilteredEntries(entries, settings) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    if (settings.scopeMode !== 'selected') return entries;

    const selected = new Set(getSelectedEmbeddingChats());
    if (selected.size === 0) return [];
    return entries.filter(entry => entry && selected.has(entry.fileName));
}

function updateEmbeddingSelectionControls(toolbar = null) {
    const root = toolbar || _getFilterToolbar();
    if (!root) return;

    const selectVisibleBtn = root.querySelector('.chat-manager-emb-select-visible-btn');
    const clearVisibleBtn = root.querySelector('.chat-manager-emb-clear-visible-btn');
    if (!selectVisibleBtn || !clearVisibleBtn) return;

    const settings = getEmbeddingSettings();
    const selectedScope = settings.scopeMode === 'selected';
    const visibleFiles = getVisibleEntryFileNames();
    const selectedSet = new Set(getSelectedEmbeddingChats());
    const selectedVisible = visibleFiles.filter(fileName => selectedSet.has(fileName)).length;

    selectVisibleBtn.style.display = selectedScope ? '' : 'none';
    clearVisibleBtn.style.display = selectedScope ? '' : 'none';
    selectVisibleBtn.disabled = !selectedScope || visibleFiles.length === 0;
    clearVisibleBtn.disabled = !selectedScope || selectedVisible === 0;
    selectVisibleBtn.title = `Select ${visibleFiles.length} matching chat${visibleFiles.length !== 1 ? 's' : ''} for embedding scope`;
    clearVisibleBtn.title = `Clear ${selectedVisible} selected matching chat${selectedVisible !== 1 ? 's' : ''}`;

    const triggerBtn = root.querySelector('.chat-manager-emb-trigger-btn');
    if (triggerBtn) {
        const chatOn = isEmbeddingLevelOn(settings, 'chat');
        const msgOn = isEmbeddingLevelOn(settings, 'message');
        const embEnabled = settings.enabled && (chatOn || msgOn);

        if (!embEnabled) {
            triggerBtn.style.display = 'none';
        } else {
            triggerBtn.style.display = '';
            const targetFiles = selectedScope ? getSelectedEmbeddingChats() : visibleFiles;
            const needWork = targetFiles.filter(f => threadNeedsEmbeddings(f));
            triggerBtn.textContent = selectedScope ? 'Embed Selected' : 'Embed Matching';
            triggerBtn.disabled = needWork.length === 0;
            triggerBtn.title = needWork.length > 0
                ? `Generate embeddings for ${needWork.length} thread${needWork.length !== 1 ? 's' : ''}`
                : 'All target threads are fully embedded';
        }
    }
}

function shouldUseSemanticSearch(query) {
    if (searchModeOverride === 'keyword') return false;
    if (searchModeOverride === 'semantic') {
        return canSemanticSearch() && query && query.length >= HYBRID_SEARCH_MIN_CHARS;
    }
    // Auto mode
    if (!query || query.length < HYBRID_SEARCH_MIN_CHARS) return false;
    return canSemanticSearch();
}

function getCurrentClusterCount() {
    const labels = new Set();
    for (const entry of Object.values(getIndex())) {
        if (Number.isFinite(entry.clusterLabel)) {
            labels.add(Math.floor(entry.clusterLabel));
        }
    }
    return labels.size;
}

function clearReclusterTimer() {
    if (reclusterIdleTimer) {
        clearTimeout(reclusterIdleTimer);
        reclusterIdleTimer = null;
    }
}

function shouldRedetectK(chatCount) {
    if (!Number.isFinite(lastClusterK) || lastClusterK < 1) return true;
    if (!Number.isFinite(lastClusterChatCount) || lastClusterChatCount < 1) return true;
    const delta = Math.abs(chatCount - lastClusterChatCount) / Math.max(lastClusterChatCount, 1);
    return delta > RECLUSTER_CHAT_DELTA_RATIO;
}

async function runDebouncedRecluster() {
    clearReclusterTimer();
    const index = getIndex();
    const chatCount = Object.values(index).filter(entry => hasChatEmbedding(entry) || entry.cachedChatEmbeddingHash).length;
    const reuseK = !shouldRedetectK(chatCount);
    const fixedK = reuseK ? lastClusterK : null;

    let result;
    try { result = await recomputeEmbeddingClusters({ fixedK }); } catch (error) {
        if (error?.name !== 'AbortError' && !isStaleEmbeddingOperationError(error)) console.warn(`[${MODULE_NAME}] Clustering failed:`, error);
        return;
    }
    pendingClusterChanges = 0;
    lastClusterResult = result.clusterCount;
    refreshAfterEmbeddingUpdate();
}

function scheduleDebouncedRecluster(changedCount) {
    if (!Number.isFinite(changedCount) || changedCount <= 0) return false;
    pendingClusterChanges += changedCount;

    if (pendingClusterChanges >= RECLUSTER_IMMEDIATE_THRESHOLD) {
        runDebouncedRecluster();
        return true;
    }

    clearReclusterTimer();
    reclusterIdleTimer = setTimeout(() => {
        reclusterIdleTimer = null;
        runDebouncedRecluster();
    }, RECLUSTER_IDLE_MS);
    return false;
}

function driftCacheToken(entry) {
    return `${captureEmbeddingOperation().epoch}:${entry.cachedMessageEmbeddingKeys?.size || 0}`;
}

function getDriftSummary(entry) {
    if (!entry?.isLoaded || entry.needsHydration || (entry.messages?.length || 0) < 2) return null;
    if (!isEmbeddingLevelOn(getEmbeddingSettings(), 'message')) return null;
    const token = driftCacheToken(entry);
    const cached = driftSummaryCache.get(entry);
    if (cached?.token === token) {
        if (pendingDriftFiles.has(entry.fileName) && panelOpen && !isAnyViewActive() && !driftWorkTimer && !driftWorkController) {
            driftWorkTimer = setTimeout(() => { driftWorkTimer = null; void refreshDriftSummaries(); }, 80);
        }
        return cached.value;
    }
    if (!panelOpen || isAnyViewActive()) return null;
    driftSummaryCache.set(entry, { token, value: null });
    pendingDriftFiles.add(entry.fileName);
    if (!driftWorkTimer && !driftWorkController) {
        driftWorkTimer = setTimeout(() => {
            driftWorkTimer = null;
            void refreshDriftSummaries();
        }, 80);
    }
    return null;
}

function cancelDriftWork() {
    if (driftWorkTimer) clearTimeout(driftWorkTimer);
    driftWorkTimer = null;
    driftWorkController?.abort();
    driftWorkController = null;
    pendingDriftFiles.clear();
    driftSummaryCache = new WeakMap();
}

function patchDriftBadge(fileName, summary) {
    const card = _getContent()?.querySelector(`.chat-manager-card[data-filename="${CSS.escape(fileName)}"]`);
    const meta = card?.querySelector('.chat-manager-card-meta');
    if (!meta) return;
    meta.querySelector('.chat-manager-drift-jump')?.remove();
    if (!summary) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-manager-drift-jump';
    button.dataset.filename = fileName;
    button.dataset.msgIndex = String(summary.firstMsgIndex);
    button.title = `Topic shifts near messages: ${summary.positions.join(', ')}`;
    button.textContent = `${summary.count} topic shift${summary.count !== 1 ? 's' : ''}`;
    button.addEventListener('click', handleJumpToGraphMessage);
    meta.appendChild(button);
}

async function refreshDriftSummaries() {
    if (driftWorkController || !panelOpen || isAnyViewActive()) return;
    const controller = new AbortController();
    driftWorkController = controller;
    try {
        while (pendingDriftFiles.size && panelOpen && !isAnyViewActive() && !controller.signal.aborted) {
            const fileName = pendingDriftFiles.values().next().value;
            pendingDriftFiles.delete(fileName);
            const entry = getIndex()[fileName];
            if (!entry || entry.needsHydration) continue;
            const token = driftCacheToken(entry);
            try {
                const value = await computeArchiveDriftSummary(fileName, { signal: controller.signal });
                if (controller.signal.aborted || !panelOpen || getIndex()[fileName] !== entry || driftCacheToken(entry) !== token) continue;
                driftSummaryCache.set(entry, { token, value });
                if (!isAnyViewActive()) patchDriftBadge(fileName, value);
            } catch (error) {
                driftSummaryCache.delete(entry);
                if (error?.name !== 'AbortError' && !isStaleEmbeddingOperationError(error)) console.warn(`[${MODULE_NAME}] Topic shift scan failed:`, error);
            }
        }
    } finally {
        if (driftWorkController === controller) driftWorkController = null;
    }
}

function queueEmbeddingRun(task) {
    const previous = embedRunPromise || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(task);

    const tracked = next.finally(() => {
        if (embedRunPromise === tracked) {
            embedRunPromise = null;
        }
    });
    embedRunPromise = tracked;

    return tracked;
}

export function isEmbeddingRunPending() {
    return embedRunPromise !== null;
}

function getEmbeddingOption(settings, key, fallback) {
    const value = settings?.[key];
    if (typeof fallback === 'boolean') {
        return typeof value === 'boolean' ? value : fallback;
    }
    if (typeof fallback === 'number') {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : fallback;
    }
    return value ?? fallback;
}

function clampPositiveInt(value, fallback) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.max(1, Math.floor(numeric));
}

function deferAutomaticRun(targetFileNames, options) {
    if (!options.automatic) return;
    if (options.incremental) {
        for (const fileName of targetFileNames || []) pendingIncrementalEmbedFiles.add(fileName);
    } else {
        deferredBootstrapRequested = true;
        deferredBootstrapFile = options.activeFileName || deferredBootstrapFile;
    }
}

function hasChatEmbedding(entry) {
    return isVector(entry?.chatEmbedding) && entry.chatEmbedding.length > 0;
}

function hasStoredChatEmbedding(entry) {
    const text = getRepresentativeEmbeddingText(entry);
    if (!text) return true;
    const hash = hashEmbeddingText(text);
    return (hasChatEmbedding(entry) && entry.chatEmbeddingHash === hash) || entry.cachedChatEmbeddingHash === hash;
}

function hasMessageEmbeddingsForAllTextMessages(entry, settings = getEmbeddingSettings()) {
    if (!entry?.isLoaded || !Array.isArray(entry.messages) || !entry.messages.length) return false;
    const known = entry.cachedMessageEmbeddingKeys;
    for (const msg of entry.messages) {
        const active = getMessageActiveSwipeIndex(msg);
        const variants = [];
        if (msg.isDescriptor ? msg.textLength > 0 : typeof msg.text === 'string' && msg.text.trim()) variants.push(active);
        if (settings.includeAlternateSwipes === true) {
            const count = Math.min(msg.swipeCount ?? msg.swipes?.length ?? 0, clampPositiveInt(settings.maxSwipesPerMessage, 8));
            for (let swipe = 0; swipe < count; swipe++) {
                if (swipe === active) continue;
                if (msg.isDescriptor ? msg.swipeLengths?.[swipe] > 0 : typeof msg.swipes?.[swipe] === 'string' && msg.swipes[swipe].trim()) variants.push(swipe);
            }
        }
        for (const swipe of variants) {
            if (known?.has(makeMessageEmbeddingKey(msg.index, swipe))) continue;
            const vector = getMessageEmbedding(entry, msg, swipe);
            if (!isVector(vector) || !vector.length) return false;
        }
    }
    return true;
}

function threadNeedsEmbeddings(fileName) {
    if (!fileName) return false;
    const entry = getIndex()[fileName];
    if (!entry) return false;

    const settings = getEmbeddingSettings();
    const chatLevelEnabled = isEmbeddingLevelOn(settings, 'chat');
    const messageLevelEnabled = isEmbeddingLevelOn(settings, 'message');
    if (!chatLevelEnabled && !messageLevelEnabled) return false;

    if (chatLevelEnabled && !hasStoredChatEmbedding(entry)) return true;
    if (messageLevelEnabled && !hasMessageEmbeddingsForAllTextMessages(entry)) return true;
    return false;
}

function getEmbeddingStatus(entry) {
    const settings = getEmbeddingSettings();
    const chatOn = isEmbeddingLevelOn(settings, 'chat');
    const msgOn = isEmbeddingLevelOn(settings, 'message');
    if (!chatOn && !msgOn) return 'disabled';
    if (!entry?.isLoaded || entry.needsHydration) return 'unknown';

    let enabledCount = 0;
    let satisfiedCount = 0;

    if (chatOn) {
        enabledCount++;
        if (hasStoredChatEmbedding(entry)) satisfiedCount++;
    }
    if (msgOn) {
        enabledCount++;
        if (hasMessageEmbeddingsForAllTextMessages(entry)) satisfiedCount++;
    }

    if (satisfiedCount === enabledCount) return 'full';
    if (satisfiedCount > 0) return 'partial';

    // Check for any partial message embeddings
    if (msgOn && ((entry.messageEmbeddings instanceof Map && entry.messageEmbeddings.size > 0) || entry.cachedMessageEmbeddingKeys?.size > 0)) return 'partial';

    return 'none';
}

function embStatusTitle(status) {
    switch (status) {
        case 'full': return 'Fully embedded';
        case 'partial': return 'Partially embedded';
        case 'none': return 'Not embedded';
        default: return '';
    }
}

function getClusterInputs() {
    const index = getIndex();
    const entries = Object.values(index);
    const embeddedEntries = entries.filter(entry => isVector(entry.chatEmbedding) && entry.chatEmbedding.length > 0);
    const signature = embeddedEntries.map(entry => {
        const vector = entry.chatEmbedding;
        if (!clusterVectorIds.has(vector)) clusterVectorIds.set(vector, nextClusterInputId++);
        let vectorHashA = 0x811c9dc5;
        let vectorHashB = 0x9e3779b1;
        const bits = new DataView(new ArrayBuffer(8));
        for (let i = 0; i < vector.length; i++) {
            bits.setFloat64(0, Number(vector[i]), true);
            const low = bits.getUint32(0, true);
            const high = bits.getUint32(4, true);
            vectorHashA = Math.imul(vectorHashA ^ low, 0x01000193);
            vectorHashA = Math.imul(vectorHashA ^ high, 0x01000193);
            vectorHashB = Math.imul(vectorHashB ^ high, 0x85ebca6b);
            vectorHashB = Math.imul(vectorHashB ^ low, 0xc2b2ae35);
        }
        return `${hashEmbeddingText(entry.fileName || '')}:${clusterVectorIds.get(vector)}:${vector.length}:${vectorHashA >>> 0}:${vectorHashB >>> 0}`;
    }).join('\u0001');
    return { entries, embeddedEntries, signature };
}

async function computeClusterLabels(vectors, fixedK) {
    let k = Number.isFinite(fixedK) && fixedK > 0
        ? Math.floor(fixedK)
        : await findOptimalKAsync(vectors, 8);
    if (!Number.isFinite(k) || k < 1) {
        k = Math.min(5, Math.ceil(vectors.length / 3));
    }
    k = Math.max(1, Math.min(Math.floor(k), vectors.length));
    const { labels } = await kMeansAsync(vectors, k, 50);
    return { labels, k };
}

async function recomputeArchiveEmbeddingClusters(entries, options) {
    const operation = captureEmbeddingOperation();
    const fixedK = Number.isFinite(options.fixedK) && options.fixedK > 0 ? Math.floor(options.fixedK) : null;
    const signature = entries.map(entry => `${entry.fileName}:${hashEmbeddingText(getRepresentativeEmbeddingText(entry))}:${entry.cachedChatEmbeddingHash || entry.chatEmbeddingHash || ''}`).join('\u0001');
    const version = getIndexVersion();
    const key = `archive:${operation.epoch}:${version}:${fixedK ?? 'auto'}:${signature}`;
    let result = clusterResultCache?.key === key ? clusterResultCache : null;
    const cached = Boolean(result);
    if (!result) {
        let computation = clusterComputationsInFlight.get(key);
        if (!computation) {
            computation = computeArchiveClusters({ fileNames: entries.map(entry => entry.fileName), fixedK, embeddingOperation: operation });
            clusterComputationsInFlight.set(key, computation);
            computation.finally(() => {
                if (clusterComputationsInFlight.get(key) === computation) clusterComputationsInFlight.delete(key);
            }).catch(() => {});
        }
        result = await computation;
        if (!isEmbeddingOperationCurrent(operation) || getIndexVersion() !== version) throw new DOMException('Embedding or chat content changed', 'AbortError');
        clusterResultCache = { ...result, key, kind: 'archive' };
    }
    for (const entry of Object.values(getIndex())) entry.clusterLabel = result.labelsByFile.get(entry.fileName) ?? null;
    lastClusterK = result.k;
    lastClusterChatCount = result.embeddedCount;
    return { clusterCount: result.clusterCount, k: result.k, embeddedCount: result.embeddedCount, ...(cached ? { cached: true } : {}) };
}

export async function recomputeEmbeddingClusters(options = {}) {
    const archiveEntries = Object.values(getIndex());
    if (clusterResultCache?.kind === 'archive' || archiveEntries.some(entry => entry.cachedChatEmbeddingHash && !hasChatEmbedding(entry))) {
        return recomputeArchiveEmbeddingClusters(archiveEntries, options);
    }
    const { entries, embeddedEntries, signature } = getClusterInputs();
    const fixedK = Number.isFinite(options.fixedK) && options.fixedK > 0 ? Math.floor(options.fixedK) : null;
    const cacheKey = `${signature}\u0002${fixedK ?? 'auto'}`;

    if (clusterResultCache?.key === cacheKey) {
        for (const entry of entries) entry.clusterLabel = null;
        for (let i = 0; i < embeddedEntries.length; i++) {
            embeddedEntries[i].clusterLabel = clusterResultCache.labels[i] ?? 0;
        }
        lastClusterK = clusterResultCache.k;
        lastClusterChatCount = embeddedEntries.length;
        return { clusterCount: clusterResultCache.clusterCount, k: clusterResultCache.k, embeddedCount: embeddedEntries.length, cached: true };
    }

    if (embeddedEntries.length === 0) {
        for (const entry of entries) entry.clusterLabel = null;
        clusterResultCache = { key: cacheKey, labels: [], clusterCount: 0, k: null };
        lastClusterK = null;
        lastClusterChatCount = 0;
        return { clusterCount: 0, k: null, embeddedCount: 0 };
    }
    if (embeddedEntries.length === 1) {
        for (const entry of entries) entry.clusterLabel = null;
        embeddedEntries[0].clusterLabel = 0;
        clusterResultCache = { key: cacheKey, labels: [0], clusterCount: 1, k: 1 };
        lastClusterK = 1;
        lastClusterChatCount = 1;
        return { clusterCount: 1, k: 1, embeddedCount: 1 };
    }

    const computationKey = cacheKey;
    let computation = clusterComputationsInFlight.get(computationKey);
    if (!computation) {
        computation = computeClusterLabels(embeddedEntries.map(entry => entry.chatEmbedding), fixedK);
        clusterComputationsInFlight.set(computationKey, computation);
        computation.finally(() => {
            if (clusterComputationsInFlight.get(computationKey) === computation) clusterComputationsInFlight.delete(computationKey);
        }).catch(() => {});
    }
    const { labels, k } = await computation;
    const currentInputs = getClusterInputs();
    if (currentInputs.signature !== signature) {
        return recomputeEmbeddingClusters(options);
    }

    for (const entry of currentInputs.entries) entry.clusterLabel = null;
    for (let i = 0; i < currentInputs.embeddedEntries.length; i++) {
        currentInputs.embeddedEntries[i].clusterLabel = labels[i] ?? 0;
    }

    const clusterCount = new Set(labels).size;
    clusterResultCache = { key: cacheKey, labels: [...labels], clusterCount, k };
    lastClusterK = k;
    lastClusterChatCount = embeddedEntries.length;
    return { clusterCount, k, embeddedCount: embeddedEntries.length };
}

function refreshAfterEmbeddingUpdate() {
    if (!panelOpen) return;

    if (statsActive) {
        if (isStatsMounted()) updateStatsView();
        return;
    }

    if (timelineActive) {
        if (isIcicleMounted()) {
            updateIcicleData();
        }
        return;
    }

    if (semanticMapActive) {
        if (isSemanticMapMounted()) {
            updateSemanticMapData();
        }
        return;
    }

    if (graphViewActive) {
        if (isGraphViewMounted()) {
            updateGraphViewData();
        }
        return;
    }

    const query = getCurrentSearchQuery();
    if (query.length >= 2) {
        performSearch(query);
    } else {
        renderThreadCards();
    }
}

const staleEmbeddingRun = Symbol('stale embedding run');

function requireCurrentEmbeddingRun(operation, entry = null) {
    if (!isEmbeddingOperationCurrent(operation) || (entry && getIndex()[entry.fileName] !== entry)) {
        throw staleEmbeddingRun;
    }
}

/** Queue only file identifiers. Text and vectors are read in bounded batches on demand. */
function queueBackgroundSwipeCandidates(candidates, settings, operation) {
    for (const candidate of candidates || []) {
        const fileName = typeof candidate === 'string' ? candidate : candidate?.entry?.fileName;
        if (fileName) pendingBackgroundSwipeCandidates.set(fileName, { fileName, operation });
    }
    if (pendingBackgroundSwipeCandidates.size && !generationActive) scheduleBackgroundSwipeEmbeddings(settings);
}

function scheduleBackgroundSwipeEmbeddings(settings) {
    if (generationActive) return;
    const delayMs = clampPositiveInt(getEmbeddingOption(settings, 'swipeBackgroundDelayMs', SWIPE_BACKGROUND_EMBED_DELAY_MS), SWIPE_BACKGROUND_EMBED_DELAY_MS);
    if (backgroundSwipeEmbedTimer) clearTimeout(backgroundSwipeEmbedTimer);
    backgroundSwipeEmbedTimer = setTimeout(() => {
        backgroundSwipeEmbedTimer = null;
        void queueEmbeddingRun(() => flushBackgroundSwipeEmbeddings(settings, true)).catch((err) => {
            if (isStaleEmbeddingOperationError(err) && err.reason === 'dimensions') clearInMemoryEmbeddings({ rerender: true });
            if (err === staleEmbeddingRun || isStaleEmbeddingOperationError(err) || err?.name === 'AbortError') return;
            console.warn(`[${MODULE_NAME}] Background swipe embedding failed:`, err);
        });
    }, delayMs);
}

/** Restore/generate at most one input batch, releasing it before the next read. */
async function processEmbeddingCandidateBatch(candidates, level, operation, options = {}) {
    if (!candidates.length) return { applied: 0, changed: 0, deferred: false };
    if (options.shouldDefer?.()) return { applied: 0, changed: 0, deferred: true };
    const cached = await getCachedEmbeddingsForTexts(candidates.map(item => item.text));
    requireCurrentEmbeddingRun(operation);
    let applied = 0;
    let changed = 0;
    const apply = (item, vector) => {
        requireCurrentEmbeddingRun(operation, item.entry);
        if (!isVector(vector) || !vector.length) return;
        if (level === 'chat') {
            const previousHash = item.entry.chatEmbeddingHash || item.entry.cachedChatEmbeddingHash;
            setChatEmbedding(item.entry, vector, item.hash);
            if (previousHash !== item.hash) changed++;
        } else {
            setMessageEmbedding(item.entry, item.msgIndex, item.swipeIndex, vector);
        }
        applied++;
        options.onApplied?.();
    };
    const pending = [];
    for (let index = 0; index < candidates.length; index++) {
        if (isVector(cached[index]) && cached[index].length) apply(candidates[index], cached[index]);
        else pending.push(candidates[index]);
    }
    if (options.shouldDefer?.()) return { applied, changed, deferred: true };
    if (pending.length && !options.cacheOnly) {
        // Both the candidate count and aggregate text length are bounded by the
        // source iterator. The provider persists each sub-batch before returning.
        const vectors = await embedTexts(pending.map(item => item.text), { level });
        for (let index = 0; index < pending.length; index++) apply(pending[index], vectors[index]);
    }
    return { applied, changed, deferred: false };
}

async function flushBackgroundSwipeEmbeddings(settings, rerender = false) {
    if (backgroundSwipeEmbedActive || generationActive || !pendingBackgroundSwipeCandidates.size) return;
    backgroundSwipeEmbedActive = true;
    const batchSize = Math.min(50, clampPositiveInt(getEmbeddingOption(settings, 'swipeBackgroundBatchSize', 24), 24));
    try {
        while (pendingBackgroundSwipeCandidates.size && !generationActive) {
            const [task] = takeMapBatch(pendingBackgroundSwipeCandidates, 1);
            if (!isEmbeddingOperationCurrent(task.operation) || !getIndex()[task.fileName]) continue;
            for await (const items of iterateVariantBatches({ fileNames: [task.fileName], settings, mode: 'alternate', batchSize })) {
                requireCurrentEmbeddingRun(task.operation);
                const batch = items.filter(item => !isVector(getMessageEmbedding(item.entry, { index: item.msgIndex, swipeId: item.activeSwipeIndex }, item.swipeIndex)))
                    .map(item => ({ ...item, text: item.text.trim() }));
                const result = await processEmbeddingCandidateBatch(batch, 'message', task.operation, { shouldDefer: () => generationActive });
                if (result.deferred || generationActive) {
                    pendingBackgroundSwipeCandidates.set(task.fileName, task);
                    break;
                }
            }
        }
    } finally {
        backgroundSwipeEmbedActive = false;
        if (pendingBackgroundSwipeCandidates.size && !backgroundSwipeEmbedTimer && !generationActive) scheduleBackgroundSwipeEmbeddings(getEmbeddingSettings());
        if (rerender) refreshAfterEmbeddingUpdate();
    }
}

export function takeMapBatch(map, batchSize) {
    const batch = [];
    const iterator = map.entries();
    while (batch.length < batchSize) {
        const next = iterator.next();
        if (next.done) break;
        const [key, value] = next.value;
        map.delete(key);
        batch.push(value);
    }
    return batch;
}

async function runEmbeddingGeneration(targetFileNames = null, options = {}) {
    try {
        return await runEmbeddingGenerationWork(targetFileNames, options);
    } catch (error) {
        if (error !== staleEmbeddingRun && !isStaleEmbeddingOperationError(error) && error?.name !== 'AbortError') throw error;
        if (isStaleEmbeddingOperationError(error) && error.reason === 'dimensions') {
            clearInMemoryEmbeddings({ rerender: false });
            if (!options.dimensionRetry) {
                return runEmbeddingGeneration(targetFileNames, { ...options, dimensionRetry: true });
            }
        }
        return { updated: 0, total: 0, clusters: getCurrentClusterCount(), skipped: true, superseded: true, messageVectors: 0, queuedSwipeVectors: 0 };
    }
}

async function runEmbeddingGenerationWork(targetFileNames = null, options = {}) {
    if (options.automatic && generationActive) {
        deferAutomaticRun(targetFileNames, options);
        return { updated: 0, total: 0, clusters: getCurrentClusterCount(), skipped: true, deferred: true, messageVectors: 0, queuedSwipeVectors: 0 };
    }
    const operation = captureEmbeddingOperation();
    const settings = operation.settings;
    if (settings.includeAlternateSwipes !== true) {
        pendingBackgroundSwipeCandidates.clear();
        if (backgroundSwipeEmbedTimer) {
            clearTimeout(backgroundSwipeEmbedTimer);
            backgroundSwipeEmbedTimer = null;
        }
    }
    if (!settings.enabled) {
        return { updated: 0, total: 0, clusters: 0, skipped: true, messageVectors: 0, queuedSwipeVectors: 0 };
    }
    const chatLevelEnabled = isEmbeddingLevelOn(settings, 'chat');
    const messageLevelEnabled = isEmbeddingLevelOn(settings, 'message');
    if (!chatLevelEnabled && !messageLevelEnabled) {
        return { updated: 0, total: 0, clusters: getCurrentClusterCount(), skipped: true, messageVectors: 0, queuedSwipeVectors: 0 };
    }

    if (!isEmbeddingConfigured()) {
        if (!options.silent) {
            throw new Error('Embeddings are not fully configured. Set provider, model, and API key if required.');
        }
        return { updated: 0, total: 0, clusters: 0, skipped: true, messageVectors: 0, queuedSwipeVectors: 0 };
    }

    if (options.ensureIndex && Object.keys(getIndex()).length === 0) {
        // Automatic runs only restore cached vectors for chats already known here.
        // They must not download a character's archive at page load or on a switch.
        await buildIndex(null, null, { backgroundHydration: !options.automatic });
    }

    requireCurrentEmbeddingRun(operation);
    const index = getIndex();
    const sourceEntries = Array.isArray(targetFileNames) && targetFileNames.length > 0
        ? targetFileNames.map(fileName => index[fileName]).filter(Boolean)
        : Object.values(index);
    const scopedEntries = options.ignoreScope ? sourceEntries : getScopeFilteredEntries(sourceEntries, settings);

    const messageEntries = Array.isArray(options.messageTargetFileNames)
        ? scopedEntries.filter(entry => options.messageTargetFileNames.includes(entry.fileName))
        : scopedEntries;
    const eligible = entry => entry && (!options.automatic || (entry.isLoaded && !entry.needsHydration));
    const messageFiles = messageEntries.filter(eligible).map(entry => entry.fileName);
    const chatEntries = chatLevelEnabled ? scopedEntries.filter(eligible) : [];
    const totalEstimate = chatEntries.length + (messageLevelEnabled && options.restoreMessageVectors !== false
        ? messageEntries.reduce((sum, entry) => sum + Math.min(entry.messageCount || entry.messages?.length || 0, options.messageWindowLimit || Infinity), 0) : 0);
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const cacheOnly = options.cacheOnly === true;
    let completed = 0;
    let changedChatEmbeddings = 0;
    let chatVectors = 0;
    let messageVectors = 0;
    let deferred = false;
    onProgress?.(0, totalEstimate);
    const batchOptions = {
        cacheOnly,
        shouldDefer: options.automatic ? () => generationActive : null,
        onApplied: () => { completed++; onProgress?.(completed, Math.max(completed, totalEstimate)); },
    };

    // Chat summaries are small, but the number of chats is unbounded. Do not
    // retain an all-archive pending-text or result-vector array.
    let chatBatch = [];
    let chatChars = 0;
    const flushChats = async () => {
        const result = await processEmbeddingCandidateBatch(chatBatch, 'chat', operation, batchOptions);
        chatVectors += result.applied;
        changedChatEmbeddings += result.changed;
        deferred = result.deferred;
        chatBatch = [];
        chatChars = 0;
    };
    for (const originalEntry of chatEntries) {
        let entry = getIndex()[originalEntry.fileName];
        if (!entry) continue;
        if (!entry.isLoaded || entry.needsHydration) {
            await readChatMessages(entry.fileName);
            entry = getIndex()[entry.fileName];
        }
        requireCurrentEmbeddingRun(operation, entry);
        const text = getRepresentativeEmbeddingText(entry);
        if (!text) continue;
        const hash = hashEmbeddingText(text);
        if (hasChatEmbedding(entry) && entry.chatEmbeddingHash === hash) continue;
        if (chatBatch.length && (chatBatch.length >= 50 || chatChars + text.length > 262144)) {
            await flushChats();
            if (deferred) break;
        }
        chatBatch.push({ entry, text, hash });
        chatChars += text.length;
    }
    if (!deferred && chatBatch.length) await flushChats();

    if (!deferred && messageLevelEnabled && options.restoreMessageVectors !== false && messageFiles.length) {
        for await (const items of iterateVariantBatches({ fileNames: messageFiles, settings, mode: 'active', messageWindowLimit: options.messageWindowLimit, batchSize: 50 })) {
            requireCurrentEmbeddingRun(operation);
            const candidates = [];
            for (const item of items) {
                requireCurrentEmbeddingRun(operation, item.entry);
                const existing = getMessageEmbedding(item.entry, { index: item.msgIndex, swipeId: item.activeSwipeIndex }, item.swipeIndex);
                if (isVector(existing) && existing.length) continue;
                candidates.push({ ...item, text: item.text.trim() });
            }
            const result = await processEmbeddingCandidateBatch(candidates, 'message', operation, batchOptions);
            messageVectors += result.applied;
            if (result.deferred) { deferred = true; break; }
        }
    }
    if (deferred) {
        deferAutomaticRun(targetFileNames, options);
        return { updated: chatVectors, total: chatVectors, clusters: getCurrentClusterCount(), skipped: false, deferred: true, messageVectors, queuedSwipeVectors: 0 };
    }

    let queuedSwipeVectors = 0;
    if (!cacheOnly && messageLevelEnabled && options.includeAlternateSwipes !== false && settings.includeAlternateSwipes === true) {
        requireCurrentEmbeddingRun(operation);
        const swipeFiles = [];
        for (const originalEntry of scopedEntries) {
            const entry = getIndex()[originalEntry.fileName];
            if (!entry?.isLoaded || entry.needsHydration) continue;
            let count = 0;
            for (const msg of entry.messages || []) {
                const active = getMessageActiveSwipeIndex(msg);
                const length = Math.min(msg.swipeCount ?? msg.swipes?.length ?? 0, clampPositiveInt(settings.maxSwipesPerMessage, 8));
                for (let swipe = 0; swipe < length; swipe++) {
                    if (swipe !== active && !isVector(getMessageEmbedding(entry, msg, swipe))) count++;
                }
            }
            if (count) swipeFiles.push(entry.fileName);
            queuedSwipeVectors += count;
        }
        queueBackgroundSwipeCandidates(swipeFiles, settings, operation);
    }

    requireCurrentEmbeddingRun(operation);
    queryEmbeddingCache.clear();
    queryEmbeddingInFlight.clear();
    queryEmbeddingEpoch++;
    let clusters = getCurrentClusterCount();
    let reclusterTriggered = false;
    if (options.incremental) {
        reclusterTriggered = scheduleDebouncedRecluster(changedChatEmbeddings);
        clusters = reclusterTriggered ? lastClusterResult : getCurrentClusterCount();
    } else {
        clearReclusterTimer();
        pendingClusterChanges = 0;
        const clusterResult = await recomputeEmbeddingClusters();
        clusters = clusterResult.clusterCount;
        lastClusterResult = clusters;
    }
    if (options.rerender !== false && !reclusterTriggered) refreshAfterEmbeddingUpdate();
    onProgress?.(completed, completed);
    return {
        updated: chatVectors, total: chatVectors, clusters,
        changedEmbeddings: changedChatEmbeddings, messageVectors, queuedSwipeVectors,
        skipped: completed === 0 && queuedSwipeVectors === 0,
    };
}

export async function generateEmbeddingsForCurrentIndex(options = {}) {
    return queueEmbeddingRun(() => runEmbeddingGeneration(null, {
        ensureIndex: true,
        rerender: true,
        silent: false,
        ...options,
    }));
}

export function clearInMemoryEmbeddings(options = {}) {
    invalidateEmbeddingOperations();
    const rerender = options.rerender !== false;
    clearReclusterTimer();
    if (backgroundSwipeEmbedTimer) {
        clearTimeout(backgroundSwipeEmbedTimer);
        backgroundSwipeEmbedTimer = null;
    }
    pendingBackgroundSwipeCandidates.clear();
    pendingClusterChanges = 0;
    lastClusterK = null;
    lastClusterChatCount = 0;
    lastClusterResult = 0;
    queryEmbeddingCache.clear();
    queryEmbeddingInFlight.clear();
    queryEmbeddingEpoch++;
    clusterResultCache = null;
    cancelDriftWork();

    clearResidentVectors();
    const index = getIndex();
    for (const entry of Object.values(index)) {
        entry.cachedMessageEmbeddingKeys = null;
        entry.cachedChatEmbeddingHash = null;
        entry.chatEmbedding = null;
        entry.chatEmbeddingHash = null;
        entry.clusterLabel = null;
        entry.messageEmbeddings = null;
    }
    invalidateIcicleEmbeddings();
    invalidateSemanticMapEmbeddings();
    invalidateGraphEmbeddings();

    if (rerender) {
        refreshAfterEmbeddingUpdate();
    }
}

export function scheduleEmbeddingBootstrap(activeFileName = null) {
    const settings = getEmbeddingSettings();
    if (!isEmbeddingLevelOn(settings, 'chat') && !isEmbeddingLevelOn(settings, 'message')) return;
    if (settings.scopeMode === 'selected' && getSelectedEmbeddingChats().length === 0) return;
    deferredBootstrapRequested = true;
    deferredBootstrapFile = activeFileName || deferredBootstrapFile;
    if (generationActive) return;

    if (embedBootstrapTimer) {
        clearTimeout(embedBootstrapTimer);
    }

    embedBootstrapTimer = setTimeout(() => {
        embedBootstrapTimer = null;
        deferredBootstrapRequested = false;
        deferredBootstrapFile = null;
        void queueEmbeddingRun(() => runEmbeddingGeneration(null, getAutomaticEmbeddingRunOptions(activeFileName, false))).catch((err) => {
            console.warn(`[${MODULE_NAME}] Embedding bootstrap failed:`, err);
        });
    }, 900);
}

export function scheduleIncrementalEmbedding(fileName) {
    const settings = getEmbeddingSettings();
    if (!isEmbeddingLevelOn(settings, 'chat') && !isEmbeddingLevelOn(settings, 'message')) return;
    if (!fileName) return;
    if (settings.scopeMode === 'selected' && !isEmbeddingChatSelected(fileName)) return;

    pendingIncrementalEmbedFiles.add(fileName);
    if (generationActive) return;
    if (embedIncrementalTimer) {
        clearTimeout(embedIncrementalTimer);
    }

    embedIncrementalTimer = setTimeout(() => {
        embedIncrementalTimer = null;
        const files = Array.from(pendingIncrementalEmbedFiles);
        pendingIncrementalEmbedFiles.clear();
        if (files.length === 0) return;

        void queueEmbeddingRun(() => runEmbeddingGeneration(files, getAutomaticEmbeddingRunOptions(null, true))).catch((err) => {
            console.warn(`[${MODULE_NAME}] Incremental embedding update failed:`, err);
        });
    }, EMBED_INCREMENTAL_DELAY_MS);
}

export function getAutomaticEmbeddingRunOptions(activeFileName, incremental) {
    return {
        ensureIndex: !incremental,
        rerender: true,
        silent: true,
        incremental: incremental === true,
        cacheOnly: incremental !== true,
        messageTargetFileNames: incremental ? undefined : (activeFileName ? [activeFileName] : []),
        messageWindowLimit: AUTOMATIC_MESSAGE_RESTORE_LIMIT,
        includeAlternateSwipes: false,
        automatic: true,
        activeFileName,
    };
}

export function setEmbeddingGenerationActive(active) {
    generationActive = active === true;
    if (generationActive) {
        if (embedBootstrapTimer) clearTimeout(embedBootstrapTimer);
        embedBootstrapTimer = null;
        if (embedIncrementalTimer) clearTimeout(embedIncrementalTimer);
        embedIncrementalTimer = null;
        if (backgroundSwipeEmbedTimer) clearTimeout(backgroundSwipeEmbedTimer);
        backgroundSwipeEmbedTimer = null;
        return;
    }
    if (pendingBackgroundSwipeCandidates.size) scheduleBackgroundSwipeEmbeddings(getEmbeddingSettings());
    const shouldBootstrap = deferredBootstrapRequested;
    const bootstrapFile = deferredBootstrapFile;
    deferredBootstrapFile = null;
    deferredBootstrapRequested = false;
    if (shouldBootstrap) scheduleEmbeddingBootstrap(bootstrapFile);
    if (pendingIncrementalEmbedFiles.size > 0) {
        const first = pendingIncrementalEmbedFiles.values().next().value;
        scheduleIncrementalEmbedding(first);
    }
}

export function onEmbeddingGenerationStarted(isDryRun) {
    if (isDryRun !== true) setEmbeddingGenerationActive(true);
}

function canEmbedNodeFromTimeline(chatFiles) {
    return Array.isArray(chatFiles) && chatFiles.some(f => threadNeedsEmbeddings(f));
}

async function handleTimelineEmbedNode(chatFiles, onProgress) {
    if (!Array.isArray(chatFiles) || chatFiles.length === 0) return null;

    const settings = getEmbeddingSettings();
    if (!settings.enabled) {
        toastr.info('Enable semantic embeddings in settings first.');
        return null;
    }

    if (settings.embeddingLevels?.chat !== true && settings.embeddingLevels?.message !== true) {
        toastr.info('Enable chat and/or message vector levels to generate embeddings.');
        return null;
    }

    if (!isEmbeddingConfigured()) {
        toastr.info('Configure provider/model settings before generating embeddings.');
        return null;
    }

    const filesToEmbed = chatFiles.filter(f => threadNeedsEmbeddings(f));
    if (filesToEmbed.length === 0) {
        return { skipped: true, updated: 0, total: 0, clusters: getCurrentClusterCount(), messageVectors: 0, queuedSwipeVectors: 0 };
    }

    toastr.info(`Generating embeddings for ${filesToEmbed.length} thread${filesToEmbed.length > 1 ? 's' : ''}…`);

    const result = await queueEmbeddingRun(() => runEmbeddingGeneration(filesToEmbed, {
        ensureIndex: false,
        rerender: true,
        silent: false,
        ignoreScope: true,
        onProgress,
    }));

    if (result?.superseded) {
        toastr.info('Embedding settings or chat content changed. Run embeddings again to use the current data.');
        return result;
    }
    const messagePart = Number.isFinite(result?.messageVectors) && result.messageVectors > 0
        ? `, ${result.messageVectors} messages`
        : '';
    const queuedSwipePart = Number.isFinite(result?.queuedSwipeVectors) && result.queuedSwipeVectors > 0
        ? `, ${result.queuedSwipeVectors} swipe variants queued`
        : '';
    toastr.success(`Embeddings updated for ${filesToEmbed.length} thread${filesToEmbed.length > 1 ? 's' : ''}${messagePart}${queuedSwipePart} (${result.clusters} clusters).`);
    return result;
}

async function handleEmbedSingleCard(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const filename = btn?.dataset?.filename;
    if (!filename) return;

    const settings = getEmbeddingSettings();
    if (!settings.enabled || (!isEmbeddingLevelOn(settings, 'chat') && !isEmbeddingLevelOn(settings, 'message'))) {
        toastr.info('Enable semantic embeddings and at least one vector level first.');
        return;
    }
    if (!isEmbeddingConfigured()) {
        toastr.info('Configure provider/model settings before generating embeddings.');
        return;
    }
    if (!threadNeedsEmbeddings(filename)) {
        toastr.info('This thread is already fully embedded.');
        return;
    }

    setActionBusy(btn, true);
    btn.classList.add('chat-manager-embedding-active');

    try {
        const result = await queueEmbeddingRun(() => runEmbeddingGeneration([filename], {
            ensureIndex: false,
            rerender: true,
            silent: false,
            ignoreScope: true,
        }));

        if (result?.superseded) {
            toastr.info('Embedding settings or chat content changed. Run embeddings again to use the current data.');
            return;
        }
        const messagePart = Number.isFinite(result?.messageVectors) && result.messageVectors > 0
            ? `, ${result.messageVectors} messages` : '';
        const queuedSwipePart = Number.isFinite(result?.queuedSwipeVectors) && result.queuedSwipeVectors > 0
            ? `, ${result.queuedSwipeVectors} swipe variants queued` : '';
        toastr.success(`Embeddings generated${messagePart}${queuedSwipePart} (${result.clusters} clusters).`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Per-card embedding failed:`, err);
        toastr.error(`Embedding failed: ${err.message || err}`);
    } finally {
        setActionBusy(btn, false);
        btn.classList.remove('chat-manager-embedding-active');
    }
}

async function handleToolbarEmbedTrigger() {
    const settings = getEmbeddingSettings();
    if (!settings.enabled || (!isEmbeddingLevelOn(settings, 'chat') && !isEmbeddingLevelOn(settings, 'message'))) {
        toastr.info('Enable semantic embeddings and at least one vector level first.');
        return;
    }
    if (!isEmbeddingConfigured()) {
        toastr.info('Configure provider/model settings before generating embeddings.');
        return;
    }

    const targetFiles = settings.scopeMode === 'selected'
        ? getSelectedEmbeddingChats()
        : getVisibleEntryFileNames();
    const filesToEmbed = targetFiles.filter(f => threadNeedsEmbeddings(f));

    if (filesToEmbed.length === 0) {
        toastr.info('All target threads are already fully embedded.');
        return;
    }

    toastr.info(`Generating embeddings for ${filesToEmbed.length} thread${filesToEmbed.length !== 1 ? 's' : ''}…`);

    try {
        const result = await queueEmbeddingRun(() => runEmbeddingGeneration(filesToEmbed, {
            ensureIndex: false,
            rerender: true,
            silent: false,
            ignoreScope: true,
        }));

        if (result?.superseded) {
            toastr.info('Embedding settings or chat content changed. Run embeddings again to use the current data.');
            return;
        }
        const messagePart = Number.isFinite(result?.messageVectors) && result.messageVectors > 0
            ? `, ${result.messageVectors} messages` : '';
        const queuedSwipePart = Number.isFinite(result?.queuedSwipeVectors) && result.queuedSwipeVectors > 0
            ? `, ${result.queuedSwipeVectors} swipe variants queued` : '';
        toastr.success(`Embeddings updated for ${filesToEmbed.length} thread${filesToEmbed.length !== 1 ? 's' : ''}${messagePart}${queuedSwipePart} (${result.clusters} clusters).`);
    } catch (err) {
        console.error(`[${MODULE_NAME}] Toolbar embedding failed:`, err);
        toastr.error(`Embedding failed: ${err.message || err}`);
    }
}

/**
 * Toggle semantic map view on/off.
 */
export function toggleSemanticMap() {
    resetSearchState();
    semanticMapActive = !semanticMapActive;

    const btn = document.getElementById('chat-manager-semantic-map-toggle');
    setToggleState(btn, semanticMapActive);

    if (semanticMapActive) {
        if (timelineActive) {
            deactivateTimeline();
        }
        if (statsActive) {
            deactivateStats();
        }
        if (graphViewActive) {
            deactivateGraphView();
        }

        const searchWrapper = _getSearchWrapper();
        const toolbar = _getFilterToolbar();
        const content = _getContent();
        if (searchWrapper) searchWrapper.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        if (content) {
            content.classList.add('timeline-active');
            content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building semantic map…</div>';
        }

        setSemanticMapCallbacks({
            onJump: handleTimelineJumpToMessage,
            getActive: getActiveFilename,
        });

        requestAnimationFrame(() => {
            if (!semanticMapActive) return;
            if (content) {
                mountSemanticMap(content, 'mini');
            }
            const status = _getStatus();
            if (status) status.textContent = 'Semantic map view';
        });
    } else {
        deactivateSemanticMap();
        renderThreadCards();
    }
}

/**
 * Toggle graph view on/off.
 */
export function toggleGraphView() {
    resetSearchState();
    graphViewActive = !graphViewActive;

    const btn = document.getElementById('chat-manager-graph-view-toggle');
    setToggleState(btn, graphViewActive);

    if (graphViewActive) {
        if (timelineActive) deactivateTimeline();
        if (semanticMapActive) deactivateSemanticMap();
        if (statsActive) deactivateStats();

        const searchWrapper = _getSearchWrapper();
        const content = _getContent();
        if (searchWrapper) searchWrapper.style.display = 'none';
        dismissDropdown();
        if (content) {
            content.classList.add('timeline-active');
            content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Preparing graph view…</div>';
        }

        // Keep the filter toolbar available (collapsed to filter controls) so the
        // active date/tag filter can be changed while the graph is open.
        ensureFilterToolbar();

        setGraphViewCallbacks({
            onJump: handleTimelineJumpToMessage,
            getActive: getActiveFilename,
        });

        // Restrict the graph to whatever the current filter matches. The provider
        // is re-evaluated on every re-collect, so later hydration / embedding
        // completions stay consistent with the active filter.
        setGraphScope(currentGraphScope);

        requestAnimationFrame(() => {
            if (!graphViewActive) return;
            if (content) mountGraphView(content);
            const status = _getStatus();
            if (status) status.textContent = 'Graph view';
        });
    } else {
        deactivateGraphView();
        renderThreadCards();
    }
}

export function isGraphViewActive() {
    return graphViewActive;
}

/**
 * Toggle timeline view on/off. Called from index.js when the toggle button is clicked.
 * Expects Cytoscape libs to be loaded before this is called.
 */
export function toggleTimeline() {
    resetSearchState();
    timelineActive = !timelineActive;

    // Update toggle button active state
    const btn = document.getElementById('chat-manager-timeline-toggle');
    setToggleState(btn, timelineActive);

    // Deactivate stats if active
    if (timelineActive && statsActive) {
        deactivateStats();
    }
    if (timelineActive && semanticMapActive) {
        deactivateSemanticMap();
    }
    if (timelineActive && graphViewActive) {
        deactivateGraphView();
    }

    const searchWrapper = _getSearchWrapper();
    const content = _getContent();

    if (timelineActive) {
        // Hide search and toolbar, switch content to timeline
        if (searchWrapper) searchWrapper.style.display = 'none';
        const toolbar = _getFilterToolbar();
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        if (content) content.classList.add('timeline-active');

        // Set up callbacks so icicle-view can navigate
        setIcicleCallbacks({
            onJump: handleTimelineJumpToMessage,
            getActive: getActiveFilename,
            onThreadFocusChanged: persistThreadFocus,
            canEmbedNode: canEmbedNodeFromTimeline,
            onEmbedNode: handleTimelineEmbedNode,
        });

        // Initialize thread focus from persisted preference
        setIcicleThreadFocus(getThreadFocus());

        // Show loading state immediately so the browser can paint before heavy work
        if (content) content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building chart\u2026</div>';
        const status = _getStatus();
        if (status) status.textContent = 'Loading timeline\u2026';

        // Defer mount past reflow — single rAF is enough after loading state paint
        requestAnimationFrame(() => {
            if (!timelineActive) return;
            if (content) mountIcicle(content, 'mini');
            if (status) status.textContent = 'Timeline view';
        });
    } else {
        // Dismiss modal if open, then tear down
        dismissTimelineModal();
        unmountIcicle();

        // Restore search, toolbar, and content
        if (searchWrapper) searchWrapper.style.display = '';
        const toolbar = _getFilterToolbar();
        if (toolbar) toolbar.style.display = '';
        if (content) {
            content.classList.remove('timeline-active');
            content.innerHTML = '';
        }

        // Re-render thread cards
        renderThreadCards();
    }
}

/**
 * Toggle stats dashboard on/off. Mutually exclusive with timeline.
 */
export function toggleStats() {
    resetSearchState();
    statsActive = !statsActive;

    const btn = document.getElementById('chat-manager-stats-toggle');
    setToggleState(btn, statsActive);

    const searchWrapper = _getSearchWrapper();
    const toolbar = _getFilterToolbar();
    const content = _getContent();

    if (statsActive) {
        // Deactivate timeline if active
        if (timelineActive) {
            deactivateTimeline();
        }
        if (semanticMapActive) {
            deactivateSemanticMap();
        }
        if (graphViewActive) {
            deactivateGraphView();
        }

        // Hide search and toolbar
        if (searchWrapper) searchWrapper.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        if (content) content.classList.remove('timeline-active');

        // Set up callbacks
        setStatsCallbacks({
            onDayClick: handleHeatmapDayClick,
            getActive: getActiveFilename,
        });

        // Mount stats view
        if (content) {
            content.innerHTML = '';
            mountStatsView(content);
        }

        const status = _getStatus();
        if (status) status.textContent = 'Stats dashboard';
    } else {
        deactivateStats();
        renderThreadCards();
    }
}

/**
 * Toggle branch context injection on/off.
 */
export async function toggleBranchContext() {
    branchContextActive = !branchContextActive;
    setBranchContextEnabled(branchContextActive);

    const btn = document.getElementById('chat-manager-branch-context-toggle');
    setToggleState(btn, branchContextActive);

    if (branchContextActive) {
        const activeFile = getActiveFilename();
        await refreshBranchContextStatus(activeFile);
    } else {
        clearBranchContextInjection();
        const indicator = document.getElementById('chat-manager-branch-context-indicator');
        if (indicator) indicator.style.display = 'none';
    }
}

async function refreshBranchContextStatus(activeFile) {
    try {
        const result = await updateBranchContextInjection(activeFile);
        if (!result?.stale && branchContextActive && getActiveFilename() === activeFile) updateBranchContextStatusUI(result);
    } catch (error) {
        if (error?.name !== 'AbortError') console.warn(`[${MODULE_NAME}] Branch context could not refresh:`, error);
    }
}

/**
 * Update the branch context status indicator UI.
 * @param {{ branchCount: number, injected: boolean }} result
 */
function updateBranchContextStatusUI(result) {
    const indicator = document.getElementById('chat-manager-branch-context-indicator');
    if (!indicator) return;

    if (!branchContextActive) {
        indicator.style.display = 'none';
        return;
    }

    indicator.style.display = '';
    if (result.injected && result.branchCount > 0) {
        indicator.className = 'chat-manager-branch-ctx-indicator';
        indicator.textContent = `Branch context: ${result.branchCount} branch${result.branchCount !== 1 ? 'es' : ''} injected`;
    } else {
        indicator.className = 'chat-manager-branch-ctx-indicator empty';
        indicator.textContent = 'Branch context: no sibling branches found';
    }
}

/**
 * Clean teardown of stats view.
 */
function deactivateStats() {
    if (!statsActive && !isStatsMounted()) return;
    statsActive = false;
    unmountStatsView();

    const btn = document.getElementById('chat-manager-stats-toggle');
    setToggleState(btn, false);

    const searchWrapper = _getSearchWrapper();
    if (searchWrapper) searchWrapper.style.display = '';
    const toolbar = _getFilterToolbar();
    if (toolbar) toolbar.style.display = '';

    const content = _getContent();
    if (content) content.innerHTML = '';
}

/**
 * Clean teardown of semantic map view.
 */
function deactivateSemanticMap() {
    if (!semanticMapActive && !isSemanticMapMounted()) return;
    semanticMapActive = false;
    unmountSemanticMap();

    const btn = document.getElementById('chat-manager-semantic-map-toggle');
    setToggleState(btn, false);

    const searchWrapper = _getSearchWrapper();
    if (searchWrapper) searchWrapper.style.display = '';
    const toolbar = _getFilterToolbar();
    if (toolbar) toolbar.style.display = '';

    const content = _getContent();
    if (content) {
        content.classList.remove('timeline-active');
        content.innerHTML = '';
    }
}

function deactivateGraphView() {
    if (!graphViewActive && !isGraphViewMounted()) return;
    graphViewActive = false;
    setGraphScope(null);
    unmountGraphView();

    const btn = document.getElementById('chat-manager-graph-view-toggle');
    setToggleState(btn, false);

    const searchWrapper = _getSearchWrapper();
    if (searchWrapper) searchWrapper.style.display = '';
    const toolbar = _getFilterToolbar();
    if (toolbar) toolbar.style.display = '';

    const content = _getContent();
    if (content) {
        content.classList.remove('timeline-active');
        content.innerHTML = '';
    }
}

/**
 * Handle heatmap day click — exit stats, show filtered threads for that day.
 */
function handleHeatmapDayClick(dateKey, chatFileNames) {
    deactivateStats();

    const index = getIndex();
    const entries = chatFileNames
        .map(f => index[f])
        .filter(Boolean);

    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;

    if (entries.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No threads found for this day.</div>';
        if (status) status.textContent = '';
        return;
    }

    // Add a "back" button
    const backBtn = document.createElement('button');
    backBtn.className = 'chat-manager-btn';
    backBtn.style.margin = '0 12px 8px';
    backBtn.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Back to threads';
    backBtn.addEventListener('click', () => renderThreadCards());
    container.appendChild(backBtn);

    const { moment } = SillyTavern.libs;
    const dateStr = moment(dateKey).format('ddd, MMM D, YYYY');
    if (status) status.textContent = `${entries.length} thread${entries.length !== 1 ? 's' : ''} active on ${dateStr}`;

    renderThreadCardsFromEntries(entries, container, null, Object.keys(index).length);
    // Prepend back button before cards
    container.prepend(backBtn);
}

function scheduleStatsRefresh() {
    if (refreshStatsFromHydrationTimer) return;

    refreshStatsFromHydrationTimer = setTimeout(() => {
        refreshStatsFromHydrationTimer = null;
        if (!panelOpen || !statsActive) return;
        if (isStatsMounted()) {
            updateStatsView();
        }
    }, 600);
}

/**
 * Handle jump-to-message from the timeline popup.
 * @param {string} filename
 * @param {number} msgIndex
 */
async function handleTimelineJumpToMessage(filename, msgIndex) {
    return navigateToChat(filename, msgIndex, chatNavigationOptions(filename));
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

function formatDateOrFallback(momentLib, value, fallback = '?') {
    const ms = timestampMs(value);
    if (ms === null) return fallback;
    const parsed = momentLib(ms);
    return parsed.isValid() ? parsed.format('MMM D') : fallback;
}

function formatFromNowOrFallback(momentLib, value, fallback = 'unknown') {
    const ms = timestampMs(value);
    if (ms === null) return fallback;
    const parsed = momentLib(ms);
    return parsed.isValid() ? parsed.fromNow() : fallback;
}

function getLastMessageFallback(entry) {
    if (!entry || !entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    const lastMsg = entry.messages[entry.messages.length - 1];
    return typeof lastMsg?.text === 'string' && lastMsg.text ? messagePreview(lastMsg.text.trim(), 240) : (lastMsg?.preview || '');
}

function getSummaryDisplay(entry) {
    const summary = (getSummary(entry.fileName) || '').trim();
    if (summary) {
        return {
            className: 'chat-manager-summary-text',
            text: summary,
        };
    }

    const lastMessage = getLastMessageFallback(entry);
    if (lastMessage) {
        return {
            className: 'chat-manager-summary-text chat-manager-last-message-fallback',
            text: lastMessage,
        };
    }

    return {
        className: 'chat-manager-summary-text chat-manager-no-summary',
        text: 'No summary yet',
    };
}

function patchSummaryTextElement(textEl, entry) {
    if (!textEl || !entry) return;

    const summaryDisplay = getSummaryDisplay(entry);
    textEl.className = summaryDisplay.className;
    textEl.textContent = summaryDisplay.text;
}

function scheduleHydrationUIRefresh() {
    if (refreshFromHydrationTimer) return;

    refreshFromHydrationTimer = setTimeout(() => {
        refreshFromHydrationTimer = null;
        if (!panelOpen) return;

        const query = getCurrentSearchQuery();
        if (query.length >= 2) return;

        patchCardData();

        if (isHydrationComplete()) scheduleBranchDetection();
    }, 600);
}

function cancelBranchDetection() {
    const task = branchDetectionTask;
    branchDetectionTask = null;
    if (!task) return;
    if (task.idle) globalThis.cancelIdleCallback?.(task.id);
    else clearTimeout(task.id);
}

// Coalesce work and read the current chat at execution time, so a delayed
// callback cannot paint branch badges for a chat that is no longer selected.
function scheduleBranchDetection() {
    if (branchDetectionTask) return;
    const task = {};
    branchDetectionTask = task;
    const run = () => {
        if (branchDetectionTask !== task) return;
        branchDetectionTask = null;
        if (!panelOpen || isAnyViewActive()) return;
        const activeFile = getActiveFilename();
        runDeferredBranchDetection(activeFile);
        patchBranchIndicators();
        if (branchContextActive) {
            void refreshBranchContextStatus(activeFile);
        }
    };
    task.idle = typeof globalThis.requestIdleCallback === 'function';
    task.id = task.idle ? globalThis.requestIdleCallback(run, { timeout: 500 }) : setTimeout(run, 0);
}

function cancelSearchRefresh() {
    searchRefreshPending = false;
    if (refreshSearchFromHydrationTimer) {
        clearTimeout(refreshSearchFromHydrationTimer);
        refreshSearchFromHydrationTimer = null;
    }
}

function scheduleSearchRefresh() {
    searchRefreshPending = true;
    if (refreshSearchFromHydrationTimer) {
        clearTimeout(refreshSearchFromHydrationTimer);
        refreshSearchFromHydrationTimer = null;
    }
    // An archive scan already reads cold chats on demand. Let it finish before
    // refreshing, and coalesce indexing batches until the archive is ready.
    if (searchPageAbort || !isHydrationComplete()) return;

    refreshSearchFromHydrationTimer = setTimeout(() => {
        refreshSearchFromHydrationTimer = null;
        if (!searchRefreshPending || !panelOpen || isAnyViewActive()) return;
        if (searchPageAbort || !isHydrationComplete()) return;

        const latestQuery = getCurrentSearchQuery();
        searchRefreshPending = false;
        if (latestQuery.length < 2) return;
        performSearch(latestQuery);
    }, 180);
}

function scheduleTimelineRefresh() {
    if (refreshTimelineFromHydrationTimer) return;

    refreshTimelineFromHydrationTimer = setTimeout(() => {
        refreshTimelineFromHydrationTimer = null;
        if (!panelOpen || !timelineActive) return;
        if (isIcicleMounted()) {
            updateIcicleData();
        }
    }, 600);
}

function scheduleSemanticMapRefresh() {
    if (refreshSemanticMapFromHydrationTimer) return;

    refreshSemanticMapFromHydrationTimer = setTimeout(() => {
        refreshSemanticMapFromHydrationTimer = null;
        if (!panelOpen || !semanticMapActive) return;
        if (isSemanticMapMounted()) {
            updateSemanticMapData();
        }
    }, 600);
}

function scheduleGraphViewRefresh() {
    if (refreshGraphViewFromHydrationTimer) return;

    refreshGraphViewFromHydrationTimer = setTimeout(() => {
        refreshGraphViewFromHydrationTimer = null;
        if (!panelOpen || !graphViewActive) return;
        if (isGraphViewMounted()) {
            updateGraphViewData();
        }
    }, 600);
}

function ensureHydrationSubscription() {
    if (hydrationSubscriptionReady) return;

    onHydrationUpdate(() => {
        if (!panelOpen) return;

        if (statsActive) {
            scheduleStatsRefresh();
            return;
        }

        if (timelineActive) {
            scheduleTimelineRefresh();
            return;
        }
        if (semanticMapActive) {
            scheduleSemanticMapRefresh();
            return;
        }
        if (graphViewActive) {
            scheduleGraphViewRefresh();
            return;
        }

        const query = getCurrentSearchQuery();
        if (query.length >= 2) {
            scheduleSearchRefresh();
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
    cancelBranchDetection();
    const mode = getDisplayMode();
    if (mode === 'popup') {
        closePopup();
    } else {
        closeSidePanel();
    }
}

// ── Side Panel ──

let panelOpenRequestId = 0;

async function refreshAfterPanelPaint(root, requestId) {
    // Promise continuations (including refreshPanel's initial cached render) run
    // before paint. Leave a frame for the visible shell before doing that work.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (!panelOpen || requestId !== panelOpenRequestId || !root.isConnected) return;
    await refreshPanel();
}

let chatVerificationInProgress = false;

/** Re-read every chat from the server. Only this can reveal a remote same-size edit. */
export async function verifyAllChats() {
    if (!panelOpen || chatVerificationInProgress) return;
    chatVerificationInProgress = true;
    const button = document.getElementById('chat-manager-verify-chats');
    const icon = button?.querySelector('i');
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    icon?.classList.add('fa-spin');
    const context = SillyTavern.getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;
    try {
        await refreshPanel({ forceRevalidate: true });
        while (isBuilding()) await new Promise(resolve => setTimeout(resolve, 250));
        if (!avatar || avatar !== getIndexCharacterAvatar()) return;
        const { loaded, total } = getHydrationProgress();
        if (didLastBuildFail()) toastr.error('Could not read the chat list from the server.');
        else if (loaded < total) toastr.warning(`Checked ${loaded} of ${total} chats. The rest could not be read.`);
        else toastr.success(`Checked ${total} chat${total === 1 ? '' : 's'}.`);
    } finally {
        chatVerificationInProgress = false;
        if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        icon?.classList.remove('fa-spin');
    }
}

async function toggleSidePanel() {
    const panel = document.getElementById('chat-manager-panel');
    if (!panel) return;
    if (panelOpen) {
        closeSidePanel();
        return;
    }

    panelOpen = true;
    const requestId = ++panelOpenRequestId;
    panel.classList.add('open');
    await refreshAfterPanelPaint(panel, requestId);
}

function closeSidePanel() {
    resetSearchState();
    panelOpenRequestId++;
    clearThreadListState();
    const panel = document.getElementById('chat-manager-panel');
    if (panel) panel.classList.remove('open');
    panelOpen = false;
    dismissDropdown();
    deactivateStats();
    deactivateTimeline();
    deactivateSemanticMap();
    deactivateGraphView();
    releaseClosedPanelData();
}

// ── Popup ──

async function togglePopup() {
    const overlay = document.getElementById('chat-manager-shadow-overlay');
    if (!overlay) return;
    if (panelOpen) {
        closePopup();
        return;
    }

    panelOpen = true;
    const requestId = ++panelOpenRequestId;
    overlay.style.display = 'block';
    // Force reflow so the transition triggers
    void overlay.offsetHeight;
    overlay.classList.add('visible');
    await refreshAfterPanelPaint(overlay, requestId);
}

function closePopup() {
    resetSearchState();
    panelOpenRequestId++;
    clearThreadListState();
    const overlay = document.getElementById('chat-manager-shadow-overlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
    setTimeout(() => {
        if (!overlay.classList.contains('visible')) {
            overlay.style.display = 'none';
        }
    }, 300);
    panelOpen = false;
    dismissDropdown();
    deactivateStats();
    deactivateTimeline();
    deactivateSemanticMap();
    deactivateGraphView();
    releaseClosedPanelData();
}

function releaseClosedPanelData() {
    const content = document.getElementById('chat-manager-content');
    if (content) content.innerHTML = '';
    trimBodyCache({ keepActive: true, targetBytes: 0 });
    queryEmbeddingCache.clear();
    queryEmbeddingInFlight.clear();
    queryEmbeddingEpoch++;
    cancelDriftWork();
    _invalidateDomCache();
}

/**
 * Dismiss the full-screen modal without restoring a minimap.
 */
function dismissTimelineModal() {
    const modal = document.getElementById('chat-manager-timeline-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    if (modal._escHandler) {
        document.removeEventListener('keydown', modal._escHandler);
        modal._escHandler = null;
    }
}

/**
 * Clean up timeline state when panel closes.
 */
function deactivateTimeline() {
    if (!timelineActive) return;
    timelineActive = false;
    dismissTimelineModal();
    unmountIcicle();

    const btn = document.getElementById('chat-manager-timeline-toggle');
    setToggleState(btn, false);

    const searchWrapper = _getSearchWrapper();
    if (searchWrapper) searchWrapper.style.display = '';

    const content = _getContent();
    if (content) content.classList.remove('timeline-active');
}

// ──────────────────────────────────────────────
//  Panel Refresh
// ──────────────────────────────────────────────

export async function refreshPanel(options = {}) {
    if (!panelOpen) return;
    const refreshRequestId = panelOpenRequestId;
    const buildOptions = { forceRevalidate: options.forceRevalidate === true };
    const context = SillyTavern.getContext();
    ensureHydrationSubscription();
    ensureSearchModeBadge();
    updateSearchModeBadgeDisplay();
    if (getEmbeddingSettings().enabled) {
        scheduleEmbeddingBootstrap(getActiveFilename());
    }

    // Restore branch context toggle state from persisted setting
    branchContextActive = getBranchContextEnabled();
    const branchCtxBtn = document.getElementById('chat-manager-branch-context-toggle');
    setToggleState(branchCtxBtn, branchContextActive);
    const timelineBtn = document.getElementById('chat-manager-timeline-toggle');
    setToggleState(timelineBtn, timelineActive);
    const statsBtn = document.getElementById('chat-manager-stats-toggle');
    setToggleState(statsBtn, statsActive);
    const semanticMapBtn = document.getElementById('chat-manager-semantic-map-toggle');
    setToggleState(semanticMapBtn, semanticMapActive);
    const graphViewBtn = document.getElementById('chat-manager-graph-view-toggle');
    setToggleState(graphViewBtn, graphViewActive);

    // Guard: no character selected or group chat
    if (context.characterId === undefined) {
        renderEmptyState('Select a character to manage chats.');
        return;
    }

    // If stats is active, refresh stats and run index build in background
    if (statsActive) {
        if (isStatsMounted()) {
            updateStatsView();
        }
        const activeFile = getActiveFilename();
        if (activeFile) prioritizeInQueue(activeFile);
        await buildIndex(null, null, buildOptions);
        return;
    }

    // If timeline is active, rebuild timeline data instead of thread cards
    if (timelineActive) {
        if (isIcicleMounted()) {
            requestAnimationFrame(() => updateIcicleData());
        } else {
            const content = document.getElementById('chat-manager-content');
            if (content) {
                content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building graph\u2026</div>';
                setIcicleThreadFocus(getThreadFocus());
                requestAnimationFrame(() => {
                    if (!timelineActive) return;
                    if (content) mountIcicle(content, 'mini');
                });
            }
        }
        // Still run index build in the background
        const activeFile = getActiveFilename();
        if (activeFile) prioritizeInQueue(activeFile);
        await buildIndex(null, null, buildOptions);
        return;
    }

    if (semanticMapActive) {
        const content = _getContent();
        const status = _getStatus();
        const searchWrapper = _getSearchWrapper();
        const toolbar = _getFilterToolbar();
        if (searchWrapper) searchWrapper.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        if (content) {
            content.classList.add('timeline-active');
            if (isSemanticMapMounted()) {
                requestAnimationFrame(() => updateSemanticMapData());
            } else {
                content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building semantic map\u2026</div>';
                setSemanticMapCallbacks({
                    onJump: handleTimelineJumpToMessage,
                    getActive: getActiveFilename,
                });
                requestAnimationFrame(() => {
                    if (!semanticMapActive) return;
                    mountSemanticMap(content, 'mini');
                });
            }
        }
        if (status) status.textContent = 'Semantic map view';

        const activeFile = getActiveFilename();
        if (activeFile) prioritizeInQueue(activeFile);
        await buildIndex(null, null, buildOptions);
        return;
    }

    if (graphViewActive) {
        const content = _getContent();
        const status = _getStatus();
        const searchWrapper = _getSearchWrapper();
        const toolbar = _getFilterToolbar();
        if (searchWrapper) searchWrapper.style.display = 'none';
        if (toolbar) toolbar.style.display = 'none';
        if (content) {
            content.classList.add('timeline-active');
            if (isGraphViewMounted()) {
                requestAnimationFrame(() => updateGraphViewData());
            } else {
                content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Preparing graph view\u2026</div>';
                setGraphViewCallbacks({
                    onJump: handleTimelineJumpToMessage,
                    getActive: getActiveFilename,
                });
                requestAnimationFrame(() => {
                    if (!graphViewActive) return;
                    mountGraphView(content);
                });
            }
        }
        if (status) status.textContent = 'Graph view';

        const activeFile = getActiveFilename();
        if (activeFile) prioritizeInQueue(activeFile);
        await buildIndex(null, null, buildOptions);
        return;
    }

    const index = getIndex();
    const hasCache = Object.keys(index).length > 0;

    const renderThreadListWithBranches = () => {
        renderThreadCards();
        scheduleBranchDetection();
    };

    const renderFromLatestIndex = () => {
        if (!panelOpen || refreshRequestId !== panelOpenRequestId || isAnyViewActive()) return;
        const query = getCurrentSearchQuery();
        if (query.length >= 2) {
            performSearch(query);
        } else {
            renderThreadListWithBranches();
        }
    };

    if (hasCache) {
        // Cache-first: render immediately from existing index
        renderFromLatestIndex();
    } else {
        renderLoading();
    }

    const activeFile = getActiveFilename();
    if (activeFile) {
        prioritizeInQueue(activeFile);
    }

    let renderedFromMetadata = false;
    const { changed } = await buildIndex(onIndexProgress, (buildState) => {
        if (renderedFromMetadata) return;
        if (buildState?.changed) {
            searchState = null;
        }
        renderedFromMetadata = true;
        prioritizeHydrationFiles([getActiveFilename(), ...getVisibleEntryFileNames().slice(0, 12)]);
        if (!panelOpen || refreshRequestId !== panelOpenRequestId || isAnyViewActive()) return;
        if (!hasCache || buildState?.changed) {
            renderFromLatestIndex();
        }
    }, buildOptions);

    // Invalidate search state since the index may have changed
    if (changed && !renderedFromMetadata) {
        searchState = null;
    }

    if (panelOpen && refreshRequestId === panelOpenRequestId && !isAnyViewActive()) {
        if (!renderedFromMetadata) renderFromLatestIndex();
        // Cards painted from the list alone can now show their restored catalogs.
        else if (changed && getCurrentSearchQuery().length < 2) patchCardData();
    }
}

function onIndexProgress(completed, total) {
    const status = document.getElementById('chat-manager-status');
    if (!status || getCurrentSearchQuery().length >= 2) return;
    const state = completed >= total ? threadLists.get(_getContent()) : null;
    if (state) updateThreadListFooter(state);
    else status.textContent = `Indexing chats... ${completed}/${total}`;
}

/**
 * Patch branch indicators into already-rendered cards (called after deferred branch detection).
 */
function patchBranchIndicators() {
    const index = getIndex();
    const activeFile = getActiveFilename();
    const activeEntry = activeFile ? index[activeFile] : null;
    for (const card of _getContent()?.querySelectorAll('.chat-manager-card') || []) {
        const entry = index[card.dataset.filename];
        if (!entry) continue;

        const meta = card.querySelector('.chat-manager-card-meta');
        if (!meta) continue;

        const existing = meta.querySelector('.chat-manager-branch');
        const canShowBranch = entry.isLoaded && entry.branchPoint !== null;

        if (!canShowBranch) {
            if (existing) existing.remove();
            continue;
        }

        const distance = (activeEntry && activeEntry.isLoaded) ? activeEntry.messageCount - entry.branchPoint : null;
        const label = distance !== null ? `Branched ${distance} msgs ago` : `Branched at msg #${entry.branchPoint}`;

        if (existing) {
            existing.className = 'chat-manager-branch chat-manager-branch-jump';
            existing.textContent = label;
            existing.dataset.filename = entry.fileName;
            existing.dataset.msgIndex = String(entry.branchPoint);
            existing.title = 'Jump to this message in graph';
            if (existing.tagName === 'BUTTON') {
                existing.type = 'button';
            }
            existing.removeEventListener('click', handleJumpToGraphMessage);
            existing.addEventListener('click', handleJumpToGraphMessage);
            continue;
        }

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'chat-manager-branch chat-manager-branch-jump';
        button.textContent = label;
        button.dataset.filename = entry.fileName;
        button.dataset.msgIndex = String(entry.branchPoint);
        button.title = 'Jump to this message in graph';
        button.addEventListener('click', handleJumpToGraphMessage);
        meta.appendChild(button);
    }
}

// ──────────────────────────────────────────────
//  Incremental Card Patching (used during hydration)
// ──────────────────────────────────────────────

/**
 * Patch already-rendered cards in-place with updated data from hydrated entries.
 * Much cheaper than a full renderThreadCards() call — avoids HTML rebuild,
 * DOMPurify.sanitize, and event re-binding.
 */
function patchCardData() {
    const { moment } = SillyTavern.libs;
    const index = getIndex();
    for (const card of _getContent()?.querySelectorAll('.chat-manager-card') || []) {
        const entry = index[card.dataset.filename];
        if (!entry) continue;

        const meta = card.querySelector('.chat-manager-card-meta');
        if (!meta) continue;

        // Update the three meta spans: message count, date range, last active
        const spans = meta.querySelectorAll(':scope > span:not(.chat-manager-branch)');
        if (spans[0]) spans[0].textContent = `${entry.messageCount} messages`;

        const firstDate = formatDateOrFallback(moment, entry.firstMessageTimestamp, '?');
        const lastDate = formatDateOrFallback(moment, entry.lastMessageTimestamp, '?');
        if (spans[1]) spans[1].textContent = `${firstDate} – ${lastDate}`;

        const lastActive = formatFromNowOrFallback(moment, entry.lastMessageTimestamp, 'unknown');
        if (spans[2]) spans[2].textContent = lastActive;

        const summaryText = card.querySelector('.chat-manager-summary-text');
        if (summaryText) {
            patchSummaryTextElement(summaryText, entry);
        }

        // Remove "Indexing..." span and enable AI buttons when loaded
        if (entry.isLoaded && !entry.needsHydration) {
            const indexingSpan = Array.from(meta.querySelectorAll('span'))
                .find(s => s.textContent === 'Indexing...');
            if (indexingSpan) indexingSpan.remove();

            const aiTitleBtn = card.querySelector('.chat-manager-ai-title-btn');
            if (aiTitleBtn && aiTitleBtn.classList.contains('disabled') && aiTitleBtn.ariaBusy !== 'true') {
                aiTitleBtn.classList.remove('disabled');
                aiTitleBtn.disabled = false;
                aiTitleBtn.title = 'Generate AI title';
            }

            const aiSummaryTitleBtn = card.querySelector('.chat-manager-ai-summarize-title-btn');
            if (aiSummaryTitleBtn && aiSummaryTitleBtn.classList.contains('disabled') && aiSummaryTitleBtn.ariaBusy !== 'true') {
                aiSummaryTitleBtn.classList.remove('disabled');
                aiSummaryTitleBtn.disabled = false;
                aiSummaryTitleBtn.title = 'Generate summary and set AI title';
            }

            const regenBtn = card.querySelector('.chat-manager-regen-summary-btn');
            if (regenBtn && regenBtn.classList.contains('disabled') && regenBtn.ariaBusy !== 'true') {
                regenBtn.classList.remove('disabled');
                regenBtn.disabled = false;
                regenBtn.title = 'Generate/regenerate summary';
            }
        }
    }

    // Update status bar
    const state = threadLists.get(_getContent());
    if (state) updateThreadListFooter(state);
}

// ──────────────────────────────────────────────
//  Rendering: Thread Cards
// ──────────────────────────────────────────────

function renderLoading() {
    const container = document.getElementById('chat-manager-content');
    if (container) threadLists.delete(container);
    const status = document.getElementById('chat-manager-status');
    if (container) container.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Loading chats...</div>';
    if (status) status.textContent = 'Loading...';
}

function renderEmptyState(message) {
    const container = _getContent();
    if (container) threadLists.delete(container);
    const status = _getStatus();
    if (container) container.innerHTML = `<div class="chat-manager-empty">${escapeHtml(message)}</div>`;
    if (status) status.textContent = '';
}

export function renderThreadCards(visibleCount = RESULTS_PAGE_SIZE) {
    const container = _getContent();
    const status = _getStatus();
    if (!container) return;

    const index = getIndex();
    const totalCount = Object.keys(index).length;

    // Use filter/sort state
    const filterState = getFilterState();
    const sortState = getSortState();
    const entries = getFilteredSortedEntries(filterState, sortState, getChatMeta);

    // Ensure toolbar exists
    ensureFilterToolbar();
    setSearchModeBadge('keyword');

    if (totalCount === 0) {
        renderEmptyState('No chats found for this character.');
        return;
    }

    if (entries.length === 0 && hasActiveFilter()) {
        threadLists.delete(container);
        container.innerHTML = '<div class="chat-manager-no-filter-results"><p>No threads match current filters.</p><button class="chat-manager-btn chat-manager-clear-all-inline">Clear filters</button></div>';
        const clearBtn = container.querySelector('.chat-manager-clear-all-inline');
        if (clearBtn) clearBtn.addEventListener('click', () => { clearFilterState(); renderThreadCards(); });
        if (status) status.textContent = withIndexingSuffix(`Showing 0 of ${totalCount} threads`);
        return;
    }

    renderThreadCardsFromEntries(entries, container, status, totalCount, visibleCount);
    threadLists.get(container).normalList = true;
}

/**
 * Render thread cards from a given set of entries into a container.
 * Extracted so heatmap day-click and other features can reuse it.
 */
export function renderThreadCardsFromEntries(entries, container, status, totalCount, visibleCount = RESULTS_PAGE_SIZE) {
    if (!container) return;
    const state = {
        entries, container, status,
        totalCount: totalCount ?? Object.keys(getIndex()).length,
        visibleCount: Math.min(entries.length, visibleCount),
        normalList: false,
    };
    threadLists.set(container, state);
    container.innerHTML = SillyTavern.libs.DOMPurify.sanitize(buildThreadCardsHtml(entries.slice(0, state.visibleCount)));
    updateThreadListFooter(state);
    bindCardEvents(container);
}

function updateThreadListFooter(state) {
    const { container, status, entries, totalCount, visibleCount } = state;
    container.querySelector('.chat-manager-threads-more')?.remove();
    if (visibleCount < entries.length) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'chat-manager-btn chat-manager-threads-more';
        more.textContent = `Load ${Math.min(RESULTS_PAGE_SIZE, entries.length - visibleCount)} more threads`;
        more.addEventListener('click', () => {
            if (threadLists.get(container) !== state) return;
            const end = Math.min(entries.length, state.visibleCount + RESULTS_PAGE_SIZE);
            const index = getIndex();
            const page = entries.slice(state.visibleCount, end).map(entry => index[entry.fileName] || entry);
            const previous = entries[state.visibleCount - 1];
            more.insertAdjacentHTML('beforebegin', SillyTavern.libs.DOMPurify.sanitize(
                buildThreadCardsHtml(page, index[previous?.fileName] || previous),
            ));
            state.visibleCount = end;
            updateThreadListFooter(state);
        });
        container.appendChild(more);
    }
    if (status) {
        const label = entries.length !== totalCount
            ? `Showing ${visibleCount} of ${entries.length} matching threads (${totalCount} total)`
            : `Showing ${visibleCount} of ${totalCount} threads`;
        status.textContent = withIndexingSuffix(label);
    }
}

function clearThreadListState() {
    const container = _getContent();
    if (!container) return;
    // The load-more listener captures the entry list. Release it while closed.
    container.querySelector('.chat-manager-threads-more')?.remove();
    threadLists.delete(container);
}

/** Preserve other cards and the loaded page count during an ordinary message update. */
export function refreshThreadCardsAfterMessage(fileName) {
    if (getCurrentSearchQuery().length >= 2) {
        scheduleSearchRefresh();
        return;
    }
    const container = _getContent();
    const state = container && threadLists.get(container);
    if (!state?.normalList || getSortState().field === 'cluster') {
        renderThreadCards(state?.visibleCount || RESULTS_PAGE_SIZE);
        return;
    }
    const entries = getFilteredSortedEntries(getFilterState(), getSortState(), getChatMeta);
    if (entries.length === 0) {
        renderThreadCards();
        return;
    }
    const visible = entries.slice(0, state.visibleCount);
    const wanted = new Set(visible.map(entry => entry.fileName));
    const cards = new Map();
    for (const card of container.querySelectorAll('.chat-manager-card')) {
        if (!wanted.has(card.dataset.filename)) card.remove();
        else cards.set(card.dataset.filename, card);
    }
    container.querySelector('.chat-manager-threads-more')?.remove();
    let before = container.firstElementChild;
    for (const entry of visible) {
        let card = cards.get(entry.fileName);
        if (!card || entry.fileName === fileName) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = SillyTavern.libs.DOMPurify.sanitize(buildThreadCardsHtml([entry]));
            const replacement = wrapper.firstElementChild;
            if (card) {
                if (before === card) before = replacement;
                card.replaceWith(replacement);
            }
            card = replacement;
        }
        if (card !== before) container.insertBefore(card, before);
        before = card.nextElementSibling;
    }
    state.entries = entries;
    state.totalCount = Object.keys(getIndex()).length;
    state.visibleCount = visible.length;
    updateThreadListFooter(state);
    updateEmbeddingSelectionControls();
}

function buildThreadCardsHtml(entries, previousEntry = null) {
    const index = getIndex();

    const { moment } = SillyTavern.libs;
    const activeChatFile = getActiveFilename();
    const activeEntry = activeChatFile ? index[activeChatFile] : null;
    const tagDefs = getTagDefinitions();
    const sortState = getSortState();
    const embeddingSettings = getEmbeddingSettings();
    const selectedScope = embeddingSettings.scopeMode === 'selected';
    const isClusterSorted = sortState.field === 'cluster';
    let previousClusterGroup = previousEntry ? (previousEntry.clusterLabel ?? 999) : null;
    let hasRenderedClusterGroup = !!previousEntry;
    const selectedChats = new Set(getSelectedEmbeddingChats());

    let html = '';
    for (const entry of entries) {
        const currentClusterGroup = entry.clusterLabel ?? 999;
        if (isClusterSorted && hasRenderedClusterGroup && currentClusterGroup !== previousClusterGroup) {
            const dividerColor = entry.clusterLabel != null
                ? clusterColor(entry.clusterLabel)
                : 'rgba(180, 180, 180, 0.45)';
            html += `<div class="chat-manager-cluster-divider" style="--chat-manager-cluster-color:${escapeAttr(dividerColor)}"></div>`;
        }
        if (isClusterSorted) {
            previousClusterGroup = currentClusterGroup;
            hasRenderedClusterGroup = true;
        }

        const isReady = entry.isLoaded && !entry.needsHydration;
        const displayName = getDisplayName(entry.fileName) || entry.fileName;
        const summaryDisplay = getSummaryDisplay(entry);
        const isActive = entry.fileName === activeChatFile;
        const isSelectedForEmbedding = selectedChats.has(entry.fileName);
        const embeddingSelectControl = `
            <label class="chat-manager-emb-select${selectedScope ? ' scope-selected' : ''}" title="Include this chat when embedding scope is set to selected chats">
                <input type="checkbox" class="chat-manager-emb-select-cb" data-filename="${escapeAttr(entry.fileName)}" ${isSelectedForEmbedding ? 'checked' : ''}>
                <span>Embed</span>
            </label>`;
        const clusterDot = entry.clusterLabel != null
            ? `<span class="chat-manager-cluster-dot" style="background:${escapeAttr(clusterColor(entry.clusterLabel))}" title="Cluster ${entry.clusterLabel + 1}"></span>`
            : '';

        const firstDate = formatDateOrFallback(moment, entry.firstMessageTimestamp, '?');
        const lastDate = formatDateOrFallback(moment, entry.lastMessageTimestamp, '?');
        const lastActive = formatFromNowOrFallback(moment, entry.lastMessageTimestamp, 'unknown');

        const branchDistance = (entry.isLoaded && entry.branchPoint !== null && activeEntry?.isLoaded)
            ? activeEntry.messageCount - entry.branchPoint : null;
        const branchInfo = (entry.isLoaded && entry.branchPoint !== null)
            ? `<button type="button" class="chat-manager-branch chat-manager-branch-jump" data-filename="${escapeAttr(entry.fileName)}" data-msg-index="${entry.branchPoint}" title="Jump to this message in graph">${branchDistance !== null ? `Branched ${branchDistance} msgs ago` : `Branched at msg #${entry.branchPoint}`}</button>`
            : '';
        const driftSummary = getDriftSummary(entry);
        const driftInfo = driftSummary
            ? `<button type="button" class="chat-manager-drift-jump" data-filename="${escapeAttr(entry.fileName)}" data-msg-index="${driftSummary.firstMsgIndex}" title="Topic shifts near messages: ${escapeAttr(driftSummary.positions.join(', '))}">${driftSummary.count} topic shift${driftSummary.count !== 1 ? 's' : ''}</button>`
            : '';
        const indexingInfo = isReady ? '' : '<span>Indexing...</span>';
        const embStatus = getEmbeddingStatus(entry);
        const embBadge = (embStatus === 'full' || embStatus === 'partial' || embStatus === 'none')
            ? `<span class="chat-manager-emb-status chat-manager-emb-status-${embStatus}" title="${escapeAttr(embStatusTitle(embStatus))}"><i class="fa-solid fa-vector-square" aria-hidden="true"></i><span>${escapeHtml(embStatusTitle(embStatus))}</span></span>`
            : '';
        const embedCardBtn = (embStatus !== 'disabled' && embStatus !== 'full' && embStatus !== 'unknown' && entry.isLoaded)
            ? renderCardAction('chat-manager-embed-card-btn', entry.fileName, 'fa-vector-square', 'Generate embeddings', 'Generate embeddings for semantic search and topic views')
            : '';
        const aiSummaryTitle = isReady
            ? 'Generate summary and set AI title'
            : 'AI summary/title will be available once indexing finishes';
        const aiTitle = isReady
            ? 'Generate AI title'
            : 'AI title will be available once indexing finishes';
        const summaryTitle = isReady
            ? 'Generate/regenerate summary'
            : 'AI summary will be available once indexing finishes';

        // Tag chips
        const chatTags = getChatTags(entry.fileName);
        let tagChipsHtml = '';
        if (chatTags.length > 0) {
            tagChipsHtml = '<div class="chat-manager-card-tags">';
            for (const tagId of chatTags) {
                const def = tagDefs[tagId];
                if (!def) continue;
                tagChipsHtml += `<span class="chat-manager-tag-chip" style="background:${escapeAttr(safeTagColor(def.color, '#607D8B'))};color:${escapeAttr(safeTagColor(def.textColor, '#FFFFFF'))}">${escapeHtml(def.name)}</span>`;
            }
            tagChipsHtml += '</div>';
        }

        html += `
        <div class="chat-manager-card${isActive ? ' active' : ''}" data-filename="${escapeAttr(entry.fileName)}">
            <div class="chat-manager-card-header">
                <div class="chat-manager-card-title-row">
                    ${embeddingSelectControl}
                    ${clusterDot}
                    <span class="chat-manager-display-name" data-filename="${escapeAttr(entry.fileName)}" title="Click to switch thread">${escapeHtml(displayName)}</span>
                </div>
                <div class="chat-manager-card-actions">
                    ${renderCardAction('chat-manager-edit-name-btn', entry.fileName, 'fa-pen', 'Rename title', 'Edit the display title shown in Chat Manager')}
                    ${renderCardAction('chat-manager-tag-btn', entry.fileName, 'fa-tag', 'Tags', 'Manage tags for this chat')}
                    ${renderCardAction('chat-manager-ai-title-btn', entry.fileName, 'fa-heading', 'AI title', aiTitle, !isReady)}
                    ${renderCardAction('chat-manager-ai-summarize-title-btn', entry.fileName, 'fa-wand-magic-sparkles', 'AI title + summary', aiSummaryTitle, !isReady)}
                </div>
            </div>
            ${tagChipsHtml}
            <div class="chat-manager-card-meta">
                <span>${entry.messageCount} messages</span>
                <span>${firstDate} – ${lastDate}</span>
                <span>${lastActive}</span>
                ${indexingInfo}
                ${embBadge}
                ${embedCardBtn}
                ${driftInfo}
                ${branchInfo}
            </div>
            <div class="chat-manager-card-summary" data-filename="${escapeAttr(entry.fileName)}">
                <p class="${summaryDisplay.className}">${escapeHtml(summaryDisplay.text)}</p>
                <div class="chat-manager-summary-actions">
                    ${renderCardAction('chat-manager-edit-summary-btn', entry.fileName, 'fa-pen-to-square', 'Edit summary', 'Edit this chat summary')}
                    ${renderCardAction('chat-manager-regen-summary-btn', entry.fileName, 'fa-align-left', 'AI summary', summaryTitle, !isReady)}
                </div>
            </div>
            <div class="chat-manager-card-file-row">
                <span class="chat-manager-card-filename">${escapeHtml(entry.fileName)}</span>
                ${renderCardAction('chat-manager-rename-file-btn', entry.fileName, 'fa-file-pen', 'Rename file', 'Rename the chat file on disk')}
            </div>
        </div>`;
    }

    return html;
}

// ──────────────────────────────────────────────
//  Filter Toolbar & Dropdowns
// ──────────────────────────────────────────────

let activeDropdown = null;

function dismissDropdown() {
    if (activeDropdown) {
        activeDropdown.remove();
        activeDropdown = null;
    }
    document.removeEventListener('click', handleDropdownOutsideClick, true);
}

function handleDropdownOutsideClick(e) {
    if (activeDropdown && !activeDropdown.contains(e.target)) {
        dismissDropdown();
    }
}

function showDropdown(anchorEl, dropdown) {
    dismissDropdown();
    document.body.appendChild(dropdown);
    activeDropdown = dropdown;

    // Position below anchor
    const rect = anchorEl.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.right = `${window.innerWidth - rect.right}px`;
    dropdown.style.left = 'auto';

    // Ensure it doesn't overflow viewport
    requestAnimationFrame(() => {
        const dropRect = dropdown.getBoundingClientRect();
        if (dropRect.bottom > window.innerHeight - 8) {
            dropdown.style.top = `${rect.top - dropRect.height - 4}px`;
        }
        if (dropRect.left < 8) {
            dropdown.style.left = '8px';
            dropdown.style.right = 'auto';
        }
    });

    setTimeout(() => document.addEventListener('click', handleDropdownOutsideClick, true), 0);
}

/**
 * Ensure the filter/sort toolbar exists between search and status bar.
 * Creates it once and updates active indicators.
 */
function ensureFilterToolbar() {
    const searchWrapper = _getSearchWrapper();
    if (!searchWrapper) return;

    let toolbar = _getFilterToolbar();
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.className = 'chat-manager-filter-toolbar';

        const sortState = getSortState();
        const sortFieldLabels = { recency: 'Recent', alphabetical: 'A-Z', messageCount: 'Messages', created: 'Created', cluster: 'Cluster' };

        // Sort controls
        const sortDiv = document.createElement('div');
        sortDiv.className = 'chat-manager-sort-controls';

        const select = document.createElement('select');
        select.className = 'chat-manager-sort-select';
        for (const [value, label] of Object.entries(sortFieldLabels)) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === sortState.field) opt.selected = true;
            select.appendChild(opt);
        }
        select.addEventListener('change', () => {
            const current = getSortState();
            const nextField = select.value;
            if (nextField === 'cluster') {
                const secondaryField = current.field && current.field !== 'cluster'
                    ? current.field
                    : (current.secondaryField && current.secondaryField !== 'cluster' ? current.secondaryField : 'recency');
                setSortState({ field: nextField, secondaryField });
            } else {
                setSortState({ field: nextField, secondaryField: nextField });
            }
            renderThreadCards();
        });

        const dirBtn = document.createElement('button');
        dirBtn.className = 'chat-manager-btn chat-manager-sort-dir-btn chat-manager-labeled-btn';
        dirBtn.title = 'Toggle sort direction';
        updateSortDirIcon(dirBtn, sortState.direction);
        dirBtn.addEventListener('click', () => {
            const current = getSortState();
            const newDir = current.direction === 'desc' ? 'asc' : 'desc';
            setSortState({ direction: newDir });
            updateSortDirIcon(dirBtn, newDir);
            renderThreadCards();
        });

        sortDiv.appendChild(select);
        sortDiv.appendChild(dirBtn);

        // Filter controls
        const filterDiv = document.createElement('div');
        filterDiv.className = 'chat-manager-filter-controls';

        const tagFilterBtn = document.createElement('button');
        tagFilterBtn.className = 'chat-manager-btn chat-manager-filter-btn chat-manager-tag-filter-btn chat-manager-labeled-btn';
        tagFilterBtn.title = 'Filter by tags';
        tagFilterBtn.innerHTML = '<i class="fa-solid fa-tags" aria-hidden="true"></i><span>Tags</span>';
        tagFilterBtn.addEventListener('click', (e) => { e.stopPropagation(); showTagFilterDropdown(tagFilterBtn); });

        const advFilterBtn = document.createElement('button');
        advFilterBtn.className = 'chat-manager-btn chat-manager-filter-btn chat-manager-adv-filter-btn chat-manager-labeled-btn';
        advFilterBtn.title = 'Advanced filters';
        advFilterBtn.innerHTML = '<i class="fa-solid fa-filter" aria-hidden="true"></i><span>Filters</span>';
        advFilterBtn.addEventListener('click', (e) => { e.stopPropagation(); showAdvancedFilterDropdown(advFilterBtn); });

        const clearBtn = document.createElement('button');
        clearBtn.className = 'chat-manager-btn chat-manager-clear-filters-btn chat-manager-labeled-btn';
        clearBtn.title = 'Clear all filters';
        clearBtn.innerHTML = '<i class="fa-solid fa-filter-circle-xmark" aria-hidden="true"></i><span>Clear filters</span>';
        clearBtn.addEventListener('click', () => { clearFilterState(); refreshAfterFilterChange(); });

        const selectVisibleEmbBtn = document.createElement('button');
        selectVisibleEmbBtn.className = 'chat-manager-btn chat-manager-emb-scope-btn chat-manager-emb-select-visible-btn';
        selectVisibleEmbBtn.textContent = 'Select Matching';
        selectVisibleEmbBtn.addEventListener('click', () => {
            const visibleFiles = getVisibleEntryFileNames();
            if (visibleFiles.length === 0) return;
            const selected = new Set(getSelectedEmbeddingChats());
            for (const fileName of visibleFiles) {
                selected.add(fileName);
            }
            setSelectedEmbeddingChats(Array.from(selected));
            renderThreadCards();
        });

        const clearVisibleEmbBtn = document.createElement('button');
        clearVisibleEmbBtn.className = 'chat-manager-btn chat-manager-emb-scope-btn chat-manager-emb-clear-visible-btn';
        clearVisibleEmbBtn.textContent = 'Clear Matching';
        clearVisibleEmbBtn.addEventListener('click', () => {
            const visibleSet = new Set(getVisibleEntryFileNames());
            if (visibleSet.size === 0) return;
            const retained = getSelectedEmbeddingChats().filter(fileName => !visibleSet.has(fileName));
            setSelectedEmbeddingChats(retained);
            renderThreadCards();
        });

        const embedTriggerBtn = document.createElement('button');
        embedTriggerBtn.className = 'chat-manager-btn chat-manager-emb-scope-btn chat-manager-emb-trigger-btn';
        embedTriggerBtn.textContent = 'Embed Matching';
        embedTriggerBtn.addEventListener('click', () => handleToolbarEmbedTrigger());

        filterDiv.appendChild(tagFilterBtn);
        filterDiv.appendChild(advFilterBtn);
        filterDiv.appendChild(clearBtn);
        filterDiv.appendChild(selectVisibleEmbBtn);
        filterDiv.appendChild(clearVisibleEmbBtn);
        filterDiv.appendChild(embedTriggerBtn);

        toolbar.appendChild(sortDiv);
        toolbar.appendChild(filterDiv);

        searchWrapper.after(toolbar);
    }

    // Update active indicators
    const tagFilterBtn = toolbar.querySelector('.chat-manager-tag-filter-btn');
    const advFilterBtn = toolbar.querySelector('.chat-manager-adv-filter-btn');
    const clearBtn = toolbar.querySelector('.chat-manager-clear-filters-btn');
    const f = getFilterState();

    if (tagFilterBtn) tagFilterBtn.classList.toggle('has-active', f.tags.length > 0);
    if (advFilterBtn) {
        advFilterBtn.classList.toggle(
            'has-active',
            !!(f.dateFrom || f.dateTo || Number.isFinite(f.messageCountMin) || Number.isFinite(f.messageCountMax)),
        );
    }
    if (clearBtn) clearBtn.style.display = hasActiveFilter() ? '' : 'none';
    updateEmbeddingSelectionControls(toolbar);

    // Hide toolbar when search or other alternate visualization modes are active.
    // The graph view is the exception: it keeps the toolbar but collapses it to
    // the filter controls (via the 'graph-scope' class) since the date/tag
    // filters apply there too, while sort and embed-scope buttons do not.
    const query = getCurrentSearchQuery();
    const hideForOtherView = timelineActive || semanticMapActive || statsActive;
    toolbar.classList.toggle('graph-scope', graphViewActive);
    toolbar.style.display = (query.length >= 2 || hideForOtherView) ? 'none' : '';
}

function updateSortDirIcon(btn, direction) {
    const descending = direction === 'desc';
    btn.innerHTML = descending
        ? '<i class="fa-solid fa-arrow-down-wide-short" aria-hidden="true"></i><span>Descending</span>'
        : '<i class="fa-solid fa-arrow-up-wide-short" aria-hidden="true"></i><span>Ascending</span>';
    btn.title = `${descending ? 'Descending' : 'Ascending'} order; click to reverse`;
}

function showTagFilterDropdown(anchorEl) {
    const dropdown = document.createElement('div');
    dropdown.className = 'chat-manager-dropdown';

    const tagDefs = getTagDefinitions();
    const filterTags = getFilterState().tags;

    for (const [tagId, def] of Object.entries(tagDefs)) {
        const item = document.createElement('label');
        item.className = 'chat-manager-dropdown-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = filterTags.includes(tagId);
        cb.addEventListener('change', () => {
            const current = getFilterState().tags.slice();
            if (cb.checked) {
                if (!current.includes(tagId)) current.push(tagId);
            } else {
                const idx = current.indexOf(tagId);
                if (idx !== -1) current.splice(idx, 1);
            }
            setFilterState({ tags: current });
            refreshAfterFilterChange();
        });

        const dot = document.createElement('span');
        dot.className = 'chat-manager-dropdown-color-dot';
        dot.style.background = def.color;

        const label = document.createElement('span');
        label.textContent = def.name;

        item.appendChild(cb);
        item.appendChild(dot);
        item.appendChild(label);
        dropdown.appendChild(item);
    }

    showDropdown(anchorEl, dropdown);
}

function showAdvancedFilterDropdown(anchorEl) {
    const dropdown = document.createElement('div');
    dropdown.className = 'chat-manager-dropdown chat-manager-adv-filter';
    const f = getFilterState();

    const basis = f.dateBasis === 'created' ? 'created' : 'lastActivity';
    dropdown.innerHTML = `
        <label>Date basis</label>
        <div class="chat-manager-date-basis" role="group">
            <button type="button" class="chat-manager-btn cm-af-basis ${basis === 'lastActivity' ? 'active' : ''}" data-basis="lastActivity">Last activity</button>
            <button type="button" class="chat-manager-btn cm-af-basis ${basis === 'created' ? 'active' : ''}" data-basis="created">Created</button>
        </div>
        <label>Quick range</label>
        <div class="chat-manager-date-presets">
            <button type="button" class="chat-manager-btn cm-af-preset" data-days="7">7 days</button>
            <button type="button" class="chat-manager-btn cm-af-preset" data-days="30">30 days</button>
            <button type="button" class="chat-manager-btn cm-af-preset" data-days="90">90 days</button>
            <button type="button" class="chat-manager-btn cm-af-preset" data-days="year">This year</button>
        </div>
        <label>Date from</label>
        <input type="date" class="cm-af-date-from" value="${escapeAttr(f.dateFrom || '')}">
        <label>Date to</label>
        <input type="date" class="cm-af-date-to" value="${escapeAttr(f.dateTo || '')}">
        <label>Min messages</label>
        <input type="number" class="cm-af-count-min" min="0" value="${f.messageCountMin ?? ''}">
        <label>Max messages</label>
        <input type="number" class="cm-af-count-max" min="0" value="${f.messageCountMax ?? ''}">
        <div class="chat-manager-adv-filter-actions">
            <button class="chat-manager-btn cm-af-clear">Clear</button>
            <button class="chat-manager-btn cm-af-apply">Apply</button>
        </div>
    `;

    // Date-basis toggle — exclusive selection within the group.
    let selectedBasis = basis;
    dropdown.querySelectorAll('.cm-af-basis').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedBasis = btn.dataset.basis;
            dropdown.querySelectorAll('.cm-af-basis').forEach(b => b.classList.toggle('active', b === btn));
        });
    });

    // Quick presets fill the From field with a date relative to today.
    const toISODate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    dropdown.querySelectorAll('.cm-af-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
            const now = new Date();
            let from;
            if (btn.dataset.days === 'year') {
                from = new Date(now.getFullYear(), 0, 1);
            } else {
                from = new Date(now);
                from.setDate(from.getDate() - parseInt(btn.dataset.days, 10));
            }
            dropdown.querySelector('.cm-af-date-from').value = toISODate(from);
            dropdown.querySelector('.cm-af-date-to').value = toISODate(now);
        });
    });

    dropdown.querySelector('.cm-af-apply').addEventListener('click', () => {
        const dateFrom = dropdown.querySelector('.cm-af-date-from').value || null;
        const dateTo = dropdown.querySelector('.cm-af-date-to').value || null;
        const minVal = dropdown.querySelector('.cm-af-count-min').value;
        const maxVal = dropdown.querySelector('.cm-af-count-max').value;
        setFilterState({
            dateFrom,
            dateTo,
            dateBasis: selectedBasis,
            messageCountMin: parseMessageCountFilterInput(minVal),
            messageCountMax: parseMessageCountFilterInput(maxVal),
        });
        dismissDropdown();
        refreshAfterFilterChange();
    });

    dropdown.querySelector('.cm-af-clear').addEventListener('click', () => {
        setFilterState({ dateFrom: null, dateTo: null, messageCountMin: null, messageCountMax: null });
        dismissDropdown();
        refreshAfterFilterChange();
    });

    // Prevent dropdown from closing when clicking inside form elements
    dropdown.addEventListener('click', (e) => e.stopPropagation());

    showDropdown(anchorEl, dropdown);
}

/**
 * Show tag assignment dropdown for a specific card.
 */
function showTagAssignDropdown(anchorEl, fileName) {
    const dropdown = document.createElement('div');
    dropdown.className = 'chat-manager-dropdown';

    const tagDefs = getTagDefinitions();
    const chatTags = getChatTags(fileName);

    for (const [tagId, def] of Object.entries(tagDefs)) {
        const item = document.createElement('label');
        item.className = 'chat-manager-dropdown-item';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = chatTags.includes(tagId);
        cb.addEventListener('change', () => {
            if (cb.checked) {
                addChatTag(fileName, tagId);
            } else {
                removeChatTag(fileName, tagId);
            }
            // Update tag chips on the card in-place
            patchCardTags(fileName);
        });

        const dot = document.createElement('span');
        dot.className = 'chat-manager-dropdown-color-dot';
        dot.style.background = def.color;

        const label = document.createElement('span');
        label.textContent = def.name;

        item.appendChild(cb);
        item.appendChild(dot);
        item.appendChild(label);
        dropdown.appendChild(item);
    }

    const sep = document.createElement('hr');
    sep.className = 'chat-manager-dropdown-sep';
    dropdown.appendChild(sep);

    const manageLink = document.createElement('div');
    manageLink.className = 'chat-manager-dropdown-link';
    manageLink.textContent = 'Manage tags\u2026';
    manageLink.addEventListener('click', () => {
        dismissDropdown();
        openTagManagerDialog();
    });
    dropdown.appendChild(manageLink);

    showDropdown(anchorEl, dropdown);
}

/**
 * Update tag chips on a card after tag assignment changes.
 */
function patchCardTags(fileName) {
    const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(fileName)}"]`);
    if (!card) return;

    const tagDefs = getTagDefinitions();
    const chatTags = getChatTags(fileName);

    let tagsRow = card.querySelector('.chat-manager-card-tags');
    if (chatTags.length === 0) {
        if (tagsRow) tagsRow.remove();
        return;
    }

    if (!tagsRow) {
        tagsRow = document.createElement('div');
        tagsRow.className = 'chat-manager-card-tags';
        const header = card.querySelector('.chat-manager-card-header');
        if (header) header.after(tagsRow);
    }

    tagsRow.innerHTML = '';
    for (const tagId of chatTags) {
        const def = tagDefs[tagId];
        if (!def) continue;
        const chip = document.createElement('span');
        chip.className = 'chat-manager-tag-chip';
        chip.style.background = def.color;
        chip.style.color = def.textColor;
        chip.textContent = def.name;
        tagsRow.appendChild(chip);
    }
}

/**
 * Open the tag management dialog using SillyTavern Popup API.
 */
function openTagManagerDialog() {
    const context = SillyTavern.getContext();
    const { Popup, POPUP_TYPE } = context;

    const tagDefs = getTagDefinitions();

    let listHtml = '';
    for (const [tagId, def] of Object.entries(tagDefs)) {
        listHtml += `
        <div class="chat-manager-tag-manager-row" data-tag-id="${escapeAttr(tagId)}">
            <input type="color" class="cm-tag-color" value="${escapeAttr(def.color)}">
            <input type="text" class="cm-tag-name" value="${escapeAttr(def.name)}">
            <button class="chat-manager-btn chat-manager-tag-manager-delete" title="Delete tag" aria-label="Delete tag"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
        </div>`;
    }

    const html = `
    <div class="chat-manager-tag-manager">
        <h4 style="margin:0 0 10px">Manage Tags</h4>
        <div class="chat-manager-tag-manager-list">${listHtml}</div>
        <div class="chat-manager-tag-manager-add">
            <input type="color" class="cm-new-tag-color" value="#607D8B">
            <input type="text" class="cm-new-tag-name" placeholder="New tag name...">
            <button class="chat-manager-btn cm-new-tag-add">Add</button>
        </div>
    </div>`;

    const popup = new Popup(html, POPUP_TYPE.TEXT, '', { okButton: 'Done', wide: false, large: false });
    popup.show();

    // Wait for popup DOM
    requestAnimationFrame(() => {
        const popupEl = document.querySelector('.chat-manager-tag-manager');
        if (!popupEl) return;

        // Bind inline editing
        popupEl.querySelectorAll('.chat-manager-tag-manager-row').forEach(row => {
            const tagId = row.dataset.tagId;
            const colorInput = row.querySelector('.cm-tag-color');
            const nameInput = row.querySelector('.cm-tag-name');
            const deleteBtn = row.querySelector('.chat-manager-tag-manager-delete');

            colorInput.addEventListener('change', () => updateTagDefinition(tagId, { color: colorInput.value }));
            nameInput.addEventListener('change', () => updateTagDefinition(tagId, { name: nameInput.value.trim() }));

            deleteBtn.addEventListener('click', () => {
                deleteTagDefinition(tagId);
                row.remove();
            });
        });

        // Add new tag
        const addBtn = popupEl.querySelector('.cm-new-tag-add');
        const newColor = popupEl.querySelector('.cm-new-tag-color');
        const newName = popupEl.querySelector('.cm-new-tag-name');

        addBtn.addEventListener('click', () => {
            const name = newName.value.trim();
            if (!name) return;
            const created = createTagDefinition(name, newColor.value);
            if (!created) {
                toastr.warning('A tag with that name already exists.');
                return;
            }
            // Add row to list
            const list = popupEl.querySelector('.chat-manager-tag-manager-list');
            const row = document.createElement('div');
            row.className = 'chat-manager-tag-manager-row';
            row.dataset.tagId = created.id;
            row.innerHTML = `
                <input type="color" class="cm-tag-color" value="${escapeAttr(created.color)}">
                <input type="text" class="cm-tag-name" value="${escapeAttr(created.name)}">
                <button class="chat-manager-btn chat-manager-tag-manager-delete" title="Delete tag" aria-label="Delete tag"><i class="fa-solid fa-trash" aria-hidden="true"></i></button>
            `;
            row.querySelector('.cm-tag-color').addEventListener('change', (e) => updateTagDefinition(created.id, { color: e.target.value }));
            row.querySelector('.cm-tag-name').addEventListener('change', (e) => updateTagDefinition(created.id, { name: e.target.value.trim() }));
            row.querySelector('.chat-manager-tag-manager-delete').addEventListener('click', () => { deleteTagDefinition(created.id); row.remove(); });
            list.appendChild(row);
            newName.value = '';
        });

        newName.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addBtn.click();
            }
        });
    });
}

// ──────────────────────────────────────────────
//  Rendering: Search Results
// ──────────────────────────────────────────────

function renderSearchState(container, status, queryText) {
    threadLists.delete(container);
    if (!searchState) return;
    if (status) setSearchStatus(queryText);

    if (searchState.results.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No results found.</div>';
        return;
    }

    container.innerHTML = '';
    renderSearchPage(container, 0);
}

function getQueryEmbeddingKey(query, settings) {
    const credentialIdentity = hashEmbeddingText(String(settings.apiKey || ''));
    return [
        settings.provider || '',
        settings.model || '',
        settings.provider === 'ollama' ? (settings.ollamaUrl || '') : credentialIdentity,
        query,
    ].join('\u0000');
}

export async function getSemanticQueryEmbedding(query) {
    const settings = getEmbeddingSettings();
    const key = getQueryEmbeddingKey(query, settings);
    const epoch = queryEmbeddingEpoch;
    const cached = queryEmbeddingCache.get(key);
    if (cached) return cached;

    let inFlight = queryEmbeddingInFlight.get(key);
    if (!inFlight) {
        inFlight = embedText(query, { level: 'query' });
        queryEmbeddingInFlight.set(key, inFlight);
    }

    try {
        const vector = await inFlight;
        if (queryEmbeddingEpoch === epoch && getQueryEmbeddingKey(query, getEmbeddingSettings()) === key) {
            queryEmbeddingCache.set(key, vector);
            if (queryEmbeddingCache.size > 32) {
                const firstKey = queryEmbeddingCache.keys().next().value;
                queryEmbeddingCache.delete(firstKey);
            }
        }
        return vector;
    } catch (error) {
        if (isStaleEmbeddingOperationError(error) && error.reason === 'dimensions') {
            clearInMemoryEmbeddings({ rerender: false });
        }
        throw error;
    } finally {
        if (queryEmbeddingInFlight.get(key) === inFlight) queryEmbeddingInFlight.delete(key);
    }
}

export function aggregateSemanticResult(aggregated, dedupKey, result) {
    const existing = aggregated.get(dedupKey);
    if (!existing) {
        result._fileRanks = new Map([[result.item.filename, { score: result.combinedScore, order: result._semanticOrder }]]);
        aggregated.set(dedupKey, result);
        return;
    }

    const ranks = existing._fileRanks || new Map();
    const priorRank = ranks.get(result.item.filename);
    if (!priorRank || result.combinedScore > priorRank.score) {
        ranks.set(result.item.filename, { score: result.combinedScore, order: result._semanticOrder });
    }
    if (result.combinedScore > existing.combinedScore) {
        result._fileRanks = ranks;
        aggregated.set(dedupKey, result);
    }
}

export function finalizeSemanticResults(aggregated, limit = HYBRID_SEARCH_LIMIT) {
    return [...aggregated.values()]
        .sort((a, b) => (b.combinedScore - a.combinedScore) || (a._semanticOrder - b._semanticOrder))
        .slice(0, Math.max(0, Math.min(HYBRID_SEARCH_LIMIT, Math.floor(limit))))
        .map(result => {
            result.otherFiles = [...(result._fileRanks || new Map()).entries()]
                .filter(([filename]) => filename !== result.item.filename)
                .sort((a, b) => (b[1].score - a[1].score) || (a[1].order - b[1].order))
                .map(([filename]) => filename);
            delete result._fileRanks;
            delete result._semanticOrder;
            return result;
        });
}

async function performArchiveSearch(trimmed, requestId, mode, pageIndex = 0) {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;
    const previous = searchState?.archive && searchState.query === trimmed && searchState.mode === mode ? searchState : null;
    const version = getIndexVersion();
    if (previous && previous.indexVersion !== version) pageIndex = 0;
    const history = pageIndex > 0 && previous ? previous.history.slice(0, pageIndex) : [];
    const excluded = new Map();
    for (const page of history) for (const item of page) {
        if (!excluded.has(item.hash)) excluded.set(item.hash, []);
        excluded.get(item.hash).push(item.reference);
    }
    searchPageAbort?.abort();
    const controller = new AbortController();
    searchPageAbort = controller;
    try {
        const embeddingOperation = mode === 'semantic' ? captureEmbeddingOperation() : null;
        const searchIndex = mode === 'semantic' ? getIndex() : null;
        const searchVersion = getIndexVersion();
        const searchRecipe = settings => JSON.stringify([
            getQueryEmbeddingKey(trimmed, settings), settings.enabled === true,
            settings.embeddingLevels?.query === true, settings.embeddingLevels?.message === true,
            settings.includeAlternateSwipes === true, settings.showAlternateSwipesInResults === true,
            clampPositiveInt(getEmbeddingOption(settings, 'maxSwipesPerMessage', 8), 8),
        ]);
        const recipe = mode === 'semantic' ? searchRecipe(getEmbeddingSettings()) : null;
        // Numeric revisions do not retain evicted chat bodies or vector maps.
        const embeddingVersions = mode === 'semantic'
            ? new Map(Object.entries(searchIndex).map(([file, entry]) => [file, entry.messageEmbeddingVersion])) : null;
        const semanticInputsCurrent = () => {
            if (mode !== 'semantic') return true;
            const current = getIndex();
            if (searchIndex !== current || searchVersion !== getIndexVersion()
                || recipe !== searchRecipe(getEmbeddingSettings()) || !isEmbeddingOperationCurrent(embeddingOperation)) return false;
            for (const [file, revision] of embeddingVersions) {
                if (current[file]?.messageEmbeddingVersion !== revision) return false;
            }
            return true;
        };
        const queryVector = mode === 'semantic' ? await getSemanticQueryEmbedding(trimmed) : null;
        if (embeddingOperation && !isEmbeddingOperationCurrent(embeddingOperation)) throw new DOMException('Embedding settings changed', 'AbortError');
        if (requestId !== latestSearchRequestId || controller.signal.aborted) return;
        if (status) status.textContent = 'Searching saved conversations…';
        const settings = getEmbeddingSettings();
        const page = await searchArchivePage({
            query: trimmed, mode, queryVector, settings, excluded, embeddingOperation,
            limit: mode === 'semantic' ? HYBRID_SEARCH_LIMIT : RESULTS_PAGE_SIZE,
            signal: controller.signal,
            onProgress: scanned => {
                if (requestId === latestSearchRequestId && status) status.textContent = `Searching saved conversations… ${scanned.toLocaleString()} messages checked`;
            },
        });
        if (requestId !== latestSearchRequestId || controller.signal.aborted || !semanticInputsCurrent()) return;
        if (mode === 'semantic' && !page.scanned && searchModeOverride !== 'semantic') {
            return performArchiveSearch(trimmed, requestId, 'keyword');
        }
        history[pageIndex] = page.pageReferences;
        searchState = {
            archive: true, query: trimmed, lowerQuery: trimmed.toLowerCase(), mode,
            queryVector, results: page.results, history, pageIndex,
            indexVersion: getIndexVersion(), totalMatches: pageIndex * RESULTS_PAGE_SIZE + page.results.length,
            limitedResults: mode === 'semantic' && page.hasMore,
            exhausted: mode === 'semantic' || !page.hasMore,
            showAlternateMatches: settings.showAlternateSwipesInResults === true,
        };
        setSearchModeBadge(mode);
        renderSearchState(container, status, trimmed);
    } finally {
        // A superseded request must not release a newer scan's refresh guard.
        if (searchPageAbort === controller) {
            searchPageAbort = null;
            if (searchRefreshPending) scheduleSearchRefresh();
        }
    }
}

async function performSemanticSearch(trimmed, requestId) {
    return performArchiveSearch(trimmed, requestId, 'semantic');
}

async function performKeywordSearch(trimmed, requestId = latestSearchRequestId) {
    return performArchiveSearch(trimmed, requestId, 'keyword');
}

export async function performSearch(query) {
    cancelSearchRefresh();
    searchPageAbort?.abort();
    const requestId = ++latestSearchRequestId;
    const container = document.getElementById('chat-manager-content');
    if (!container) return;

    if (!query || query.trim().length < 2) {
        searchState = null;
        setSearchModeBadge('keyword');
        renderThreadCards();
        return;
    }

    const trimmed = query.trim();

    if (shouldUseSemanticSearch(trimmed)) {
        try {
            await performSemanticSearch(trimmed, requestId);
            return;
        } catch (err) {
            if (err?.name === 'AbortError' || requestId !== latestSearchRequestId) return;
            console.warn(`[${MODULE_NAME}] Semantic search failed, falling back to keyword:`, err);
        }
    }

    if (requestId !== latestSearchRequestId) return;
    try {
        await performKeywordSearch(trimmed, requestId);
    } catch (err) {
        if (err?.name === 'AbortError' || requestId !== latestSearchRequestId) return;
        console.warn(`[${MODULE_NAME}] Archive search failed:`, err);
        const status = document.getElementById('chat-manager-status');
        if (status) status.textContent = 'Search could not finish. Retry when the conversation archive is available.';
    }
}

function setSearchStatus(queryText) {
    const status = document.getElementById('chat-manager-status');
    if (!status || !searchState) return;

    const threadSet = new Set();
    for (const r of searchState.results) {
        threadSet.add(r.item.filename);
        if (r.otherFiles) {
            for (const f of r.otherFiles) threadSet.add(f);
        }
    }
    if (searchState.archive && searchState.mode === 'keyword') {
        const start = searchState.results.length ? searchState.pageIndex * RESULTS_PAGE_SIZE + 1 : 0;
        const end = searchState.pageIndex * RESULTS_PAGE_SIZE + searchState.results.length;
        status.textContent = withIndexingSuffix(`Results ${start}–${end}${searchState.exhausted ? '' : ' · more available'} for: ${queryText}`);
        return;
    }
    const countLabel = searchState.limitedResults ? `Top ${searchState.results.length} matches` : searchState.exhausted
        ? `Found ${searchState.totalMatches} match${searchState.totalMatches !== 1 ? 'es' : ''}`
        : `Found ${searchState.totalMatches}+ match${searchState.totalMatches !== 1 ? 'es' : ''}`;

    status.textContent = withIndexingSuffix(
        `${countLabel} across ${threadSet.size}${searchState.exhausted ? '' : '+'} thread${threadSet.size !== 1 ? 's' : ''} for: ${queryText}`,
    );
}

/**
 * Render a page of search results starting from `fromIndex` within searchState.results.
 * @param {HTMLElement} container
 * @param {number} fromIndex - index into searchState.results to render from
 */
function renderSearchPage(container, fromIndex) {
    if (!searchState) return;

    const { DOMPurify, moment } = SillyTavern.libs;
    const prevChatJumpButtonCount = container.querySelectorAll('.chat-manager-jump-btn').length;
    const prevGraphJumpButtonCount = container.querySelectorAll('.chat-manager-graph-jump-btn').length;
    const prevDedupBadgeCount = container.querySelectorAll('.chat-manager-dedup-badge').length;
    const end = Math.min(fromIndex + RESULTS_PAGE_SIZE, searchState.results.length);
    let html = '';

    const isSemantic = searchState.mode === 'semantic';

    // For semantic results, find min/max scores across ALL results for consistent coloring
    let scoreMin = 1, scoreMax = 0;
    if (isSemantic) {
        for (const r of searchState.results) {
            const s = r.semanticScore ?? 0;
            if (s < scoreMin) scoreMin = s;
            if (s > scoreMax) scoreMax = s;
        }
    }

    for (let i = fromIndex; i < end; i++) {
        const result = searchState.results[i];
        const item = result.item;
        const displayName = getDisplayName(item.filename) || item.filename;
        const roleLabel = item.role === 'user' ? 'User' : 'Character';
        const dateStr = formatDateOrFallback(moment, item.timestamp, '');

        // Build highlighted excerpt
        const excerpt = buildHighlightedExcerpt(result.matchedText ?? item.text, searchState.query);

        let similarityPct = '';
        let scoreAttr = '';
        if (isSemantic && typeof result.semanticScore === 'number') {
            scoreAttr = ` data-sim-score="${result.semanticScore.toFixed(4)}"`;
            similarityPct = ` · ${Math.round(result.semanticScore * 100)}%`;
        }

        let swipeBadge = '';
        if (isSemantic && searchState.showAlternateMatches === true && typeof result.isActiveSwipeMatch === 'boolean') {
            if (result.isActiveSwipeMatch) {
                swipeBadge = '<span class="chat-manager-swipe-hit-badge is-active">Active Swipe</span>';
            } else if (Number.isFinite(result.matchedSwipeIndex)) {
                const swipeOrdinal = Number(result.matchedSwipeIndex) + 1;
                swipeBadge = `<span class="chat-manager-swipe-hit-badge is-alt">Alt Swipe #${swipeOrdinal}</span>`;
            }
        }

        // Dedup badge
        let dedupBadge = '';
        if (result.otherFiles && result.otherFiles.length > 0) {
            const otherNames = result.otherFiles.map(f => escapeAttr(f));
            dedupBadge = `<span class="chat-manager-dedup-badge" data-other-files="${otherNames.join('|')}" data-msg-index="${item.index}">+ ${result.otherFiles.length} other thread${result.otherFiles.length !== 1 ? 's' : ''}</span>`;
        }

        html += `
        <div class="chat-manager-search-result"${scoreAttr} data-filename="${escapeAttr(item.filename)}" data-msg-index="${item.index}">
            <div class="chat-manager-result-header">
                <span class="chat-manager-result-thread">${escapeHtml(displayName)}</span>
                ${swipeBadge}
                ${dedupBadge}
            </div>
            <div class="chat-manager-result-meta">
                Message #${item.index} (${roleLabel}${dateStr ? ', ' + dateStr : ''}${similarityPct})
            </div>
            <div class="chat-manager-result-excerpt">${excerpt}</div>
            <div class="chat-manager-result-actions">
                <button class="chat-manager-btn chat-manager-jump-btn" data-filename="${escapeAttr(item.filename)}" data-msg-index="${item.index}">Jump to message</button>
                <button class="chat-manager-btn chat-manager-graph-jump-btn" data-filename="${escapeAttr(item.filename)}" data-msg-index="${item.index}">Jump in graph</button>
            </div>
        </div>`;
    }

    // Create fragment
    const temp = document.createElement('div');
    temp.innerHTML = DOMPurify.sanitize(html);
    while (temp.firstChild) {
        container.appendChild(temp.firstChild);
    }

    // Apply similarity coloring post-sanitization (DOMPurify strips inline styles)
    if (isSemantic) {
        for (const el of container.querySelectorAll('.chat-manager-search-result[data-sim-score]')) {
            const score = parseFloat(el.dataset.simScore);
            if (!Number.isFinite(score)) continue;
            const t = scoreMax > scoreMin ? (score - scoreMin) / (scoreMax - scoreMin) : 1;
            const hue = 200 + t * (140 - 200); // 200 (blue) → 140 (green)
            const sat = 70 + t * 20;
            const light = 50 + t * 10;
            const alpha = 0.35 + t * 0.45;
            el.style.borderLeft = `3px solid hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
        }
    }

    // Remove any existing load-more button
    const existingBtn = container.querySelector('.chat-manager-load-more');
    if (existingBtn) existingBtn.remove();

    // Add load more button if there are more results already found, or more to search
    const displayedUpTo = end;
    const hasMoreFound = displayedUpTo < searchState.results.length;

    if (searchState.archive && searchState.mode === 'keyword') {
        const current = searchState;
        const addPageButton = (label, pageIndex) => {
            const button = document.createElement('button');
            button.className = 'chat-manager-btn chat-manager-load-more';
            button.textContent = label;
            button.addEventListener('click', async () => {
                if (searchState !== current) return;
                button.disabled = true;
                try {
                    await performArchiveSearch(current.query, latestSearchRequestId, current.mode, pageIndex);
                } catch (err) {
                    if (err?.name !== 'AbortError') {
                        console.warn(`[${MODULE_NAME}] Search page failed:`, err);
                        button.disabled = false;
                        button.textContent = 'Retry page';
                    }
                }
            });
            container.appendChild(button);
        };
        if (current.pageIndex > 0) addPageButton('Previous results', current.pageIndex - 1);
        if (!current.exhausted) addPageButton('Next results', current.pageIndex + 1);
    } else if (hasMoreFound) {
        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.className = 'chat-manager-btn chat-manager-load-more';

        loadMoreBtn.textContent = `Load more (${searchState.results.length - displayedUpTo} remaining)`;
        loadMoreBtn.addEventListener('click', () => {
            // Update status
            const status = document.getElementById('chat-manager-status');
            if (status) setSearchStatus(searchState.query);

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
    const allChatJumpButtons = container.querySelectorAll('.chat-manager-jump-btn');
    for (let i = prevChatJumpButtonCount; i < allChatJumpButtons.length; i++) {
        allChatJumpButtons[i].addEventListener('click', handleJumpToMessage);
    }

    const allGraphJumpButtons = container.querySelectorAll('.chat-manager-graph-jump-btn');
    for (let i = prevGraphJumpButtonCount; i < allGraphJumpButtons.length; i++) {
        allGraphJumpButtons[i].addEventListener('click', handleJumpToGraphMessage);
    }

    // Bind dedup badges (expand/collapse other threads list)
    const allDedupBadges = container.querySelectorAll('.chat-manager-dedup-badge');
    for (let i = prevDedupBadgeCount; i < allDedupBadges.length; i++) {
        allDedupBadges[i].addEventListener('click', handleDedupBadgeClick);
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
    container.addEventListener('click', handleCardContainerClick);
    container.addEventListener('change', handleCardContainerChange);
}

function handleCardContainerClick(e) {
    const target = e.target;

    // Embedding checkbox — stop propagation so card click doesn't fire
    if (target.closest('.chat-manager-emb-select-cb')) {
        e.stopPropagation();
        return;
    }

    const displayName = target.closest('.chat-manager-display-name');
    if (displayName) { handleSwitchThread({ currentTarget: displayName }); return; }

    const editNameBtn = target.closest('.chat-manager-edit-name-btn');
    if (editNameBtn) { handleEditDisplayName({ stopPropagation: () => e.stopPropagation(), currentTarget: editNameBtn }); return; }

    const tagBtn = target.closest('.chat-manager-tag-btn');
    if (tagBtn) { handleTagButton({ stopPropagation: () => e.stopPropagation(), currentTarget: tagBtn }); return; }

    const aiTitleBtn = target.closest('.chat-manager-ai-title-btn');
    if (aiTitleBtn) { handleAITitle({ stopPropagation: () => e.stopPropagation(), currentTarget: aiTitleBtn }); return; }

    const aiSummaryTitleBtn = target.closest('.chat-manager-ai-summarize-title-btn');
    if (aiSummaryTitleBtn) { handleAISummaryAndTitle({ stopPropagation: () => e.stopPropagation(), currentTarget: aiSummaryTitleBtn }); return; }

    const renameBtn = target.closest('.chat-manager-rename-file-btn');
    if (renameBtn) { handleRenameFile({ stopPropagation: () => e.stopPropagation(), currentTarget: renameBtn }); return; }

    const embedCardBtn = target.closest('.chat-manager-embed-card-btn');
    if (embedCardBtn) { handleEmbedSingleCard({ stopPropagation: () => e.stopPropagation(), currentTarget: embedCardBtn }); return; }

    const editSummaryBtn = target.closest('.chat-manager-edit-summary-btn');
    if (editSummaryBtn) { handleEditSummary({ stopPropagation: () => e.stopPropagation(), currentTarget: editSummaryBtn }); return; }

    const regenBtn = target.closest('.chat-manager-regen-summary-btn');
    if (regenBtn) { handleRegenSummary({ stopPropagation: () => e.stopPropagation(), currentTarget: regenBtn }); return; }

    const branchJump = target.closest('.chat-manager-branch-jump');
    if (branchJump) { handleJumpToGraphMessage({ stopPropagation: () => e.stopPropagation(), currentTarget: branchJump }); return; }

    const driftJump = target.closest('.chat-manager-drift-jump');
    if (driftJump) { handleJumpToGraphMessage({ stopPropagation: () => e.stopPropagation(), currentTarget: driftJump }); return; }
}

function handleCardContainerChange(e) {
    const cb = e.target.closest('.chat-manager-emb-select-cb');
    if (cb) {
        e.stopPropagation();
        handleEmbeddingSelectionToggle({ stopPropagation: () => e.stopPropagation(), currentTarget: cb });
    }
}

function handleEmbeddingSelectionToggle(e) {
    e.stopPropagation();
    const input = e.currentTarget;
    const filename = input?.dataset?.filename;
    if (!filename) return;
    setEmbeddingChatSelected(filename, input.checked);
    updateEmbeddingSelectionControls();
}

function handleTagButton(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    if (!filename) return;
    showTagAssignDropdown(e.currentTarget, filename);
}

async function handleSwitchThread(e) {
    const filename = e.currentTarget.dataset.filename;
    if (!filename) return;

    const activeChatFile = getActiveFilename();
    if (filename === activeChatFile) return;

    await navigateToChat(filename, null, {
        ...chatNavigationOptions(filename),
        beforeOpen: () => { if (getDisplayMode() === 'popup') closePanel(); },
    });
}

function handleEditDisplayName(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const context = SillyTavern.getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) return;
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

        if (cancelled) {
            span.textContent = currentName;
            input.replaceWith(span);
            return;
        }

        const newName = input.value.trim();
        setChatMeta(filename, { displayName: newName === filename ? '' : newName, titleEditedByUser: true }, avatar);
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

async function captureChatAction(filename, entry, { titleOnly = false } = {}) {
    const context = SillyTavern.getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) throw new Error('No character selected');
    const characterName = context.name2 || 'Character';
    const initialMeta = JSON.stringify(getChatMeta(filename, avatar));
    const windowSize = titleOnly ? 15 : 30;
    const snapshot = (source, live) => {
        const selected = [];
        let count = 0;
        for (let i = source.length - 1; i >= 0; i--) {
            const message = source[i];
            const text = live ? message?.mes : message?.text;
            if (typeof text !== 'string') continue;
            if (selected.length < windowSize) selected.push({ role: live ? (message.is_user ? 'user' : 'assistant') : message.role, text });
            count++;
        }
        selected.reverse();
        return { messages: selected, dropped: Math.max(0, count - selected.length) };
    };
    const captured = filename === getActiveFilename() && Array.isArray(context.chat)
        ? snapshot(context.chat, true)
        : snapshot(await readChatMessages(filename), false);
    if (!isCurrentActionCharacter({ avatar })) throw new DOMException('Character changed', 'AbortError');
    const includeSiblings = branchContextActive && !titleOnly;
    const siblingContext = includeSiblings ? await getSummarySiblingContextText(filename, characterName) : '';
    if (includeSiblings && !isCurrentActionCharacter({ avatar })) throw new DOMException('Character changed', 'AbortError');
    return {
        avatar, filename, messages: captured.messages, characterName, initialMeta,
        branchPoint: entry.branchPoint == null ? null : Math.max(-1, entry.branchPoint - captured.dropped), siblingContext,
    };

}

function isCurrentActionCharacter(action) {
    const context = SillyTavern.getContext();
    return context.characters?.[context.characterId]?.avatar === action.avatar;
}

async function handleAITitle(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const filename = btn.dataset.filename;
    if (btn.classList.contains('disabled')) return;

    const index = getIndex();
    const entry = index[filename];
    if (!entry || !entry.isLoaded || (entry.needsHydration && filename !== getActiveFilename())) {
        toastr.info('This thread is still indexing. Try again in a moment.');
        return;
    }

    setActionBusy(btn, true);

    try {
        const action = await captureChatAction(filename, entry, { titleOnly: true });
        const initialMeta = action.initialMeta;
        const title = await generateTitleForChat(action.messages, action.characterName);

        if (title && JSON.stringify(getChatMeta(filename, action.avatar)) === initialMeta) {
            setChatMeta(filename, { displayName: title, titleEditedByUser: false }, action.avatar);
            // Update the UI
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card && isCurrentActionCharacter(action)) {
                const nameEl = card.querySelector('.chat-manager-display-name');
                if (nameEl) nameEl.textContent = title;
            }
            toastr.success('Title generated!');
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] AI title generation failed:`, err);
        toastr.error('Failed to generate title.');
    } finally {
        setActionBusy(btn, false);
    }
}

async function handleAISummaryAndTitle(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const filename = btn.dataset.filename;
    if (btn.classList.contains('disabled')) return;

    const index = getIndex();
    const entry = index[filename];
    if (!entry || !entry.isLoaded || (entry.needsHydration && filename !== getActiveFilename())) {
        toastr.info('This thread is still indexing. Try again in a moment.');
        return;
    }

    setActionBusy(btn, true);

    try {
        const action = await captureChatAction(filename, entry);
        const initialMeta = action.initialMeta;
        const summary = await generateSummaryForChat(action.messages, action.characterName, action.branchPoint, action.siblingContext);
        const title = await generateTitleForChat(action.messages, action.characterName);

        const unchanged = JSON.stringify(getChatMeta(filename, action.avatar)) === initialMeta;
        if (summary && unchanged) {
            setChatMeta(filename, { summary, summaryEditedByUser: false }, action.avatar);
        }
        if (title && unchanged) {
            setChatMeta(filename, { displayName: title, titleEditedByUser: false }, action.avatar);
        }

        if (summary || title) {
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card && isCurrentActionCharacter(action)) {
                if (title && unchanged) {
                    const nameEl = card.querySelector('.chat-manager-display-name');
                    if (nameEl) nameEl.textContent = title;
                }
                if (summary && unchanged) {
                    const textEl = card.querySelector('.chat-manager-summary-text');
                    if (textEl) {
                        patchSummaryTextElement(textEl, entry || { fileName: filename, isLoaded: false, messages: [] });
                    }
                }
            }
        }

        if (summary && title) {
            toastr.success('Summary and title generated!');
        } else if (summary) {
            toastr.success('Summary generated; AI title was empty.');
        } else if (title) {
            toastr.success('Title generated; AI summary was empty.');
        } else {
            toastr.warning('AI did not return a summary or title.');
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] AI summary+title generation failed:`, err);
        toastr.error('Failed to generate summary and title.');
    } finally {
        setActionBusy(btn, false);
    }
}

async function handleRenameFile(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const context = SillyTavern.getContext();

    // Use ST's Popup for confirmation
    const { Popup, POPUP_TYPE } = context;
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) return;

    const baseName = filename.replace(/\.jsonl$/, '');

    const popup = new Popup(
        `<div class="chat-manager-rename-dialog">
            <p><strong>Warning:</strong> This will rename the actual chat file on disk. Checkpoints or bookmarks referencing the old filename may break.</p>
            <p>Current filename: <code>${escapeHtml(filename)}</code></p>
            <label>New filename:</label>
            <p class="chat-manager-rename-suffix">.jsonl will be added automatically</p>
        </div>`,
        POPUP_TYPE.INPUT,
        baseName,
        {
            okButton: 'Rename',
            cancelButton: 'Cancel',
        },
    );

    const result = await popup.show();

    if (typeof result !== 'string') return;
    const current = SillyTavern.getContext();
    if (current.characters?.[current.characterId]?.avatar !== avatar) return;
    let newBase = result.trim();

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

    // Pre-check: reject if a file with the target name already exists in the index
    const index = getIndex();
    if (index[newFilename]) {
        toastr.warning(`A chat file named "${newFilename}" already exists. Choose a different name.`);
        return;
    }

    const eventSource = context.eventSource;
    const renamedEvent = (context.eventTypes || context.event_types)?.CHAT_RENAMED;
    if (!eventSource?.on || !eventSource?.removeListener || !renamedEvent) {
        toastr.error('Cannot verify chat renames in this SillyTavern version.');
        return;
    }
    let confirmedName = null;
    const onRenamed = (event) => {
        if (event?.avatarId === avatar && event.oldFileName === filename && !event.groupId) {
            confirmedName = event.newFileName;
        }
    };
    eventSource.on(renamedEvent, onRenamed);
    try {
        await context.renameChat(baseName, newBase);
        if (!confirmedName) throw new Error('The host did not confirm the rename');
        migrateFileKey(filename, confirmedName, avatar);
        toastr.success(`Renamed to ${confirmedName}`);
        if (isCurrentActionCharacter({ avatar })) await refreshPanel();
    } catch (err) {
        console.error(`[${MODULE_NAME}] Rename failed:`, err);
        // Server returns 400 when destination file already exists (race condition)
        if (err?.status === 400 || String(err).includes('400')) {
            toastr.error(`Rename failed — a file named "${newFilename}" may already exist.`);
        } else {
            toastr.error('Failed to rename chat file.');
        }
    } finally {
        eventSource.removeListener(renamedEvent, onRenamed);
    }
}

function handleEditSummary(e) {
    e.stopPropagation();
    const filename = e.currentTarget.dataset.filename;
    const context = SillyTavern.getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;
    if (!avatar) return;
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
        setChatMeta(filename, { summary: newSummary, summaryEditedByUser: true }, avatar);

        const p = document.createElement('p');
        const entry = getIndex()[filename] || { fileName: filename, isLoaded: false, messages: [] };
        patchSummaryTextElement(p, entry);
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

    const index = getIndex();
    const entry = index[filename];
    if (!entry || !entry.isLoaded || (entry.needsHydration && filename !== getActiveFilename())) {
        toastr.info('This thread is still indexing. Try again in a moment.');
        return;
    }

    setActionBusy(btn, true);

    try {
        const action = await captureChatAction(filename, entry);
        const initialMeta = action.initialMeta;
        const summary = await generateSummaryForChat(action.messages, action.characterName, action.branchPoint, action.siblingContext);

        if (summary && JSON.stringify(getChatMeta(filename, action.avatar)) === initialMeta) {
            setChatMeta(filename, { summary, summaryEditedByUser: false }, action.avatar);
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card && isCurrentActionCharacter(action)) {
                const textEl = card.querySelector('.chat-manager-summary-text');
                if (textEl) {
                    patchSummaryTextElement(textEl, entry || { fileName: filename, isLoaded: false, messages: [] });
                }
            }
            toastr.success('Summary generated!');
        }
    } catch (err) {
        console.error(`[${MODULE_NAME}] AI summary generation failed:`, err);
        toastr.error('Failed to generate summary.');
    } finally {
        setActionBusy(btn, false);
    }
}

async function getSummarySiblingContextText(fileName, characterName) {
    if (!branchContextActive) return '';
    if (!fileName) return '';

    const siblings = await getSiblingMessagesAsync(fileName, { maxSiblings: SUMMARY_SIBLING_BRANCH_LIMIT });
    if (siblings.length === 0) return '';

    const targetDisplayName = getDisplayName(fileName) || fileName;
    return formatBranchContextForSummary(siblings, characterName || 'Character', targetDisplayName);
}

async function handleJumpToMessage(e) {
    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;

    const activeChatFile = getActiveFilename();
    const context = SillyTavern.getContext();
    const avatar = context.characters?.[context.characterId]?.avatar;

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
        if (!isCurrentActionCharacter({ avatar })) return;
    }

    await navigateToChat(filename, msgIndex, chatNavigationOptions(filename));
}

async function handleJumpToGraphMessage(e) {
    e.stopPropagation();

    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;

    const index = getIndex();
    const entry = index[filename];

    const isLoaded = !!entry?.isLoaded;
    if (semanticMapActive) {
        focusMessageInSemanticMap(filename, msgIndex, {
            openPopup: true,
            persistIfMissing: !isLoaded,
        });
    } else {
        focusMessageInIcicle(filename, msgIndex, {
            openPopup: true,
            persistIfMissing: !isLoaded,
        });
        if (!timelineActive) {
            toggleTimeline();
        }
    }

    if (!isLoaded) {
        prioritizeInQueue(filename);
        toastr.info(`Loading thread into ${semanticMapActive ? 'semantic map' : 'graph'}…`);
    }
}

function handleDedupBadgeClick(e) {
    e.stopPropagation();
    const badge = e.currentTarget;
    const resultEl = badge.closest('.chat-manager-search-result');
    if (!resultEl) return;

    // Toggle: if already expanded, collapse
    const existing = resultEl.querySelector('.chat-manager-dedup-list');
    if (existing) {
        existing.remove();
        badge.classList.remove('expanded');
        return;
    }

    const otherFilesStr = badge.dataset.otherFiles;
    const msgIndex = badge.dataset.msgIndex;
    if (!otherFilesStr) return;

    const files = otherFilesStr.split('|').filter(Boolean);
    if (files.length === 0) return;

    badge.classList.add('expanded');

    const list = document.createElement('div');
    list.className = 'chat-manager-dedup-list';

    for (const filename of files) {
        const displayName = getDisplayName(filename) || filename;
        const row = document.createElement('div');
        row.className = 'chat-manager-dedup-item';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'chat-manager-dedup-item-name';
        nameSpan.textContent = displayName;
        row.appendChild(nameSpan);

        const jumpBtn = document.createElement('button');
        jumpBtn.className = 'chat-manager-btn chat-manager-jump-btn';
        jumpBtn.dataset.filename = filename;
        jumpBtn.dataset.msgIndex = msgIndex;
        jumpBtn.textContent = 'Jump';
        jumpBtn.addEventListener('click', handleJumpToMessage);
        row.appendChild(jumpBtn);

        list.appendChild(row);
    }

    // Insert after the header row
    const header = resultEl.querySelector('.chat-manager-result-header');
    if (header && header.nextSibling) {
        resultEl.insertBefore(list, header.nextSibling);
    } else {
        resultEl.appendChild(list);
    }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * UI hooks for the shared serialized navigation operation.
 */
function chatNavigationOptions(filename, displayName = getDisplayName(filename) || filename) {
    return {
        beforeScroll: () => { if (getDisplayMode() === 'popup') closePanel(); },
        onError: (error) => {
            console.warn(`[${MODULE_NAME}] Navigation failed for "${filename}".`, error);
            toastr.warning(`Could not safely switch to "${displayName}". Please switch manually, then jump again.`);
        },
    };
}


/**
 * Parse an advanced message-count input value into a safe persisted filter value.
 * @param {string} value
 * @returns {number|null}
 */
function parseMessageCountFilterInput(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    return Math.floor(parsed);
}

/**
 * Get the currently active chat filename from authoritative context fields.
 */
function getActiveFilename() {
    return resolveActiveChatFilename(SillyTavern.getContext(), getIndex());
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
    if (timelineActive || statsActive || semanticMapActive || graphViewActive) {
        return;
    }

    const toolbar = _getFilterToolbar();
    if (!query || query.trim().length < 2) {
        if (toolbar) toolbar.style.display = '';
        performSearch(query);
    } else {
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        performSearch(query);
    }
}
