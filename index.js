/**
 * Chat Manager — Main entry point.
 * Lifecycle hooks, event listeners, UI injection.
 */

import { clearIndex, getIndexCharacterAvatar, updateActiveChat } from './src/chat-reader.js';
import {
    togglePanel, closePanel, refreshPanel, renderThreadCards, onSearchInput, isPanelOpen, resetSearchState,
    toggleTimeline, isTimelineActive, toggleSemanticMap, isSemanticMapActive, toggleGraphView, isGraphViewActive, toggleStats, isStatsActive, toggleBranchContext, isBranchContextActive,
    clearInMemoryEmbeddings, generateEmbeddingsForCurrentIndex, scheduleEmbeddingBootstrap, scheduleIncrementalEmbedding, performSearch,
} from './src/ui-controller.js';
import {
    getDisplayMode, setDisplayMode, getBranchContextEnabled, getAIConnectionProfile, setAIConnectionProfile,
    getEmbeddingSettings, setEmbeddingSettings,
} from './src/metadata-store.js';
import { updateBranchContextInjection, clearBranchContextInjection } from './src/branch-context.js';
import { attachMomentumScroll } from './src/momentum-scroll.js';
import { acknowledgeEmbeddingModelChange, clearEmbeddingCache, getCacheStats } from './src/embedding-service.js';
import { updateGraphViewData, isGraphViewMounted } from './src/graph-view.js';

const MODULE_NAME = 'chat_manager';
const EXTENSION_PATH = '/scripts/extensions/third-party/chat_manager';
const SETTINGS_CONTAINER_ID = 'chat_manager_settings_container';
const START_BUTTON_ID = 'chat-manager-start-btn';
const TOPBAR_CHAT_MANAGER_ID = 'extensionTopBarChatManager';
const FALLBACK_TOGGLE_ID = 'chat-manager-toggle';

const templateCache = new Map();
let settingsInjected = false;
let pendingSettingsInjection = null;
let currentInjectedMode = null;
let pendingUIInjection = null;
let slashCommandsRegistered = false;
let topBarInterceptorBound = false;
let cleanupMomentumScroll = null;

function isEmbeddingGenerationEnabled() {
    const settings = getEmbeddingSettings();
    if (!settings.enabled) return false;
    return settings.embeddingLevels?.chat === true || settings.embeddingLevels?.message === true;
}

/**
 * Handle MESSAGE_SENT / MESSAGE_RECEIVED — lightweight update for active chat only.
 * Debounced to avoid redundant updates during rapid message events (e.g., streaming).
 */
const onMessageUpdate = (() => {
    let timer = null;
    return function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(async () => {
            timer = null;

            const context = SillyTavern.getContext();
            const activeChatFile = context.chatMetadata?.chat_file_name;
            const embeddingGenerationEnabled = isEmbeddingGenerationEnabled();

            let updated = false;
            if (activeChatFile && (isPanelOpen() || embeddingGenerationEnabled)) {
                updated = await updateActiveChat(activeChatFile, {
                    // Keep vectors only when embeddings are disabled so semantic views do not
                    // unexpectedly "drop out" while the user is not auto-regenerating vectors.
                    resetEmbeddings: embeddingGenerationEnabled,
                });
            }

            if (isPanelOpen() && activeChatFile) {
                if (updated && !isTimelineActive() && !isStatsActive() && !isSemanticMapActive() && !isGraphViewActive()) {
                    renderThreadCards();
                }
            }

            if (embeddingGenerationEnabled && activeChatFile && updated) {
                scheduleIncrementalEmbedding(activeChatFile);
            } else if (embeddingGenerationEnabled && activeChatFile && !updated) {
                scheduleEmbeddingBootstrap();
            }

            // Branch context injection works even when panel is closed
            if (isBranchContextActive() && activeChatFile) {
                updateBranchContextInjection(activeChatFile);
            }
        }, 250);
    };
})();

/**
 * Extension entry point — called by SillyTavern when the extension loads.
 */
(async function init() {
    const context = SillyTavern.getContext();
    const { eventSource } = context;
    const eventTypes = context.eventTypes || context.event_types;

    // Ensure settings structure exists
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { metadata: {}, displayMode: 'panel' };
    }

    // Inject settings panel asynchronously to avoid blocking startup.
    setTimeout(() => {
        void injectSettingsPanel();
    }, 0);

    bindTopBarClickInterceptor();
    hijackTopBarButton();

    // Listen for SillyTavern events
    if (eventSource && eventTypes) {
        eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
        eventSource.on(eventTypes.MESSAGE_SENT, onMessageUpdate);
        eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageUpdate);

        // Hijack TopInfoBar's chat manager button once all extensions are ready
        if (eventTypes.APP_READY) {
            eventSource.on(eventTypes.APP_READY, onAppReady);
        }

        // Re-populate AI profile dropdown when Connection Manager profiles change
        const profileEvents = ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED'];
        for (const evtName of profileEvents) {
            if (eventTypes[evtName]) {
                eventSource.on(eventTypes[evtName], () => {
                    refreshAIProfileDropdowns();
                });
            }
        }
    } else {
        console.warn(`[${MODULE_NAME}] Missing eventSource/eventTypes; startup listeners not attached.`);
    }

    registerSlashCommands();

    // If embeddings are enabled, attempt to restore vectors/clusters from cache.
    if (isEmbeddingGenerationEnabled()) {
        setTimeout(() => {
            scheduleEmbeddingBootstrap();
        }, 1200);
    }

    // Restore branch context injection if it was enabled
    if (getBranchContextEnabled()) {
        setTimeout(() => {
            const ctx = SillyTavern.getContext();
            const activeFile = ctx.chatMetadata?.chat_file_name;
            if (activeFile) {
                updateBranchContextInjection(activeFile);
            }
        }, 2000);
    }

    console.log(`[${MODULE_NAME}] Extension loaded.`);
})();

