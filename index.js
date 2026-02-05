/**
 * Chat Manager — Main entry point.
 * Lifecycle hooks, event listeners, UI injection.
 */

import { clearIndex } from './src/chat-reader.js';
import { togglePanel, closePanel, refreshPanel, onSearchInput, isPanelOpen } from './src/ui-controller.js';

const MODULE_NAME = 'chat_manager';

/**
 * Extension entry point — called by SillyTavern when the extension loads.
 */
(async function init() {
    const context = SillyTavern.getContext();
    const { eventSource, eventTypes } = context;

    // Ensure settings structure exists
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = { metadata: {} };
    }

    // Inject panel HTML
    await injectPanelHTML();

    // Bind panel events
    bindPanelEvents();

    // Listen for SillyTavern events
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);
    eventSource.on(eventTypes.MESSAGE_SENT, onMessageUpdate);
    eventSource.on(eventTypes.MESSAGE_RECEIVED, onMessageUpdate);

    // Hijack TopInfoBar's chat manager button once all extensions are ready
    eventSource.on(eventTypes.APP_READY, hijackTopBarButton);

    console.log(`[${MODULE_NAME}] Extension loaded.`);
})();

/**
 * Inject the panel HTML template into the DOM.
 */
async function injectPanelHTML() {
    const context = SillyTavern.getContext();
    const panelResponse = await fetch('/scripts/extensions/third-party/chat_manager/templates/panel.html', {
        method: 'GET',
        headers: context.getRequestHeaders(),
    });
    if (!panelResponse.ok) {
        console.error(`[${MODULE_NAME}] Failed to load panel template`);
        return;
    }
    const panelHTML = await panelResponse.text();

    const { DOMPurify } = SillyTavern.libs;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = DOMPurify.sanitize(panelHTML);

    document.body.appendChild(wrapper.firstElementChild);
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
 * Bind events within the panel (close button, search input).
 */
function bindPanelEvents() {
    const { lodash: _ } = SillyTavern.libs;

    // Close button
    const closeBtn = document.getElementById('chat-manager-close-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', closePanel);
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

    // Reset search input
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
