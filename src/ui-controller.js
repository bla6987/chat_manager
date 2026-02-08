/**
 * UI Controller — Panel rendering, state management, event binding.
 */

import {
    buildIndex, getHydrationProgress, getIndex, getSearchableMessages, getSortedEntries,
    getFilteredSortedEntries, getIndexVersion,
    isHydrationComplete, onHydrationUpdate, prioritizeInQueue, runDeferredBranchDetection,
} from './chat-reader.js';
import {
    getDisplayName, setDisplayName, getSummary, setSummary,
    migrateFileKey, getDisplayMode, getChatMeta,
    getThreadFocus, setThreadFocus as persistThreadFocus,
    getBranchContextEnabled, setBranchContextEnabled,
    getTagDefinitions, createTagDefinition, updateTagDefinition, deleteTagDefinition,
    getChatTags, addChatTag, removeChatTag,
    getFilterState, setFilterState, clearFilterState, hasActiveFilter,
    getSortState, setSortState, getEmbeddingSettings,
    getSelectedEmbeddingChats, setSelectedEmbeddingChats,
    isEmbeddingChatSelected, setEmbeddingChatSelected,
} from './metadata-store.js';
import {
    updateBranchContextInjection, clearBranchContextInjection,
} from './branch-context.js';
import {
    generateTitleForActiveChat, generateTitleForChat,
    generateSummaryForActiveChat, generateSummaryForChat,
} from './ai-features.js';
import {
    mountIcicle, unmountIcicle, updateIcicleData,
    focusMessageInIcicle, isIcicleMounted, setIcicleCallbacks,
    setThreadFocus as setIcicleThreadFocus,
} from './icicle-view.js';
import {
    mountStatsView, unmountStatsView, updateStatsView,
    isStatsMounted, setStatsCallbacks,
} from './stats-view.js';
import {
    embedText, embedTexts, getCachedEmbeddingForText, hashEmbeddingText, isEmbeddingConfigured,
} from './embedding-service.js';
import { clusterColor, cosineSimilarity, findOptimalK, kMeans, topicShiftScores } from './semantic-engine.js';

const MODULE_NAME = 'chat_manager';
const HYBRID_SEARCH_MIN_CHARS = 5;
const HYBRID_SEARCH_LIMIT = 100;
const RECLUSTER_IDLE_MS = 60000;
const RECLUSTER_IMMEDIATE_THRESHOLD = 5;
const RECLUSTER_CHAT_DELTA_RATIO = 0.2;

let panelOpen = false;
let timelineActive = false;
let statsActive = false;
let branchContextActive = false;
const RESULTS_PAGE_SIZE = 50;
let hydrationSubscriptionReady = false;
let refreshFromHydrationTimer = null;
let refreshSearchFromHydrationTimer = null;
let refreshTimelineFromHydrationTimer = null;
let refreshStatsFromHydrationTimer = null;
let embedBootstrapTimer = null;
let embedIncrementalTimer = null;
const EMBED_INCREMENTAL_DELAY_MS = 1200;
const pendingIncrementalEmbedFiles = new Set();
let embedRunPromise = null;
let pendingClusterChanges = 0;
let reclusterIdleTimer = null;
let lastClusterK = null;
let lastClusterChatCount = 0;
let lastClusterResult = 0;
let latestSearchRequestId = 0;
const queryEmbeddingCache = new Map();
const driftSummaryCache = new Map();

/**
 * Streaming search state — allows early termination and "load more" resumption.
 * @type {{ query: string, lowerQuery: string, searchable: Array, position: number, results: Array, totalMatches: number, exhausted?: boolean, mode?: 'keyword'|'semantic' } | null}
 */
let searchState = null;

export function resetSearchState() {
    latestSearchRequestId += 1;
    searchState = null;
    setSearchModeBadge('keyword');
}

export function isTimelineActive() {
    return timelineActive;
}

export function isStatsActive() {
    return statsActive;
}

export function isBranchContextActive() {
    return branchContextActive;
}

function ensureSearchModeBadge() {
    const wrapper = document.querySelector('.chat-manager-search-wrapper');
    if (!wrapper) return null;

    let badge = wrapper.querySelector('.chat-manager-search-mode-badge');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'chat-manager-search-mode-badge';
        badge.textContent = 'Keyword';
        wrapper.appendChild(badge);
    }
    return badge;
}

function setSearchModeBadge(mode) {
    const badge = ensureSearchModeBadge();
    if (!badge) return;
    const semantic = mode === 'semantic';
    badge.textContent = semantic ? 'Semantic' : 'Keyword';
    badge.classList.toggle('semantic', semantic);
}

function hasMessageEmbeddings() {
    const entries = Object.values(getIndex());
    return entries.some(entry => entry.messageEmbeddings instanceof Map && entry.messageEmbeddings.size > 0);
}

function isEmbeddingLevelOn(settings, level) {
    return settings.enabled === true && settings.embeddingLevels?.[level] === true;
}

function getVisibleEntryFileNames() {
    const filterState = getFilterState();
    const sortState = getSortState();
    return getFilteredSortedEntries(filterState, sortState, getChatMeta).map(entry => entry.fileName);
}

function getScopeFilteredEntries(entries, settings) {
    if (!Array.isArray(entries) || entries.length === 0) return [];
    if (settings.scopeMode !== 'selected') return entries;

    const selected = new Set(getSelectedEmbeddingChats());
    if (selected.size === 0) return [];
    return entries.filter(entry => entry && selected.has(entry.fileName));
}

function updateEmbeddingSelectionControls(toolbar = null) {
    const root = toolbar || document.querySelector('.chat-manager-filter-toolbar');
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
    selectVisibleBtn.title = `Select ${visibleFiles.length} visible chat${visibleFiles.length !== 1 ? 's' : ''} for embedding scope`;
    clearVisibleBtn.title = `Clear ${selectedVisible} selected visible chat${selectedVisible !== 1 ? 's' : ''}`;
}