function onAppReady() {
    registerSlashCommands();
    hijackTopBarButton();
    void injectSettingsPanel();
    if (isEmbeddingGenerationEnabled()) {
        scheduleEmbeddingBootstrap();
    }
}

function bindTopBarClickInterceptor() {
    if (topBarInterceptorBound) return;

    document.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;

        const topBarButton = event.target.closest(`#${TOPBAR_CHAT_MANAGER_ID}`);
        if (!topBarButton) return;

        // Respect TopInfoBar's disabled state
        if (topBarButton.classList.contains('not-in-chat')) return;

        event.preventDefault();
        // Avoid suppressing other capture listeners on the same element.
        event.stopPropagation();
        void handleTogglePanel(event);
    }, true);

    topBarInterceptorBound = true;
}

/**
 * Fetch and sanitize a template once, then reuse it.
 * @param {string} templateFile
 * @returns {Promise<string|null>}
 */
async function loadTemplate(templateFile) {
    if (templateCache.has(templateFile)) {
        return templateCache.get(templateFile);
    }

    const context = SillyTavern.getContext();
    const response = await fetch(`${EXTENSION_PATH}/templates/${templateFile}`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to load ${templateFile} template`);
        return null;
    }

    const html = await response.text();
    const { DOMPurify } = SillyTavern.libs;
    const sanitized = DOMPurify.sanitize(html);
    templateCache.set(templateFile, sanitized);
    return sanitized;
}

/**
 * Inject the UI template for the given display mode into the DOM.
 * Removes any existing panel/overlay elements first.
 * @param {string} mode - 'panel' or 'popup'
 * @returns {Promise<boolean>}
 */
async function injectUI(mode) {
    if (cleanupMomentumScroll) {
        cleanupMomentumScroll();
        cleanupMomentumScroll = null;
    }

    // Remove existing UI elements
    const existingPanel = document.getElementById('chat-manager-panel');
    if (existingPanel) existingPanel.remove();
    const existingOverlay = document.getElementById('chat-manager-shadow-overlay');
    if (existingOverlay) existingOverlay.remove();

    const templateFile = mode === 'popup' ? 'popup.html' : 'panel.html';
    const html = await loadTemplate(templateFile);
    if (!html) return false;

    const wrapper = document.createElement('div');
    wrapper.innerHTML = html;

    const root = wrapper.firstElementChild;
    if (!root) return false;

    document.body.appendChild(root);
    return true;
}

/**
 * Ensure the panel/popup DOM exists for the selected display mode.
 * @param {string} mode
 * @returns {Promise<boolean>}
 */
async function ensureUI(mode) {
    const hasPanel = !!document.getElementById('chat-manager-panel');
    const hasOverlay = !!document.getElementById('chat-manager-shadow-overlay');
    const hasCurrentUI = mode === 'popup' ? hasOverlay : hasPanel;

    if (currentInjectedMode === mode && hasCurrentUI) {
        return true;
    }

    if (pendingUIInjection) {
        return pendingUIInjection;
    }

    pendingUIInjection = (async () => {
        const injected = await injectUI(mode);
        if (!injected) return false;
        bindPanelEvents();
        currentInjectedMode = mode;
        return true;
    })().finally(() => {
        pendingUIInjection = null;
    });

    return pendingUIInjection;
}

async function handleTogglePanel(event) {
    if (event) event.stopPropagation();

    const mode = getDisplayMode();
    const ready = await ensureUI(mode);
    if (!ready) return;

    await togglePanel();
}

async function openChatManager(event) {
    if (event) event.stopPropagation();

    const mode = getDisplayMode();
    const ready = await ensureUI(mode);
    if (!ready) return false;

    if (isPanelOpen()) {
        await refreshPanel();
    } else {
        await togglePanel();
    }

    const searchInput = document.getElementById('chat-manager-search');
    if (searchInput) searchInput.focus();
    return true;
}

function normalizeSlashArg(unnamedArgs) {
    if (Array.isArray(unnamedArgs)) {
        return unnamedArgs.join(' ').trim().toLowerCase();
    }
    if (unnamedArgs === undefined || unnamedArgs === null) {
        return '';
    }
    return unnamedArgs.toString().trim().toLowerCase();
}

function registerSlashCommands() {
    if (slashCommandsRegistered) return;

    const context = SillyTavern.getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.warn(`[${MODULE_NAME}] Slash command API unavailable; skipping command registration.`);
        return;
    }

    const commandProps = {
        name: 'chat-manager',
        aliases: ['cm'],
        callback: async (_namedArgs, unnamedArgs) => {
            const arg = normalizeSlashArg(unnamedArgs);
            if (arg && arg !== 'start') {
                if (typeof toastr !== 'undefined') {
                    toastr.warning('Usage: /chat-manager [start]');
                } else {
                    console.warn(`[${MODULE_NAME}] Usage: /chat-manager [start]`);
                }
                return '';
            }

            await openChatManager();
            return '';
        },
        returns: 'nothing',
        helpString: `
            <div>
                Opens and focuses Chat Manager.
            </div>
            <div>
                <strong>Usage:</strong>
                <ul>
                    <li><code>/chat-manager</code></li>
                    <li><code>/cm</code></li>
                    <li><code>/chat-manager start</code></li>
                </ul>
            </div>
        `,
    };

    if (SlashCommandArgument && ARGUMENT_TYPE) {
        commandProps.unnamedArgumentList = [
            SlashCommandArgument.fromProps({
                description: 'Optional: "start" to open Chat Manager',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ];
    }

    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps(commandProps));
        slashCommandsRegistered = true;
        console.log(`[${MODULE_NAME}] Registered slash commands: /chat-manager, /cm`);
    } catch (error) {
        console.error(`[${MODULE_NAME}] Failed to register slash commands`, error);
    }
}

/**
 * Populate the AI connection profile dropdown from Connection Manager's profiles.
 * @param {HTMLSelectElement} selectEl
 */
function populateAIProfileDropdown(selectEl) {
    if (!selectEl) return;

    const context = SillyTavern.getContext();
    const cmProfiles = context.extensionSettings?.connectionManager?.profiles;
    const savedId = getAIConnectionProfile();

    // Clear all options except the first ("Current Connection")
    while (selectEl.options.length > 1) {
        selectEl.remove(1);
    }

    if (!Array.isArray(cmProfiles) || cmProfiles.length === 0) {
        selectEl.value = '';
        if (savedId) setAIConnectionProfile('');
        return;
    }

    const sorted = [...cmProfiles].sort((a, b) => a.name.localeCompare(b.name));
    for (const profile of sorted) {
        const opt = document.createElement('option');
        opt.value = profile.id;
        opt.textContent = profile.name;
        selectEl.appendChild(opt);
    }

    // Restore saved value, or reset if the saved profile was deleted
    if (savedId && sorted.some(p => p.id === savedId)) {
        selectEl.value = savedId;
    } else {
        selectEl.value = '';
        if (savedId) setAIConnectionProfile('');
    }
}

function getAIProfileSelectElements(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    return Array.from(root.querySelectorAll('.chat-manager-ai-profile-select'));
}

function refreshAIProfileDropdowns(root = document) {
    for (const selectEl of getAIProfileSelectElements(root)) {
        populateAIProfileDropdown(selectEl);
    }
}

function syncAIProfileSelection(profileId, sourceEl = null) {
    const desired = profileId || '';
    for (const selectEl of getAIProfileSelectElements()) {
        if (sourceEl && selectEl === sourceEl) continue;
        const hasOption = Array.from(selectEl.options).some(opt => opt.value === desired);
        selectEl.value = hasOption ? desired : '';
    }
}

/**
 * Bind profile dropdown UI to persisted AI profile setting.
 * @param {HTMLSelectElement|null} selectEl
 */
function bindAIProfileDropdown(selectEl) {
    if (!selectEl) return;
    populateAIProfileDropdown(selectEl);
    if (selectEl.dataset.chatManagerAiProfileBound === '1') return;

    selectEl.addEventListener('change', () => {
        const nextProfileId = selectEl.value || '';
        setAIConnectionProfile(nextProfileId);
        syncAIProfileSelection(nextProfileId, selectEl);
    });
    selectEl.dataset.chatManagerAiProfileBound = '1';
}

function formatCacheStatsLine(stats) {
    const count = Number.isFinite(stats?.count) ? stats.count : 0;
    const sizeKB = Number.isFinite(stats?.estimatedSizeKB) ? stats.estimatedSizeKB : 0;
    return `${count} vectors, ~${sizeKB.toFixed(1)} KB`;
}

/**
 * Bind embedding-related settings controls.
 * @param {HTMLElement} container
 */
function bindEmbeddingSettingsUI(container) {
    const enabledEl = container.querySelector('#chat-manager-emb-enabled');
    const levelChatEl = container.querySelector('#chat-manager-emb-level-chat');
    const levelMessageEl = container.querySelector('#chat-manager-emb-level-message');
    const levelQueryEl = container.querySelector('#chat-manager-emb-level-query');
    const providerEl = container.querySelector('#chat-manager-emb-provider');
    const apiKeyWrap = container.querySelector('#chat-manager-emb-api-key-wrap');
    const apiKeyEl = container.querySelector('#chat-manager-emb-api-key');
    const ollamaWrap = container.querySelector('#chat-manager-emb-ollama-wrap');
    const ollamaUrlEl = container.querySelector('#chat-manager-emb-ollama-url');
    const modelEl = container.querySelector('#chat-manager-emb-model');
    const modelToolsWrap = container.querySelector('#chat-manager-emb-model-tools');
    const loadModelsBtn = container.querySelector('#chat-manager-emb-load-models');
    const modelListEl = container.querySelector('#chat-manager-emb-model-list');
    const modelStatusEl = container.querySelector('#chat-manager-emb-model-status');
    const colorModeEl = container.querySelector('#chat-manager-emb-color-mode');
    const scopeModeEl = container.querySelector('#chat-manager-emb-scope-mode');
    const includeAltSwipesEl = container.querySelector('#chat-manager-emb-include-alt-swipes');
    const showAltResultsEl = container.querySelector('#chat-manager-emb-show-alt-results');
    const maxSwipesEl = container.querySelector('#chat-manager-emb-max-swipes');
    const swipeBatchEl = container.querySelector('#chat-manager-emb-swipe-batch');
    const swipeDelayEl = container.querySelector('#chat-manager-emb-swipe-delay');
    const generateBtn = container.querySelector('#chat-manager-emb-generate');
    const clearCacheBtn = container.querySelector('#chat-manager-emb-clear-cache');
    const clearVectorsBtn = container.querySelector('#chat-manager-emb-clear-vectors');
    const progressWrap = container.querySelector('#chat-manager-emb-progress');
    const progressBar = container.querySelector('#chat-manager-emb-progress-bar');
    const progressText = container.querySelector('#chat-manager-emb-progress-text');
    const cacheStatsEl = container.querySelector('#chat-manager-emb-cache-stats');

    if (!enabledEl || !levelChatEl || !levelMessageEl || !levelQueryEl || !providerEl || !apiKeyEl || !ollamaUrlEl || !modelEl || !colorModeEl || !scopeModeEl || !includeAltSwipesEl || !showAltResultsEl || !maxSwipesEl || !swipeBatchEl || !swipeDelayEl || !generateBtn || !clearCacheBtn || !clearVectorsBtn) {
        return;
    }

    const modelPlaceholderByProvider = {
        openrouter: 'e.g. openai/text-embedding-3-small',
        openai: 'e.g. text-embedding-3-small',
        ollama: 'e.g. nomic-embed-text',
    };

    const getProviderModelSnapshot = () => ({
        provider: String(providerEl.value || '').trim(),
        model: String(modelEl.value || '').trim(),
    });

    /** @type {{ provider: string, model: string }|null} */
    let lastProviderModel = null;

    const setProgress = (completed, total) => {
        if (!progressWrap || !progressBar || !progressText) return;

        const safeTotal = Math.max(0, Number(total) || 0);
        const safeCompleted = Math.max(0, Math.min(Number(completed) || 0, safeTotal || Number(completed) || 0));
        const pct = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;

        progressWrap.style.display = '';
        progressBar.style.width = `${pct}%`;
        progressText.textContent = safeTotal > 0
            ? `Embedding ${safeCompleted}/${safeTotal}`
            : 'Preparing embeddings…';
    };

    const hideProgress = () => {
        if (!progressWrap || !progressBar || !progressText) return;
        progressWrap.style.display = 'none';
        progressBar.style.width = '0%';
        progressText.textContent = '';
    };

    /**
     * @param {boolean} disabled
     */
    const setEmbeddingActionButtonsDisabled = (disabled) => {
        generateBtn.disabled = disabled;
        clearCacheBtn.disabled = disabled;
        clearVectorsBtn.disabled = disabled;
    };

    /**
     * @param {string} message
     * @param {boolean} [isError]
     */
    const setModelStatus = (message, isError = false) => {
        if (!modelStatusEl) return;
        modelStatusEl.textContent = message;
        modelStatusEl.classList.toggle('error', !!message && isError);
    };

    /**
     * @param {any} payload
     * @returns {string}
     */
    const extractApiError = (payload) => {
        if (!payload || typeof payload !== 'object') return '';
        if (typeof payload.message === 'string') return payload.message;
        if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string') {
            return payload.error.message;
        }
        return '';
    };

    /**
     * @param {any} model
     * @returns {boolean}
     */
    const isEmbeddingModel = (model) => {
        if (!model || typeof model !== 'object') return false;
        const id = typeof model.id === 'string' ? model.id : '';
        const name = typeof model.name === 'string' ? model.name : '';
        const architecture = model.architecture && typeof model.architecture === 'object' ? model.architecture : {};
        const modality = typeof architecture.modality === 'string' ? architecture.modality : '';
        const inputModalities = Array.isArray(architecture.input_modalities)
            ? architecture.input_modalities.map(String)
            : [];
        const outputModalities = Array.isArray(architecture.output_modalities)
            ? architecture.output_modalities.map(String)
            : [];
        const endpointHints = Array.isArray(model.endpoints)
            ? model.endpoints.map(endpoint => {
                if (typeof endpoint === 'string') return endpoint;
                if (!endpoint || typeof endpoint !== 'object') return '';
                return `${endpoint.name || ''} ${endpoint.endpoint || ''}`;
            })
            : [];

        const signal = [
            id,
            name,
            modality,
            ...inputModalities,
            ...outputModalities,
            ...endpointHints,
        ].join(' ').toLowerCase();

        return signal.includes('embed') || signal.includes('embedding');
    };

    /**
     * @param {{ id: string, name: string, contextLength: number|null }[]} models
     */
    const populateModelList = (models) => {
        if (!modelListEl) return;
        const currentModel = String(modelEl.value || '').trim();
        modelListEl.innerHTML = '';

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = models.length > 0 ? 'Select fetched model…' : 'No embedding models found';
        modelListEl.appendChild(placeholder);

        for (const model of models) {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.contextLength
                ? `${model.id} (${model.contextLength.toLocaleString()} ctx)`
                : model.id;
            if (model.name && model.name !== model.id) {
                option.title = model.name;
            }
            modelListEl.appendChild(option);
        }

        if (currentModel && models.some(model => model.id === currentModel)) {
            modelListEl.value = currentModel;
        } else {
            modelListEl.value = '';
        }
        modelListEl.disabled = models.length === 0;
    };

    const fetchOpenRouterModelList = async (url) => {
        const headers = {
            Accept: 'application/json',
        };
        const apiKey = String(apiKeyEl.value || '').trim();
        if (!apiKey) {
            throw new Error('OpenRouter API key is required to load embedding models.');
        }
        headers.Authorization = `Bearer ${apiKey}`;

        const response = await fetch(url, {
            method: 'GET',
            headers,
        });

        const raw = await response.text();
        let payload = null;
        if (raw) {
            try {
                payload = JSON.parse(raw);
            } catch {
                payload = null;
            }
        }

        if (!response.ok) {
            const detail = extractApiError(payload);
            throw new Error(detail || `Model list request failed (${response.status} ${response.statusText})`);
        }

        if (!Array.isArray(payload?.data)) {
            throw new Error('OpenRouter model list returned unexpected payload format.');
        }

        return payload.data;
    };

    const fetchOpenRouterEmbeddingModels = async () => {
        let modelsRaw = [];
        let fromDedicatedEndpoint = false;
        try {
            // OpenRouter's dedicated embeddings model endpoint.
            modelsRaw = await fetchOpenRouterModelList('https://openrouter.ai/api/v1/embeddings/models');
            fromDedicatedEndpoint = true;
        } catch (err) {
            // Fallback to generic models endpoint for backward compatibility.
            modelsRaw = await fetchOpenRouterModelList('https://openrouter.ai/api/v1/models');
        }

        const deduped = new Map();
        for (const model of modelsRaw) {
            const id = typeof model?.id === 'string' ? model.id.trim() : '';
            if (!id) continue;
            if (!fromDedicatedEndpoint && !isEmbeddingModel(model)) continue;

            const contextLength = Number.isInteger(model.context_length) && model.context_length > 0
                ? model.context_length
                : null;
            const name = typeof model?.name === 'string' ? model.name.trim() : '';
            deduped.set(id, { id, name, contextLength });
        }

        return Array.from(deduped.values()).sort((a, b) => a.id.localeCompare(b.id));
    };

    const updateProviderVisibility = () => {
        const provider = providerEl.value;
        const cloudProvider = provider === 'openrouter' || provider === 'openai';
        if (apiKeyWrap) apiKeyWrap.style.display = cloudProvider ? '' : 'none';
        if (ollamaWrap) ollamaWrap.style.display = provider === 'ollama' ? '' : 'none';
        const showOpenRouterTools = provider === 'openrouter';
        if (modelToolsWrap) modelToolsWrap.style.display = showOpenRouterTools ? '' : 'none';
        if (modelStatusEl) modelStatusEl.style.display = showOpenRouterTools ? '' : 'none';
        if (!showOpenRouterTools) {
            setModelStatus('');
        }
        modelEl.placeholder = modelPlaceholderByProvider[provider] || modelPlaceholderByProvider.openrouter;
    };

    const updateSwipeEmbeddingControls = () => {
        const includeAltSwipes = includeAltSwipesEl.checked === true;
        showAltResultsEl.disabled = !includeAltSwipes;
        maxSwipesEl.disabled = !includeAltSwipes;
        swipeBatchEl.disabled = !includeAltSwipes;
        swipeDelayEl.disabled = !includeAltSwipes;
    };

    const refreshSearchOrGraphForAltDisplayToggle = () => {
        if (!isPanelOpen()) return;

        if (isSemanticMapActive()) {
            void refreshPanel();
            return;
        }

        if (isGraphViewActive() && isGraphViewMounted()) {
            updateGraphViewData();
            return;
        }

        if (!isTimelineActive() && !isStatsActive() && !isSemanticMapActive() && !isGraphViewActive()) {
            const query = String(document.getElementById('chat-manager-search')?.value || '').trim();
            if (query.length >= 2) {
                void performSearch(query);
            } else {
                renderThreadCards();
            }
        }
    };

    const loadToForm = () => {
        const settings = getEmbeddingSettings();
        const levels = settings.embeddingLevels || {};
        enabledEl.checked = settings.enabled === true;
        levelChatEl.checked = levels.chat === true;
        levelMessageEl.checked = levels.message === true;
        levelQueryEl.checked = levels.query === true;
        providerEl.value = settings.provider || 'openrouter';
        apiKeyEl.value = settings.apiKey || '';
        ollamaUrlEl.value = settings.ollamaUrl || 'http://localhost:11434';
        modelEl.value = settings.model || '';
        colorModeEl.value = settings.colorMode || 'cluster';
        scopeModeEl.value = settings.scopeMode || 'all';
        includeAltSwipesEl.checked = settings.includeAlternateSwipes === true;
        showAltResultsEl.checked = settings.showAlternateSwipesInResults === true;
        maxSwipesEl.value = Number.isFinite(Number(settings.maxSwipesPerMessage)) ? String(settings.maxSwipesPerMessage) : '8';
        swipeBatchEl.value = Number.isFinite(Number(settings.swipeBackgroundBatchSize)) ? String(settings.swipeBackgroundBatchSize) : '24';
        swipeDelayEl.value = Number.isFinite(Number(settings.swipeBackgroundDelayMs)) ? String(settings.swipeBackgroundDelayMs) : '650';
        updateProviderVisibility();
        updateSwipeEmbeddingControls();
    };

    const persistForm = () => {
        setEmbeddingSettings({
            enabled: enabledEl.checked,
            embeddingLevels: {
                chat: levelChatEl.checked,
                message: levelMessageEl.checked,
                query: levelQueryEl.checked,
            },
            provider: providerEl.value,
            apiKey: apiKeyEl.value,
            ollamaUrl: ollamaUrlEl.value.trim() || 'http://localhost:11434',
            model: modelEl.value.trim(),
            colorMode: colorModeEl.value,
            scopeMode: scopeModeEl.value,
            includeAlternateSwipes: includeAltSwipesEl.checked,
            showAlternateSwipesInResults: showAltResultsEl.checked,
            maxSwipesPerMessage: Number(maxSwipesEl.value) || 8,
            swipeBackgroundBatchSize: Number(swipeBatchEl.value) || 24,
            swipeBackgroundDelayMs: Number(swipeDelayEl.value) || 650,
        });
    };

    const refreshCacheStats = async () => {
        if (!cacheStatsEl) return;
        try {
            const stats = await getCacheStats();
            cacheStatsEl.textContent = formatCacheStatsLine(stats);
        } catch {
            cacheStatsEl.textContent = 'Cache unavailable';
        }
    };

    const handleProviderModelInvalidation = async () => {
        const previous = lastProviderModel;
        const next = getProviderModelSnapshot();
        lastProviderModel = next;

        if (!previous) return;
        if (previous.provider === next.provider && previous.model === next.model) return;
        if (!previous.model || !next.model) return;

        const shouldClear = window.confirm(
            `Embedding model changed. Clear cache and regenerate?\n\nPrevious: ${previous.provider || 'unknown'} / ${previous.model || 'unknown'}\nCurrent: ${next.provider || 'unknown'} / ${next.model || 'unknown'}`,
        );

        if (shouldClear) {
            await clearEmbeddingCache();
            clearInMemoryEmbeddings();
            setEmbeddingSettings({ dimensions: null });
            await refreshCacheStats();
            if (typeof toastr !== 'undefined') {
                toastr.info('Embedding cache cleared. Click "Generate Embeddings" to rebuild vectors.');
            }
            return;
        }

        await acknowledgeEmbeddingModelChange(next.provider, next.model);
        if (typeof toastr !== 'undefined') {
            toastr.warning('Provider/model changed without clearing cache. Existing embeddings may be inconsistent.');
        }
    };

    loadToForm();
    lastProviderModel = getProviderModelSnapshot();
    void refreshCacheStats();
    hideProgress();

    enabledEl.addEventListener('change', () => {
        persistForm();
        if (enabledEl.checked) {
            scheduleEmbeddingBootstrap();
        }
    });
    levelChatEl.addEventListener('change', () => {
        persistForm();
        if (enabledEl.checked && (levelChatEl.checked || levelMessageEl.checked)) {
            scheduleEmbeddingBootstrap();
        }
    });
    levelMessageEl.addEventListener('change', () => {
        persistForm();
        if (enabledEl.checked && (levelChatEl.checked || levelMessageEl.checked)) {
            scheduleEmbeddingBootstrap();
        }
    });
    levelQueryEl.addEventListener('change', persistForm);

    providerEl.addEventListener('change', async () => {
        updateProviderVisibility();
        persistForm();
        try {
            await handleProviderModelInvalidation();
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Provider/model invalidation handling failed:`, err);
        }
    });

    apiKeyEl.addEventListener('change', persistForm);
    ollamaUrlEl.addEventListener('change', persistForm);
    modelEl.addEventListener('change', async () => {
        persistForm();
        if (modelListEl && modelListEl.options.length > 0) {
            modelListEl.value = modelEl.value.trim();
        }
        try {
            await handleProviderModelInvalidation();
        } catch (err) {
            console.warn(`[${MODULE_NAME}] Provider/model invalidation handling failed:`, err);
        }
    });
    colorModeEl.addEventListener('change', persistForm);
    scopeModeEl.addEventListener('change', () => {
        persistForm();
        if (isPanelOpen() && !isTimelineActive() && !isStatsActive() && !isSemanticMapActive() && !isGraphViewActive()) {
            renderThreadCards();
        }
    });
    includeAltSwipesEl.addEventListener('change', () => {
        updateSwipeEmbeddingControls();
        persistForm();
        refreshSearchOrGraphForAltDisplayToggle();
    });
    showAltResultsEl.addEventListener('change', () => {
        persistForm();
        refreshSearchOrGraphForAltDisplayToggle();
    });
    maxSwipesEl.addEventListener('change', persistForm);
    swipeBatchEl.addEventListener('change', persistForm);
    swipeDelayEl.addEventListener('change', persistForm);

    if (loadModelsBtn && modelListEl) {
        loadModelsBtn.addEventListener('click', async () => {
            if (providerEl.value !== 'openrouter') {
                setModelStatus('Model loading is available for OpenRouter only.', false);
                return;
            }

            loadModelsBtn.disabled = true;
            modelListEl.disabled = true;
            setModelStatus('Loading OpenRouter model list…');

            try {
                const models = await fetchOpenRouterEmbeddingModels();
                populateModelList(models);
                const loadedAt = new Date().toLocaleTimeString();
                setModelStatus(`Loaded ${models.length} embedding models at ${loadedAt}.`);
                if (typeof toastr !== 'undefined') {
                    toastr.success(`Loaded ${models.length} OpenRouter embedding models.`);
                }
            } catch (err) {
                const message = err?.message || 'Failed to load OpenRouter models.';
                setModelStatus(message, true);
                if (typeof toastr !== 'undefined') {
                    toastr.error(message);
                }
            } finally {
                loadModelsBtn.disabled = false;
                if (modelListEl.options.length > 1) {
                    modelListEl.disabled = false;
                }
            }
        });

        modelListEl.addEventListener('change', async () => {
            const selectedModel = String(modelListEl.value || '').trim();
            if (!selectedModel) return;

            modelEl.value = selectedModel;
            persistForm();
            try {
                await handleProviderModelInvalidation();
            } catch (err) {
                console.warn(`[${MODULE_NAME}] Provider/model invalidation handling failed:`, err);
            }
        });
    }

    generateBtn.addEventListener('click', async () => {
        persistForm();
        const current = getEmbeddingSettings();
        if (current.embeddingLevels?.chat !== true && current.embeddingLevels?.message !== true) {
            if (typeof toastr !== 'undefined') {
                toastr.info('Enable chat and/or message vector levels to generate embeddings.');
            }
            return;
        }

        setEmbeddingActionButtonsDisabled(true);
        setProgress(0, 0);

        try {
            const result = await generateEmbeddingsForCurrentIndex({
                onProgress: (completed, total) => setProgress(completed, total),
            });
            await refreshCacheStats();
            if (typeof toastr !== 'undefined') {
                const messagePart = Number.isFinite(result?.messageVectors) && result.messageVectors > 0
                    ? `, ${result.messageVectors} messages`
                    : '';
                const queuedSwipePart = Number.isFinite(result?.queuedSwipeVectors) && result.queuedSwipeVectors > 0
                    ? `, ${result.queuedSwipeVectors} swipe variants queued`
                    : '';
                toastr.success(`Embeddings updated for ${result.updated} chats${messagePart}${queuedSwipePart} (${result.clusters} clusters).`);
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to generate embeddings:`, err);
            if (typeof toastr !== 'undefined') {
                toastr.error(err?.message || 'Failed to generate embeddings.');
            }
        } finally {
            setEmbeddingActionButtonsDisabled(false);
            setTimeout(hideProgress, 800);
        }
    });

    clearCacheBtn.addEventListener('click', async () => {
        setEmbeddingActionButtonsDisabled(true);
        try {
            await clearEmbeddingCache();
            setEmbeddingSettings({ dimensions: null });
            await refreshCacheStats();
            if (typeof toastr !== 'undefined') {
                toastr.success('Embedding cache cleared.');
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to clear embedding cache:`, err);
            if (typeof toastr !== 'undefined') {
                toastr.error('Failed to clear embedding cache.');
            }
        } finally {
            setEmbeddingActionButtonsDisabled(false);
        }
    });

    clearVectorsBtn.addEventListener('click', async () => {
        setEmbeddingActionButtonsDisabled(true);
        try {
            await clearEmbeddingCache();
            clearInMemoryEmbeddings();
            setEmbeddingSettings({ dimensions: null });
            await refreshCacheStats();
            if (typeof toastr !== 'undefined') {
                toastr.success('All semantic vectors cleared.');
            }
        } catch (err) {
            console.error(`[${MODULE_NAME}] Failed to clear vectors:`, err);
            if (typeof toastr !== 'undefined') {
                toastr.error('Failed to clear vectors.');
            }
        } finally {
            setEmbeddingActionButtonsDisabled(false);
        }
    });
}

