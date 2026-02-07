/**
 * Chat Manager — Main entry point.
 * Lifecycle hooks, event listeners, UI injection.
 */

import { clearIndex, getIndexCharacterAvatar, updateActiveChat } from './src/chat-reader.js';
import { togglePanel, closePanel, refreshPanel, renderThreadCards, onSearchInput, isPanelOpen, resetSearchState, toggleTimeline, isTimelineActive, toggleStats, isStatsActive, toggleBranchContext, isBranchContextActive } from './src/ui-controller.js';
import { getDisplayMode, setDisplayMode, getBranchContextEnabled } from './src/metadata-store.js';
import { updateBranchContextInjection, clearBranchContextInjection } from './src/branch-context.js';
import { attachMomentumScroll } from './src/momentum-scroll.js';

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

            if (isPanelOpen() && activeChatFile) {
                const updated = await updateActiveChat(activeChatFile);
                if (updated && !isTimelineActive() && !isStatsActive()) {
                    renderThreadCards();
                }
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
    } else {
        console.warn(`[${MODULE_NAME}] Missing eventSource/eventTypes; startup listeners not attached.`);
    }

    registerSlashCommands();

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
        event.stopImmediatePropagation();
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
}