function shouldUseSemanticSearch(query) {
    if (!query || query.length < HYBRID_SEARCH_MIN_CHARS) return false;
    const settings = getEmbeddingSettings();
    if (!isEmbeddingLevelOn(settings, 'message') || !isEmbeddingLevelOn(settings, 'query')) return false;
    if (!isEmbeddingConfigured()) return false;
    return hasMessageEmbeddings();
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

function runDebouncedRecluster() {
    clearReclusterTimer();
    const index = getIndex();
    const chatCount = Object.values(index).filter(entry => Array.isArray(entry.chatEmbedding) && entry.chatEmbedding.length > 0).length;
    const reuseK = !shouldRedetectK(chatCount);
    const fixedK = reuseK ? lastClusterK : null;

    const result = recomputeEmbeddingClusters({ fixedK });
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

function getDriftSummary(entry) {
    if (!entry || !(entry.messageEmbeddings instanceof Map) || entry.messageEmbeddings.size < 2) return null;
    if (!Array.isArray(entry.messages) || entry.messages.length < 2) return null;

    const cacheKey = `${entry.fileName}:${entry.messages.length}:${entry.messageEmbeddings.size}`;
    const cached = driftSummaryCache.get(cacheKey);
    if (cached) return cached;

    const vectors = [];
    const msgIndices = [];
    for (const msg of entry.messages) {
        const vector = entry.messageEmbeddings.get(msg.index);
        if (!Array.isArray(vector) || vector.length === 0) continue;
        vectors.push(vector);
        msgIndices.push(msg.index);
    }

    if (vectors.length < 2) return null;

    const scores = topicShiftScores(vectors);
    const majorPositions = [];
    const moderatePositions = [];

    for (let i = 0; i < scores.length; i++) {
        const score = scores[i];
        const transitionMsg = msgIndices[i + 1] ?? msgIndices[i];
        if (score > 0.4) {
            majorPositions.push(transitionMsg);
        } else if (score > 0.3) {
            moderatePositions.push(transitionMsg);
        }
    }

    const all = [...majorPositions, ...moderatePositions];
    if (all.length === 0) return null;

    const summary = {
        count: all.length,
        majorCount: majorPositions.length,
        positions: all.slice(0, 5),
        firstMsgIndex: all[0],
    };
    driftSummaryCache.set(cacheKey, summary);
    return summary;
}

function queueEmbeddingRun(task) {
    const previous = embedRunPromise || Promise.resolve();
    const next = previous
        .catch(() => {})
        .then(task);

    embedRunPromise = next.finally(() => {
        if (embedRunPromise === next) {
            embedRunPromise = null;
        }
    });

    return embedRunPromise;
}

function getRepresentativeEmbeddingText(entry) {
    if (!entry) return '';

    const summary = (getSummary(entry.fileName) || '').trim();
    if (summary) {
        return summary.slice(0, 2000);
    }

    if (!entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    const tail = entry.messages.length > 10 ? entry.messages.slice(-10) : entry.messages;
    const text = tail
        .map(msg => (typeof msg?.text === 'string' ? msg.text.trim() : ''))
        .filter(Boolean)
        .join('\n');

    return text.slice(0, 2000).trim();
}

function getMessageEmbeddingCandidates(entries) {
    const candidates = [];
    for (const entry of entries) {
        if (!entry?.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) continue;

        if (!(entry.messageEmbeddings instanceof Map)) {
            entry.messageEmbeddings = new Map();
        } else {
            entry.messageEmbeddings.clear();
        }

        for (const msg of entry.messages) {
            const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
            if (!text) continue;
            candidates.push({
                entry,
                msgIndex: msg.index,
                text,
                hash: hashEmbeddingText(text),
            });
        }
    }
    return candidates;
}

function recomputeEmbeddingClusters(options = {}) {
    const index = getIndex();
    const entries = Object.values(index);
    const embeddedEntries = entries.filter(entry => Array.isArray(entry.chatEmbedding) && entry.chatEmbedding.length > 0);

    for (const entry of entries) {
        entry.clusterLabel = null;
    }

    if (embeddedEntries.length === 0) {
        lastClusterK = null;
        lastClusterChatCount = 0;
        return { clusterCount: 0, k: null, embeddedCount: 0 };
    }
    if (embeddedEntries.length === 1) {
        embeddedEntries[0].clusterLabel = 0;
        lastClusterK = 1;
        lastClusterChatCount = 1;
        return { clusterCount: 1, k: 1, embeddedCount: 1 };
    }

    const vectors = embeddedEntries.map(entry => entry.chatEmbedding);
    let k = Number.isFinite(options.fixedK) && options.fixedK > 0
        ? Math.floor(options.fixedK)
        : findOptimalK(vectors, 8);
    if (!Number.isFinite(k) || k < 1) {
        k = Math.min(5, Math.ceil(embeddedEntries.length / 3));
    }
    k = Math.max(1, Math.min(Math.floor(k), embeddedEntries.length));

    const { labels } = kMeans(vectors, k, 50);
    for (let i = 0; i < embeddedEntries.length; i++) {
        embeddedEntries[i].clusterLabel = labels[i] ?? 0;
    }

    const clusterCount = new Set(labels).size;
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

    const query = getCurrentSearchQuery();
    if (query.length >= 2) {
        performSearch(query);
    } else {
        renderThreadCards();
    }
}

async function runEmbeddingGeneration(targetFileNames = null, options = {}) {
    const settings = getEmbeddingSettings();
    if (!settings.enabled) {
        return { updated: 0, total: 0, clusters: 0, skipped: true };
    }
    const chatLevelEnabled = isEmbeddingLevelOn(settings, 'chat');
    const messageLevelEnabled = isEmbeddingLevelOn(settings, 'message');
    if (!chatLevelEnabled && !messageLevelEnabled) {
        return { updated: 0, total: 0, clusters: getCurrentClusterCount(), skipped: true };
    }

    if (!isEmbeddingConfigured()) {
        if (!options.silent) {
            throw new Error('Embeddings are not fully configured. Set provider, model, and API key if required.');
        }
        return { updated: 0, total: 0, clusters: 0, skipped: true };
    }

    if (options.ensureIndex && Object.keys(getIndex()).length === 0) {
        await buildIndex(null, null);
    }

    const index = getIndex();
    const sourceEntries = Array.isArray(targetFileNames) && targetFileNames.length > 0
        ? targetFileNames.map(fileName => index[fileName]).filter(Boolean)
        : Object.values(index);
    const scopedEntries = getScopeFilteredEntries(sourceEntries, settings);

    const chatCandidates = chatLevelEnabled
        ? scopedEntries
            .map(entry => {
                const text = getRepresentativeEmbeddingText(entry);
                return {
                    entry,
                    text,
                    hash: text ? hashEmbeddingText(text) : null,
                };
            })
            .filter(item => item.text.length > 0)
        : [];

    const messageCandidates = messageLevelEnabled
        ? getMessageEmbeddingCandidates(scopedEntries)
        : [];
    const totalWork = chatCandidates.length + messageCandidates.length;
    if (totalWork === 0) {
        let clusters = getCurrentClusterCount();
        if (!options.incremental) {
            const clusterResult = recomputeEmbeddingClusters();
            clusters = clusterResult.clusterCount;
            lastClusterResult = clusters;
        }
        if (options.rerender !== false) refreshAfterEmbeddingUpdate();
        return { updated: 0, total: 0, clusters, skipped: true };
    }

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const cacheOnly = options.cacheOnly === true;
    let completed = 0;
    let changedChatEmbeddings = 0;
    if (onProgress) onProgress(0, totalWork);

    const pendingChats = [];
    for (const item of chatCandidates) {
        const previousHash = item.entry.chatEmbeddingHash || null;
        const cached = await getCachedEmbeddingForText(item.text);
        if (cached) {
            item.entry.chatEmbedding = cached;
            item.entry.chatEmbeddingHash = item.hash;
            if (previousHash !== item.hash) {
                changedChatEmbeddings += 1;
            }
            completed += 1;
            if (onProgress) onProgress(completed, totalWork);
        } else {
            pendingChats.push(item);
        }
    }

    if (pendingChats.length > 0 && !cacheOnly) {
        const vectors = await embedTexts(
            pendingChats.map(item => item.text),
            {
                level: 'chat',
                onProgress: (done, pendingTotal) => {
                    if (!onProgress) return;
                    onProgress(completed + done, completed + pendingTotal + messageCandidates.length);
                },
            },
        );

        for (let i = 0; i < pendingChats.length; i++) {
            const item = pendingChats[i];
            const previousHash = item.entry.chatEmbeddingHash || null;
            item.entry.chatEmbedding = vectors[i];
            item.entry.chatEmbeddingHash = item.hash;
            if (previousHash !== item.hash) {
                changedChatEmbeddings += 1;
            }
        }
        completed += pendingChats.length;
        if (onProgress) onProgress(completed, totalWork);
    }

    const pendingMessages = [];
    for (const item of messageCandidates) {
        const cached = await getCachedEmbeddingForText(item.text);
        if (cached) {
            item.entry.messageEmbeddings.set(item.msgIndex, cached);
            completed += 1;
            if (onProgress) onProgress(completed, totalWork);
        } else {
            pendingMessages.push(item);
        }
    }

    if (pendingMessages.length > 0 && !cacheOnly) {
        const vectors = await embedTexts(
            pendingMessages.map(item => item.text),
            {
                level: 'message',
                onProgress: (done) => {
                    if (!onProgress) return;
                    onProgress(completed + done, totalWork);
                },
            },
        );

        for (let i = 0; i < pendingMessages.length; i++) {
            const item = pendingMessages[i];
            item.entry.messageEmbeddings.set(item.msgIndex, vectors[i]);
        }
        completed += pendingMessages.length;
        if (onProgress) onProgress(completed, totalWork);
    }

    driftSummaryCache.clear();
    queryEmbeddingCache.clear();

    let clusters = getCurrentClusterCount();
    let reclusterTriggered = false;
    if (options.incremental) {
        reclusterTriggered = scheduleDebouncedRecluster(changedChatEmbeddings);
        clusters = reclusterTriggered ? lastClusterResult : getCurrentClusterCount();
    } else {
        clearReclusterTimer();
        pendingClusterChanges = 0;
        const clusterResult = recomputeEmbeddingClusters();
        clusters = clusterResult.clusterCount;
        lastClusterResult = clusters;
    }

    if (options.rerender !== false && !reclusterTriggered) {
        refreshAfterEmbeddingUpdate();
    }

    return {
        updated: chatCandidates.length,
        total: chatCandidates.length,
        clusters,
        changedEmbeddings: changedChatEmbeddings,
        messageVectors: messageCandidates.length,
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
    const rerender = options.rerender !== false;
    clearReclusterTimer();
    pendingClusterChanges = 0;
    lastClusterK = null;
    lastClusterChatCount = 0;
    lastClusterResult = 0;
    queryEmbeddingCache.clear();
    driftSummaryCache.clear();

    const index = getIndex();
    for (const entry of Object.values(index)) {
        entry.chatEmbedding = null;
        entry.chatEmbeddingHash = null;
        entry.clusterLabel = null;
        entry.messageEmbeddings = null;
    }

    if (rerender) {
        refreshAfterEmbeddingUpdate();
    }
}

export function scheduleEmbeddingBootstrap() {
    const settings = getEmbeddingSettings();
    if (!isEmbeddingLevelOn(settings, 'chat') && !isEmbeddingLevelOn(settings, 'message')) return;
    if (settings.scopeMode === 'selected' && getSelectedEmbeddingChats().length === 0) return;

    if (embedBootstrapTimer) {
        clearTimeout(embedBootstrapTimer);
    }

    embedBootstrapTimer = setTimeout(() => {
        embedBootstrapTimer = null;
        void queueEmbeddingRun(() => runEmbeddingGeneration(null, {
            ensureIndex: true,
            rerender: true,
            silent: true,
            // Startup optimization: load compatible vectors from cache only.
            cacheOnly: true,
        })).catch((err) => {
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
    if (embedIncrementalTimer) {
        clearTimeout(embedIncrementalTimer);
    }

    embedIncrementalTimer = setTimeout(() => {
        embedIncrementalTimer = null;
        const files = Array.from(pendingIncrementalEmbedFiles);
        pendingIncrementalEmbedFiles.clear();
        if (files.length === 0) return;

        void queueEmbeddingRun(() => runEmbeddingGeneration(files, {
            ensureIndex: false,
            rerender: true,
            silent: true,
            incremental: true,
        })).catch((err) => {
            console.warn(`[${MODULE_NAME}] Incremental embedding update failed:`, err);
        });
    }, EMBED_INCREMENTAL_DELAY_MS);
}

/**
 * Toggle timeline view on/off. Called from index.js when the toggle button is clicked.
 * Expects Cytoscape libs to be loaded before this is called.
 */
export function toggleTimeline() {
    timelineActive = !timelineActive;

    // Update toggle button active state
    const btn = document.getElementById('chat-manager-timeline-toggle');
    if (btn) btn.classList.toggle('active', timelineActive);

    // Deactivate stats if active
    if (timelineActive && statsActive) {
        deactivateStats();
    }

    const searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    const content = document.getElementById('chat-manager-content');

    if (timelineActive) {
        // Hide search and toolbar, switch content to timeline
        if (searchWrapper) searchWrapper.style.display = 'none';
        const toolbar = document.querySelector('.chat-manager-filter-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        if (content) content.classList.add('timeline-active');

        // Set up callbacks so icicle-view can navigate
        setIcicleCallbacks({
            onJump: handleTimelineJumpToMessage,
            getActive: getActiveFilename,
            onThreadFocusChanged: persistThreadFocus,
        });

        // Initialize thread focus from persisted preference
        setIcicleThreadFocus(getThreadFocus());

        // Show loading state immediately so the browser can paint before heavy work
        if (content) content.innerHTML = '<div class="chat-manager-loading"><div class="chat-manager-spinner"></div> Building chart\u2026</div>';
        const status = document.getElementById('chat-manager-status');
        if (status) status.textContent = 'Loading timeline\u2026';

        // Defer mount to next frame
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
        const toolbar = document.querySelector('.chat-manager-filter-toolbar');
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
    statsActive = !statsActive;

    const btn = document.getElementById('chat-manager-stats-toggle');
    if (btn) btn.classList.toggle('active', statsActive);

    const searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    const toolbar = document.querySelector('.chat-manager-filter-toolbar');
    const content = document.getElementById('chat-manager-content');

    if (statsActive) {
        // Deactivate timeline if active
        if (timelineActive) {
            deactivateTimeline();
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

        const status = document.getElementById('chat-manager-status');
        if (status) status.textContent = 'Stats dashboard';
    } else {
        deactivateStats();
        renderThreadCards();
    }
}

/**
 * Toggle branch context injection on/off.
 */
export function toggleBranchContext() {
    branchContextActive = !branchContextActive;
    setBranchContextEnabled(branchContextActive);

    const btn = document.getElementById('chat-manager-branch-context-toggle');
    if (btn) btn.classList.toggle('active', branchContextActive);

    if (branchContextActive) {
        const activeFile = getActiveFilename();
        const result = updateBranchContextInjection(activeFile);
        updateBranchContextStatusUI(result);
    } else {
        clearBranchContextInjection();
        const indicator = document.getElementById('chat-manager-branch-context-indicator');
        if (indicator) indicator.style.display = 'none';
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
    if (btn) btn.classList.remove('active');

    const searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    if (searchWrapper) searchWrapper.style.display = '';
    const toolbar = document.querySelector('.chat-manager-filter-toolbar');
    if (toolbar) toolbar.style.display = '';

    const content = document.getElementById('chat-manager-content');
    if (content) content.innerHTML = '';
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
    const activeChatFile = getActiveFilename();

    if (filename !== activeChatFile) {
        const displayName = getDisplayName(filename) || filename;
        const switched = await safeSwitchChatFromJump(filename, displayName);
        if (!switched) return;
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
    if (!value) return fallback;
    const parsed = momentLib(value);
    return parsed.isValid() ? parsed.format('MMM D') : fallback;
}

function formatFromNowOrFallback(momentLib, value, fallback = 'unknown') {
    if (!value) return fallback;
    const parsed = momentLib(value);
    return parsed.isValid() ? parsed.fromNow() : fallback;
}

function getLastMessageFallback(entry) {
    if (!entry || !entry.isLoaded || !Array.isArray(entry.messages) || entry.messages.length === 0) {
        return '';
    }

    const lastMsg = entry.messages[entry.messages.length - 1];
    return typeof lastMsg?.text === 'string' ? lastMsg.text.trim() : '';
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

        if (isHydrationComplete()) {
            const activeFile = getActiveFilename();
            runDeferredBranchDetection(activeFile);
            patchBranchIndicators();

            if (branchContextActive) {
                const result = updateBranchContextInjection(activeFile);
                updateBranchContextStatusUI(result);
            }
        }
    }, 600);
}

function scheduleSearchRefresh() {
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
    dismissDropdown();
    deactivateStats();
    deactivateTimeline();
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
    dismissDropdown();
    deactivateStats();
    deactivateTimeline();
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
    if (btn) btn.classList.remove('active');

    const searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    if (searchWrapper) searchWrapper.style.display = '';

    const content = document.getElementById('chat-manager-content');
    if (content) content.classList.remove('timeline-active');
}

// ──────────────────────────────────────────────
//  Panel Refresh
// ──────────────────────────────────────────────

export async function refreshPanel() {
    const context = SillyTavern.getContext();
    ensureHydrationSubscription();
    ensureSearchModeBadge();
    if (getEmbeddingSettings().enabled) {
        scheduleEmbeddingBootstrap();
    }

    // Restore branch context toggle state from persisted setting
    branchContextActive = getBranchContextEnabled();
    const branchCtxBtn = document.getElementById('chat-manager-branch-context-toggle');
    if (branchCtxBtn) branchCtxBtn.classList.toggle('active', branchContextActive);

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
        await buildIndex(null, null);
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
        await buildIndex(null, null);
        return;
    }

    const index = getIndex();
    const hasCache = Object.keys(index).length > 0;

    const renderThreadListWithBranches = () => {
        renderThreadCards();
        const activeFile = getActiveFilename();
        setTimeout(() => {
            runDeferredBranchDetection(activeFile);
            patchBranchIndicators();
        }, 0);
    };

    const renderFromLatestIndex = () => {
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
        if (!panelOpen) return;
        renderFromLatestIndex();
    });

    // Invalidate search state since the index may have changed
    if (changed && !renderedFromMetadata) {
        searchState = null;
    }

    if (!renderedFromMetadata) {
        renderFromLatestIndex();
    }
}

function onIndexProgress(completed, total) {
    const status = document.getElementById('chat-manager-status');
    const query = getCurrentSearchQuery();
    if (status && query.length < 2) {
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
    const entries = getSortedEntries();

    for (const entry of entries) {
        const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(entry.fileName)}"]`);
        if (!card) continue;

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
    const entries = getSortedEntries();

    for (const entry of entries) {
        const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(entry.fileName)}"]`);
        if (!card) continue;

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
        if (entry.isLoaded) {
            const indexingSpan = Array.from(meta.querySelectorAll('span'))
                .find(s => s.textContent === 'Indexing...');
            if (indexingSpan) indexingSpan.remove();

            const aiTitleBtn = card.querySelector('.chat-manager-ai-title-btn');
            if (aiTitleBtn && aiTitleBtn.classList.contains('disabled')) {
                aiTitleBtn.classList.remove('disabled');
                aiTitleBtn.title = 'Generate AI title';
            }

            const regenBtn = card.querySelector('.chat-manager-regen-summary-btn');
            if (regenBtn && regenBtn.classList.contains('disabled')) {
                regenBtn.classList.remove('disabled');
                regenBtn.title = 'Generate/regenerate summary';
            }
        }
    }

    // Update status bar
    const status = document.getElementById('chat-manager-status');
    if (status) {
        status.textContent = withIndexingSuffix(`Showing ${entries.length} threads`);
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
        container.innerHTML = '<div class="chat-manager-no-filter-results"><p>No threads match current filters.</p><button class="chat-manager-btn chat-manager-clear-all-inline">Clear filters</button></div>';
        const clearBtn = container.querySelector('.chat-manager-clear-all-inline');
        if (clearBtn) clearBtn.addEventListener('click', () => { clearFilterState(); renderThreadCards(); });
        if (status) status.textContent = withIndexingSuffix(`Showing 0 of ${totalCount} threads`);
        return;
    }

    renderThreadCardsFromEntries(entries, container, status, totalCount);
}

/**
 * Render thread cards from a given set of entries into a container.
 * Extracted so heatmap day-click and other features can reuse it.
 */
export function renderThreadCardsFromEntries(entries, container, status, totalCount) {
    if (!container) return;

    const index = getIndex();
    if (totalCount === undefined) totalCount = Object.keys(index).length;

    const { moment, DOMPurify } = SillyTavern.libs;
    const activeChatFile = getActiveFilename();
    const activeEntry = activeChatFile ? index[activeChatFile] : null;
    const tagDefs = getTagDefinitions();
    const sortState = getSortState();
    const embeddingSettings = getEmbeddingSettings();
    const selectedScope = embeddingSettings.scopeMode === 'selected';
    const isClusterSorted = sortState.field === 'cluster';
    let previousClusterGroup = null;
    let hasRenderedClusterGroup = false;

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

        const displayName = getDisplayName(entry.fileName) || entry.fileName;
        const summaryDisplay = getSummaryDisplay(entry);
        const isActive = entry.fileName === activeChatFile;
        const isSelectedForEmbedding = isEmbeddingChatSelected(entry.fileName);
        const embeddingSelectControl = `
            <label class="chat-manager-emb-select${selectedScope ? ' scope-selected' : ''}" title="Include this chat when embedding scope is set to selected chats">
                <input type="checkbox" class="chat-manager-emb-select-cb" data-filename="${escapeAttr(entry.fileName)}" ${isSelectedForEmbedding ? 'checked' : ''}>
                <span>Emb</span>
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
        const indexingInfo = entry.isLoaded ? '' : '<span>Indexing...</span>';
        const aiTitleClasses = `chat-manager-icon-btn chat-manager-ai-title-btn fa-fw fa-solid fa-robot${entry.isLoaded ? '' : ' disabled'}`;
        const regenSummaryClasses = `chat-manager-icon-btn chat-manager-regen-summary-btn fa-fw fa-solid fa-rotate${entry.isLoaded ? '' : ' disabled'}`;
        const aiTitle = entry.isLoaded
            ? 'Generate AI title'
            : 'AI title will be available once indexing finishes';
        const summaryTitle = entry.isLoaded
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
                tagChipsHtml += `<span class="chat-manager-tag-chip" style="background:${escapeAttr(def.color)};color:${escapeAttr(def.textColor)}">${escapeHtml(def.name)}</span>`;
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
                    <i class="chat-manager-icon-btn chat-manager-tag-btn fa-fw fa-solid fa-tag" data-filename="${escapeAttr(entry.fileName)}" title="Manage tags" tabindex="0"></i>
                    <i class="chat-manager-icon-btn chat-manager-edit-name-btn fa-fw fa-solid fa-pen" data-filename="${escapeAttr(entry.fileName)}" title="Edit display name" tabindex="0"></i>
                    <i class="${aiTitleClasses}" data-filename="${escapeAttr(entry.fileName)}" title="${escapeAttr(aiTitle)}" tabindex="0"></i>
                    <i class="chat-manager-icon-btn chat-manager-rename-file-btn fa-fw fa-solid fa-file-pen" data-filename="${escapeAttr(entry.fileName)}" title="Rename original file" tabindex="0"></i>
                </div>
            </div>
            ${tagChipsHtml}
            <div class="chat-manager-card-meta">
                <span>${entry.messageCount} messages</span>
                <span>${firstDate} – ${lastDate}</span>
                <span>${lastActive}</span>
                ${indexingInfo}
                ${driftInfo}
                ${branchInfo}
            </div>
            <div class="chat-manager-card-summary" data-filename="${escapeAttr(entry.fileName)}">
                <p class="${summaryDisplay.className}">${escapeHtml(summaryDisplay.text)}</p>
                <div class="chat-manager-summary-actions">
                    <i class="chat-manager-icon-btn chat-manager-edit-summary-btn fa-fw fa-solid fa-pen" data-filename="${escapeAttr(entry.fileName)}" title="Edit summary" tabindex="0"></i>
                    <i class="${regenSummaryClasses}" data-filename="${escapeAttr(entry.fileName)}" title="${escapeAttr(summaryTitle)}" tabindex="0"></i>
                </div>
            </div>
            <div class="chat-manager-card-filename">${escapeHtml(entry.fileName)}</div>
        </div>`;
    }

    container.innerHTML = DOMPurify.sanitize(html);

    const filtered = hasActiveFilter();
    const statusText = filtered
        ? `Showing ${entries.length} of ${totalCount} threads`
        : `Showing ${entries.length} threads`;
    if (status) status.textContent = withIndexingSuffix(statusText);

    bindCardEvents(container);
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
    const searchWrapper = document.querySelector('.chat-manager-search-wrapper');
    if (!searchWrapper) return;

    let toolbar = document.querySelector('.chat-manager-filter-toolbar');
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
        dirBtn.className = 'chat-manager-btn chat-manager-sort-dir-btn';
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
        tagFilterBtn.className = 'chat-manager-btn chat-manager-filter-btn chat-manager-tag-filter-btn';
        tagFilterBtn.title = 'Filter by tags';
        tagFilterBtn.innerHTML = '<i class="fa-solid fa-tags"></i>';
        tagFilterBtn.addEventListener('click', (e) => { e.stopPropagation(); showTagFilterDropdown(tagFilterBtn); });

        const advFilterBtn = document.createElement('button');
        advFilterBtn.className = 'chat-manager-btn chat-manager-filter-btn chat-manager-adv-filter-btn';
        advFilterBtn.title = 'Advanced filters';
        advFilterBtn.innerHTML = '<i class="fa-solid fa-sliders"></i>';
        advFilterBtn.addEventListener('click', (e) => { e.stopPropagation(); showAdvancedFilterDropdown(advFilterBtn); });

        const clearBtn = document.createElement('button');
        clearBtn.className = 'chat-manager-btn chat-manager-clear-filters-btn';
        clearBtn.title = 'Clear all filters';
        clearBtn.innerHTML = '<i class="fa-solid fa-filter-circle-xmark"></i>';
        clearBtn.addEventListener('click', () => { clearFilterState(); renderThreadCards(); });

        const selectVisibleEmbBtn = document.createElement('button');
        selectVisibleEmbBtn.className = 'chat-manager-btn chat-manager-emb-scope-btn chat-manager-emb-select-visible-btn';
        selectVisibleEmbBtn.textContent = 'Select Visible';
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
        clearVisibleEmbBtn.textContent = 'Clear Visible';
        clearVisibleEmbBtn.addEventListener('click', () => {
            const visibleSet = new Set(getVisibleEntryFileNames());
            if (visibleSet.size === 0) return;
            const retained = getSelectedEmbeddingChats().filter(fileName => !visibleSet.has(fileName));
            setSelectedEmbeddingChats(retained);
            renderThreadCards();
        });

        filterDiv.appendChild(tagFilterBtn);
        filterDiv.appendChild(advFilterBtn);
        filterDiv.appendChild(clearBtn);
        filterDiv.appendChild(selectVisibleEmbBtn);
        filterDiv.appendChild(clearVisibleEmbBtn);

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
    if (advFilterBtn) advFilterBtn.classList.toggle('has-active', !!(f.dateFrom || f.dateTo || f.messageCountMin != null || f.messageCountMax != null));
    if (clearBtn) clearBtn.style.display = hasActiveFilter() ? '' : 'none';
    updateEmbeddingSelectionControls(toolbar);

    // Hide toolbar when search or timeline is active
    const query = getCurrentSearchQuery();
    toolbar.style.display = (query.length >= 2 || timelineActive) ? 'none' : '';
}

function updateSortDirIcon(btn, direction) {
    btn.innerHTML = direction === 'desc'
        ? '<i class="fa-solid fa-arrow-down-short-wide"></i>'
        : '<i class="fa-solid fa-arrow-up-short-wide"></i>';
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
            renderThreadCards();
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

    dropdown.innerHTML = `
        <label>Date from</label>
        <input type="date" class="cm-af-date-from" value="${f.dateFrom || ''}">
        <label>Date to</label>
        <input type="date" class="cm-af-date-to" value="${f.dateTo || ''}">
        <label>Min messages</label>
        <input type="number" class="cm-af-count-min" min="0" value="${f.messageCountMin ?? ''}">
        <label>Max messages</label>
        <input type="number" class="cm-af-count-max" min="0" value="${f.messageCountMax ?? ''}">
        <div class="chat-manager-adv-filter-actions">
            <button class="chat-manager-btn cm-af-clear">Clear</button>
            <button class="chat-manager-btn cm-af-apply">Apply</button>
        </div>
    `;

    dropdown.querySelector('.cm-af-apply').addEventListener('click', () => {
        const dateFrom = dropdown.querySelector('.cm-af-date-from').value || null;
        const dateTo = dropdown.querySelector('.cm-af-date-to').value || null;
        const minVal = dropdown.querySelector('.cm-af-count-min').value;
        const maxVal = dropdown.querySelector('.cm-af-count-max').value;
        setFilterState({
            dateFrom,
            dateTo,
            messageCountMin: minVal !== '' ? parseInt(minVal, 10) : null,
            messageCountMax: maxVal !== '' ? parseInt(maxVal, 10) : null,
        });
        dismissDropdown();
        renderThreadCards();
    });

    dropdown.querySelector('.cm-af-clear').addEventListener('click', () => {
        setFilterState({ dateFrom: null, dateTo: null, messageCountMin: null, messageCountMax: null });
        dismissDropdown();
        renderThreadCards();
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
            <button class="chat-manager-btn chat-manager-tag-manager-delete" title="Delete tag"><i class="fa-solid fa-trash"></i></button>
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
                <button class="chat-manager-btn chat-manager-tag-manager-delete" title="Delete tag"><i class="fa-solid fa-trash"></i></button>
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
    if (!searchState) return;
    if (status) setSearchStatus(queryText);

    if (searchState.results.length === 0) {
        container.innerHTML = '<div class="chat-manager-empty">No results found.</div>';
        return;
    }

    container.innerHTML = '';
    renderSearchPage(container, 0);
}

async function performSemanticSearch(trimmed, requestId) {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;

    const lowerQuery = trimmed.toLowerCase();
    const searchable = getSearchableMessages();
    let queryVector = queryEmbeddingCache.get(trimmed);
    if (!queryVector) {
        queryVector = await embedText(trimmed, { level: 'query' });
        queryEmbeddingCache.set(trimmed, queryVector);
        if (queryEmbeddingCache.size > 32) {
            const firstKey = queryEmbeddingCache.keys().next().value;
            queryEmbeddingCache.delete(firstKey);
        }
    }

    if (requestId !== latestSearchRequestId) return;

    const index = getIndex();
    const scored = [];
    for (const msg of searchable) {
        const entry = index[msg.filename];
        if (!entry || !(entry.messageEmbeddings instanceof Map)) continue;

        const msgVector = entry.messageEmbeddings.get(msg.index);
        if (!Array.isArray(msgVector) || msgVector.length === 0) continue;

        const textLower = msg.textLower || (msg.textLower = msg.text.toLowerCase());
        const keywordScore = textLower.includes(lowerQuery) ? 1.0 : 0.0;

        let semanticScore = 0;
        try {
            semanticScore = cosineSimilarity(queryVector, msgVector);
        } catch {
            semanticScore = 0;
        }
        const combinedScore = (0.7 * semanticScore) + (0.3 * keywordScore);
        scored.push({
            item: msg,
            matchIndex: textLower.indexOf(lowerQuery),
            combinedScore,
        });
    }

    scored.sort((a, b) => b.combinedScore - a.combinedScore);
    const limited = scored.slice(0, HYBRID_SEARCH_LIMIT);

    searchState = {
        query: trimmed,
        lowerQuery,
        searchable,
        position: searchable.length,
        results: limited,
        totalMatches: scored.length,
        exhausted: true,
        mode: 'semantic',
    };

    setSearchModeBadge('semantic');
    renderSearchState(container, status, trimmed);
}

function performKeywordSearch(trimmed) {
    const container = document.getElementById('chat-manager-content');
    const status = document.getElementById('chat-manager-status');
    if (!container) return;

    const lowerQuery = trimmed.toLowerCase();
    searchState = {
        query: trimmed,
        lowerQuery,
        searchable: getSearchableMessages(),
        position: 0,
        results: [],
        totalMatches: 0,
        exhausted: false,
        mode: 'keyword',
    };

    searchMoreResults(RESULTS_PAGE_SIZE);
    setSearchModeBadge('keyword');
    renderSearchState(container, status, trimmed);
}

export async function performSearch(query) {
    const container = document.getElementById('chat-manager-content');
    if (!container) return;

    if (!query || query.trim().length < 2) {
        setSearchModeBadge('keyword');
        renderThreadCards();
        return;
    }

    const trimmed = query.trim();
    const requestId = ++latestSearchRequestId;

    if (shouldUseSemanticSearch(trimmed)) {
        try {
            await performSemanticSearch(trimmed, requestId);
            return;
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Semantic search failed, falling back to keyword:`, err);
        }
    }

    if (requestId !== latestSearchRequestId) return;
    performKeywordSearch(trimmed);
}

function setSearchStatus(queryText) {
    const status = document.getElementById('chat-manager-status');
    if (!status || !searchState) return;

    const threadSet = new Set(searchState.results.map(r => r.item.filename));
    const countLabel = searchState.exhausted
        ? `Found ${searchState.totalMatches} match${searchState.totalMatches !== 1 ? 'es' : ''}`
        : `Found ${searchState.totalMatches}+ match${searchState.totalMatches !== 1 ? 'es' : ''}`;

    status.textContent = withIndexingSuffix(
        `${countLabel} across ${threadSet.size}${searchState.exhausted ? '' : '+'} thread${threadSet.size !== 1 ? 's' : ''} for: ${queryText}`,
    );
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
        const textLower = msg.textLower || (msg.textLower = msg.text.toLowerCase());
        const matchIndex = textLower.indexOf(lowerQuery);
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
    const prevChatJumpButtonCount = container.querySelectorAll('.chat-manager-jump-btn').length;
    const prevGraphJumpButtonCount = container.querySelectorAll('.chat-manager-graph-jump-btn').length;
    const end = Math.min(fromIndex + RESULTS_PAGE_SIZE, searchState.results.length);
    let html = '';

    for (let i = fromIndex; i < end; i++) {
        const result = searchState.results[i];
        const item = result.item;
        const displayName = getDisplayName(item.filename) || item.filename;
        const roleLabel = item.role === 'user' ? 'User' : 'Character';
        const dateStr = formatDateOrFallback(moment, item.timestamp, '');

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
    // Embedding selection scope toggles
    container.querySelectorAll('.chat-manager-emb-select-cb').forEach(cb => {
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', handleEmbeddingSelectionToggle);
    });

    // Click on card to switch thread
    container.querySelectorAll('.chat-manager-display-name').forEach(el => {
        el.addEventListener('click', handleSwitchThread);
    });

    // Edit display name
    container.querySelectorAll('.chat-manager-edit-name-btn').forEach(btn => {
        btn.addEventListener('click', handleEditDisplayName);
    });

    // Tag assignment
    container.querySelectorAll('.chat-manager-tag-btn').forEach(btn => {
        btn.addEventListener('click', handleTagButton);
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

    // Branch jump
    container.querySelectorAll('.chat-manager-branch-jump').forEach(btn => {
        btn.addEventListener('click', handleJumpToGraphMessage);
    });

    // Drift jump
    container.querySelectorAll('.chat-manager-drift-jump').forEach(btn => {
        btn.addEventListener('click', handleJumpToGraphMessage);
    });
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

    const index = getIndex();
    const entry = index[filename];
    if (!entry || !entry.isLoaded) {
        toastr.info('This thread is still indexing. Try again in a moment.');
        return;
    }

    btn.classList.add('disabled', 'fa-spin');
    btn.classList.remove('fa-robot');
    btn.classList.add('fa-gear');

    try {
        const activeChatFile = getActiveFilename();
        let title;

        if (filename === activeChatFile) {
            title = await generateTitleForActiveChat();
        } else {
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
    } catch (err) {
        console.error(`[${MODULE_NAME}] AI title generation failed:`, err);
        toastr.error('Failed to generate title.');
    } finally {
        btn.classList.remove('disabled', 'fa-spin', 'fa-gear');
        btn.classList.add('fa-robot');
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

    // Pre-check: reject if a file with the target name already exists in the index
    const index = getIndex();
    if (index[newFilename]) {
        toastr.warning(`A chat file named "${newFilename}" already exists. Choose a different name.`);
        return;
    }

    try {
        await context.renameChat(baseName, newBase);
        migrateFileKey(filename, newFilename);
        toastr.success(`Renamed to ${newFilename}`);
        await refreshPanel();
    } catch (err) {
        console.error(`[${MODULE_NAME}] Rename failed:`, err);
        // Server returns 400 when destination file already exists (race condition)
        if (err?.status === 400 || String(err).includes('400')) {
            toastr.error(`Rename failed — a file named "${newFilename}" may already exist.`);
        } else {
            toastr.error('Failed to rename chat file.');
        }
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
    if (!entry || !entry.isLoaded) {
        toastr.info('This thread is still indexing. Try again in a moment.');
        return;
    }

    btn.classList.add('disabled', 'fa-spin');

    try {
        const activeChatFile = getActiveFilename();
        let summary;

        if (filename === activeChatFile) {
            summary = await generateSummaryForActiveChat();
        } else {
            const chatData = index[filename];
            if (!chatData || !chatData.messages.length) {
                toastr.warning('No messages in this chat.');
                return;
            }
            const context = SillyTavern.getContext();
            summary = await generateSummaryForChat(chatData.messages, context.name2, chatData.branchPoint);
        }

        if (summary) {
            setSummary(filename, summary, false);
            const card = document.querySelector(`.chat-manager-card[data-filename="${CSS.escape(filename)}"]`);
            if (card) {
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

        const switched = await safeSwitchChatFromJump(filename, displayName);
        if (!switched) return;
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

async function handleJumpToGraphMessage(e) {
    e.stopPropagation();

    const filename = e.currentTarget.dataset.filename;
    const msgIndex = parseInt(e.currentTarget.dataset.msgIndex, 10);
    if (!filename || isNaN(msgIndex)) return;

    const index = getIndex();
    const entry = index[filename];

    const isLoaded = !!entry?.isLoaded;
    focusMessageInIcicle(filename, msgIndex, {
        openPopup: true,
        persistIfMissing: !isLoaded,
    });

    if (!timelineActive) {
        toggleTimeline();
    }

    if (!isLoaded) {
        prioritizeInQueue(filename);
        toastr.info('Loading thread into graph…');
    }
}

// ──────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────

/**
 * Perform a guarded chat switch for jump actions:
 * - pre-save current chat when possible
 * - then switch chat only if precheck passes
 */
async function safeSwitchChatFromJump(filename, displayName = filename) {
    const context = SillyTavern.getContext();
    const target = filename.replace(/\.jsonl$/i, '');

    try {
        if (typeof context.saveChat === 'function') {
            await context.saveChat();
            // Allow any trailing async save state to settle before switching.
            await new Promise(r => setTimeout(r, 200));
        } else {
            console.warn(`[${MODULE_NAME}] context.saveChat is unavailable; switching without precheck.`);
        }

        await context.openCharacterChat(target);
        // Wait for chat to render after switching.
        await new Promise(r => setTimeout(r, 500));
        return true;
    } catch (err) {
        console.warn(`[${MODULE_NAME}] Safe jump switch failed for "${filename}".`, err);
        toastr.warning(`Could not safely switch to "${displayName}". Please switch manually, then jump again.`);
        return false;
    }
}

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
            if (!entry.isLoaded) continue;
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
    const toolbar = document.querySelector('.chat-manager-filter-toolbar');
    if (!query || query.trim().length < 2) {
        if (toolbar) toolbar.style.display = '';
        renderThreadCards();
    } else {
        if (toolbar) toolbar.style.display = 'none';
        dismissDropdown();
        performSearch(query);
    }
}