/**
 * Inject the settings panel into SillyTavern's Extensions settings area.
 */
async function injectSettingsPanel() {
    if (settingsInjected) return;
    if (pendingSettingsInjection) return pendingSettingsInjection;

    pendingSettingsInjection = (async () => {
        if (document.getElementById(SETTINGS_CONTAINER_ID)) {
            settingsInjected = true;
            return;
        }

        const settingsArea = document.getElementById('extensions_settings2');
        if (!settingsArea) {
            return;
        }

        const html = await loadTemplate('settings.html');
        if (!html) return;

        if (document.getElementById(SETTINGS_CONTAINER_ID)) {
            settingsInjected = true;
            return;
        }

        const container = document.createElement('div');
        container.className = 'extension_container';
        container.id = SETTINGS_CONTAINER_ID;
        container.innerHTML = html;
        settingsArea.appendChild(container);
        settingsInjected = true;

        const startButton = container.querySelector(`#${START_BUTTON_ID}`);
        if (startButton) {
            startButton.addEventListener('click', (e) => {
                void openChatManager(e);
            });
        }

        // Set initial radio state
        const currentMode = getDisplayMode();
        const radio = container.querySelector(`input[name="chat_manager_display_mode"][value="${currentMode}"]`);
        if (radio) radio.checked = true;

        // Bind change handler
        container.querySelectorAll('input[name="chat_manager_display_mode"]').forEach(input => {
            input.addEventListener('change', async (e) => {
                const newMode = e.target.value;
                // Close using the OLD mode before persisting the new one
                closePanel();
                setDisplayMode(newMode);
                await switchDisplayMode(newMode);
            });
        });

        // AI Connection Profile dropdown
        const aiProfileSelect = container.querySelector('#chat-manager-ai-profile');
        bindAIProfileDropdown(aiProfileSelect);

        bindEmbeddingSettingsUI(container);
    })().finally(() => {
        pendingSettingsInjection = null;
    });

    return pendingSettingsInjection;
}

