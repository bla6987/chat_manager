/**
 * Chat Manager — Main entry point.
 * Lifecycle hooks, event listeners, UI injection.
 */

import { clearIndex } from './src/chat-reader.js';
import { togglePanel, closePanel, refreshPanel, onSearchInput, isPanelOpen, resetSearchState } from './src/ui-controller.js';
import { getDisplayMode, setDisplayMode } from './src/metadata-store.js';

const MODULE_NAME = 'chat_manager';
const EXTENSION_PATH = '/scripts/extensions/third-party/chat_manager';

/**
 * Extension entry point — called by SillyTavern when the extension loads.
 */
(async function init() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Ensure settings structure exists
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { metadata: {}, displayMode: 'panel' };
    }

    // Inject UI for current display mode
    await injectUI(getDisplayMode());

    // Bind panel events
    bindPanelEvents();

    // Inject settings panel into Extensions settings
    await injectSettingsPanel();

    // Listen for SillyTavern events
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.MESSAGE_SENT, onMessageUpdate);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageUpdate);

    // Hijack TopInfoBar's chat manager button once all extensions are ready
    eventSource.on(eventTypes.APP_READY, hijackTopBarButton);

    console.log(`[${MODULE_NAME}] Extension loaded.`);
})();

/**
 * Inject the UI template for the given display mode into the DOM.
 * Removes any existing panel/overlay elements first.
 * @param {string} mode - 'panel' or 'popup'
 */
async function injectUI(mode) {
    // Remove existing UI elements
    const existingPanel = document.getElementById('chat-manager-panel');
    if (existingPanel) existingPanel.remove();
    const existingOverlay = document.getElementById('chat-manager-shadow-overlay');
    if (existingOverlay) existingOverlay.remove();

    const templateFile = mode === 'popup' ? 'popup.html' : 'panel.html';
    const context = SillyTavern.getContext();
    const response = await fetch(`${EXTENSION_PATH}/templates/${templateFile}`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to load ${templateFile} template`);
        return;
    }

    const html = await response.text();
    const { DOMPurify } = SillyTavern.libs;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = DOMPurify.sanitize(html);

    document.body.appendChild(wrapper.firstElementChild);
}

/**
 * Inject the settings panel into SillyTavern's Extensions settings area.
 */
async function injectSettingsPanel() {
    const context = SillyTavern.getContext();
    const response = await fetch(`${EXTENSION_PATH}/templates/settings.html`, {
        method: 'GET',
        headers: context.getRequestHeaders(),
    });

    if (!response.ok) {
        console.error(`[${MODULE_NAME}] Failed to load settings template`);
        return;
    }

    const html = await response.text();
    const { DOMPurify } = SillyTavern.libs;

    const container = document.createElement('div');
    container.className = 'extension_container';
    container.id = 'chat_manager_settings_container';
    container.innerHTML = DOMPurify.sanitize(html);

    const settingsArea = document.getElementById('extensions_settings2');
    if (settingsArea) {
        settingsArea.appendChild(container);
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
}

/**
 * Switch the display mode — close current UI, swap template, re-bind events.
 * @param {string} newMode - 'panel' or 'popup'
 */
async function switchDisplayMode(newMode) {
    // Swap DOM template
    await injectUI(newMode);

    // Re-bind events on the new template
    bindPanelEvents();
}

/**
 * Hijack TopInfoBar's "manage chat files" button so it opens the Chat Manager
 * panel instead of the native SillyTavern chat selection dialog.
 *
 * Falls back to creating a standalone button if TopInfoBar is not installed.
 */
function hijackTopBarButton() {
    const existingBtn = document.getElementById('extensionTopBarChatManager');

    if (existingBtn) {
        // Clone-and-replace to strip all anonymous event listeners
        const parent = existingBtn.parentNode;
        const clone = existingBtn.cloneNode(true);
        clone.title = 'Toggle Chat Manager';
        clone.addEventListener('click', (e) => {
            // Respect TopInfoBar's disabled state
            if (clone.classList.contains('not-in-chat')) return;
            e.stopPropagation();
            togglePanel();
        });
        parent.replaceChild(clone, existingBtn);
        console.log(`[${MODULE_NAME}] Hijacked TopInfoBar chat manager button.`);
        return;
    }

    // Fallback: TopInfoBar bar exists but the button doesn't — add an icon
    const topBar = document.getElementById('extensionTopBar');
    if (topBar) {
        const icon = document.createElement('i');
        icon.id = 'chat-manager-toggle';
        icon.className = 'fa-solid fa-address-book';
        icon.title = 'Toggle Chat Manager';
        icon.tabIndex = 0;
        icon.addEventListener('click', togglePanel);
        topBar.appendChild(icon);
        console.log(`[${MODULE_NAME}] Added Chat Manager icon to TopInfoBar.`);
        return;
    }

    // Final fallback: no TopInfoBar at all — floating button
    const btn = document.createElement('button');
    btn.id = 'chat-manager-toggle';
    btn.textContent = 'Chat Manager';
    btn.title = 'Toggle Chat Manager';
    btn.style.position = 'fixed';
    btn.style.top = '8px';
    btn.style.right = '8px';
    btn.style.zIndex = '999';
    btn.addEventListener('click', togglePanel);
    document.body.appendChild(btn);
    console.log(`[${MODULE_NAME}] Added floating Chat Manager button (no TopInfoBar).`);
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
}

/**
 * Handle CHAT_CHANGED event — rebuild index and re-render panel.
 */
async function onChatChanged() {
    if (isPanelOpen()) {
        await refreshPanel();
    } else {
        // Clear stale data so next open triggers a fresh build
        clearIndex();
    }

    // Reset search input and state
    resetSearchState();
    const searchInput = document.getElementById('chat-manager-search');
    if (searchInput) searchInput.value = '';
}

/**
 * Handle MESSAGE_SENT / MESSAGE_RECEIVED — update index for active chat.
 */
async function onMessageUpdate() {
    if (isPanelOpen()) {
        // Lightweight refresh — rebuild index and re-render
        await refreshPanel();
    }
}