/**
 * Switch the display mode — close current UI, swap template, re-bind events.
 * @param {string} newMode - 'panel' or 'popup'
 */
async function switchDisplayMode(newMode) {
    if (!currentInjectedMode && !document.getElementById('chat-manager-panel') && !document.getElementById('chat-manager-shadow-overlay')) {
        return;
    }
    await ensureUI(newMode);
}

/**
 * Hijack TopInfoBar's "manage chat files" button so it opens the Chat Manager
 * panel instead of the native SillyTavern chat selection dialog.
 *
 * Falls back to creating a standalone button if TopInfoBar is not installed.
 */
function hijackTopBarButton() {
    const existingBtn = document.getElementById(TOPBAR_CHAT_MANAGER_ID);
    const existingFallback = document.getElementById(FALLBACK_TOGGLE_ID);

    if (existingBtn) {
        existingBtn.title = 'Toggle Chat Manager';

        if (existingFallback) {
            existingFallback.remove();
        }

        if (!existingBtn.dataset.chatManagerHijacked) {
            existingBtn.dataset.chatManagerHijacked = '1';
            console.log(`[${MODULE_NAME}] Hijacked TopInfoBar chat manager button.`);
        }
        return;
    }

    // Fallback: TopInfoBar bar exists but the button doesn't — add an icon
    const topBar = document.getElementById('extensionTopBar');
    if (topBar) {
        if (existingFallback) return;

        const icon = document.createElement('i');
        icon.id = FALLBACK_TOGGLE_ID;
        icon.className = 'fa-solid fa-address-book';
        icon.title = 'Toggle Chat Manager';
        icon.tabIndex = 0;
        icon.addEventListener('click', (e) => {
            void handleTogglePanel(e);
        });
        topBar.appendChild(icon);
        console.log(`[${MODULE_NAME}] Added Chat Manager icon to TopInfoBar.`);
        return;
    }

    // Final fallback: no TopInfoBar at all — floating button
    if (existingFallback) return;

    const btn = document.createElement('button');
    btn.id = FALLBACK_TOGGLE_ID;
    btn.textContent = 'Chat Manager';
    btn.title = 'Toggle Chat Manager';
    btn.style.position = 'fixed';
    btn.style.top = '8px';
    btn.style.right = '8px';
    btn.style.zIndex = '999';
    btn.addEventListener('click', (e) => {
        void handleTogglePanel(e);
    });
    document.body.appendChild(btn);
    console.log(`[${MODULE_NAME}] Added floating Chat Manager button (no TopInfoBar).`);
}

/**
 * Handle timeline toggle button click.
 */
function handleTimelineToggle(e) {
    e.stopPropagation();
    toggleTimeline();
}

/**
 * Handle semantic map toggle button click.
 */
function handleSemanticMapToggle(e) {
    e.stopPropagation();
    toggleSemanticMap();
}

/**
 * Bind events within the panel/popup (close button, search input, overlay click).
 */
function bindPanelEvents() {
    const { lodash: _ } = SillyTavern.libs;

    // Panel close button (side panel mode)
    const closeBtn = document.getElementById('chat-manager-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closePanel);
    }

    // Popup close button
    const popupCloseBtn = document.getElementById('chat-manager-popup-close');
    if (popupCloseBtn) {
        popupCloseBtn.addEventListener('click', closePanel);
    }

    // Overlay click-to-close (only if click target is the overlay itself)
    const overlay = document.getElementById('chat-manager-shadow-overlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closePanel();
            }
        });
    }

    // Search input with debounce
    const searchInput = document.getElementById('chat-manager-search');
    if (searchInput) {
        const debouncedSearch = _.debounce((query) => {
            onSearchInput(query);
        }, 300);

        searchInput.addEventListener('input', (e) => {
            debouncedSearch(e.target.value);
        });
    }

    const searchAIProfileSelect = document.getElementById('chat-manager-search-ai-profile');
    bindAIProfileDropdown(searchAIProfileSelect);

    // Branch context toggle button
    const branchCtxToggleBtn = document.getElementById('chat-manager-branch-context-toggle');
    if (branchCtxToggleBtn) {
        branchCtxToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBranchContext();
        });
    }

    // Stats toggle button
    const statsToggleBtn = document.getElementById('chat-manager-stats-toggle');
    if (statsToggleBtn) {
        statsToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStats();
        });
    }

    // Timeline toggle button
    const timelineToggleBtn = document.getElementById('chat-manager-timeline-toggle');
    if (timelineToggleBtn) {
        timelineToggleBtn.addEventListener('click', handleTimelineToggle);
    }

    // Semantic map toggle button
    const semanticMapToggleBtn = document.getElementById('chat-manager-semantic-map-toggle');
    if (semanticMapToggleBtn) {
        semanticMapToggleBtn.addEventListener('click', handleSemanticMapToggle);
    }

    // Graph view toggle button
    const graphViewToggleBtn = document.getElementById('chat-manager-graph-view-toggle');
    if (graphViewToggleBtn) {
        graphViewToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleGraphView();
        });
    }

    const content = document.getElementById('chat-manager-content');
    if (cleanupMomentumScroll) {
        cleanupMomentumScroll();
        cleanupMomentumScroll = null;
    }
    if (content) {
        cleanupMomentumScroll = attachMomentumScroll(content);
    }
}

/**
 * Handle CHAT_CHANGED event.
 * If the character is the same, preserve the index for incremental refresh.
 * If the character changed, clear the index for a full rebuild.
 */
async function onChatChanged() {
    const context = SillyTavern.getContext();
    const character = context.characterId !== undefined ? context.characters[context.characterId] : null;
    const currentAvatar = character ? character.avatar : null;
    const indexAvatar = getIndexCharacterAvatar();

    const sameCharacter = currentAvatar && currentAvatar === indexAvatar;

    if (!sameCharacter) {
        // Different character (or no character) — clear everything
        clearIndex();
    }
    // If same character, keep index for incremental update

    if (isPanelOpen()) {
        await refreshPanel();
    }

    // Reset search input and state
    resetSearchState();
    const searchInput = document.getElementById('chat-manager-search');
    if (searchInput) searchInput.value = '';

    // Re-evaluate branch context injection for the new chat
    if (getBranchContextEnabled()) {
        // Clear immediately, then defer re-injection to let index stabilize
        clearBranchContextInjection();
        setTimeout(() => {
            if (!isBranchContextActive()) return;
            const ctx = SillyTavern.getContext();
            const activeFile = ctx.chatMetadata?.chat_file_name;
            if (activeFile) {
                updateBranchContextInjection(activeFile);
            }
        }, 1000);
    }

    if (isEmbeddingGenerationEnabled()) {
        const activeFile = context.chatMetadata?.chat_file_name;
        if (!sameCharacter) {
            scheduleEmbeddingBootstrap();
        } else if (activeFile) {
            scheduleIncrementalEmbedding(activeFile);
        } else {
            scheduleEmbeddingBootstrap();
        }
    }
}
