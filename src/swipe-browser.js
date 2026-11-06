/** Read-only swipe comparison, sourced directly from the live conversation. */
import { resolveActiveChatFilename } from './active-chat.js';

const REPLY_PAGE_SIZE = 30;
const SWIPE_PAGE_SIZE = 8;
let browser = null;

/** Preserve swipe numbers and the live (possibly edited or streaming) reply. */
export function getReplySwipes(message) {
    const stored = Array.isArray(message?.swipes) ? message.swipes : [];
    const rawActive = Number(message?.swipe_id);
    const activeIndex = Number.isInteger(rawActive) && rawActive >= 0 && rawActive < stored.length ? rawActive : 0;
    const count = Math.max(stored.length, typeof message?.mes === 'string' ? 1 : 0);
    const result = [];
    for (let index = count - 1; index >= 0; index--) {
        const text = index === activeIndex && typeof message?.mes === 'string'
            ? message.mes : stored[index];
        if (typeof text !== 'string' || !text.trim()) continue;
        result.push({ index, number: index + 1, text, current: index === activeIndex });
    }
    return result;
}

/** Scan only as far back as needed; retain message identity across insertions. */
export function getRecentReplies(chat, limit = REPLY_PAGE_SIZE) {
    const result = [];
    if (!Array.isArray(chat)) return result;
    for (let index = chat.length - 1; index >= 0 && result.length < limit; index--) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system) continue;
        if (typeof message.mes !== 'string' && !Array.isArray(message.swipes)) continue;
        result.push({ index, message });
    }
    return result;
}

function chatIdentity(context) {
    if (context.groupId) return null;
    const avatar = context.characters?.[context.characterId]?.avatar;
    const fileName = resolveActiveChatFilename(context);
    return avatar && fileName ? JSON.stringify([String(context.characterId), avatar, fileName]) : null;
}

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function button(label, iconName, handler) {
    const node = element('button', 'chat-manager-btn chat-manager-labeled-btn');
    node.type = 'button';
    const icon = element('i', `fa-solid ${iconName}`);
    icon.setAttribute('aria-hidden', 'true');
    node.append(icon, element('span', '', label));
    node.addEventListener('click', handler);
    return node;
}

export function closeSwipeBrowser() {
    if (!browser) return;
    const previous = browser;
    browser = null;
    previous.dialog.close();
    previous.dialog.remove();
    if (previous.returnFocus?.isConnected) previous.returnFocus.focus();
}

function revealCurrentSwipe() {
    if (!browser?.reply) return;
    const swipes = getReplySwipes(browser.reply.message);
    const position = swipes.findIndex(swipe => swipe.current);
    if (position < 0) return;
    browser.extraCurrent = true;
    renderSwipes();
    const card = browser.cards.querySelector(`[data-swipe-index="${swipes[position].index}"]`);
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderSwipes() {
    const state = browser;
    if (!state) return;
    const scrollTop = state.body.scrollTop;
    const focusedSwipe = state.cards.contains(document.activeElement)
        ? document.activeElement.dataset.swipeIndex : undefined;
    const swipes = getReplySwipes(state.reply?.message);
    state.cards.replaceChildren();
    state.count.textContent = state.reply
        ? `${swipes.length} swipe${swipes.length === 1 ? '' : 's'} · Newest first`
        : '';
    state.current.disabled = !swipes.some(swipe => swipe.current);
    state.jump.disabled = !state.reply || typeof state.onJump !== 'function';
    if (!swipes.length) {
        state.cards.append(element('p', 'chat-manager-empty', state.reply
            ? 'This reply has no text yet. Swipes will appear here as they arrive.'
            : 'No replies yet. Send a message in the conversation to get started.'));
    }
    const shown = swipes.slice(0, state.swipeLimit);
    const current = state.extraCurrent && swipes.find(swipe => swipe.current);
    if (current && !shown.includes(current)) shown.push(current);
    for (const [position, swipe] of shown.entries()) {
        const card = element('article', 'chat-manager-swipe-card' + (swipe.current ? ' is-current' : ''));
        card.dataset.swipeIndex = String(swipe.index);
        card.tabIndex = -1;
        card.setAttribute('aria-label', `Swipe ${swipe.number}${swipe.current ? ', current' : ''}`);
        const heading = element('div', 'chat-manager-swipe-card-heading');
        heading.append(element('h4', '', `Swipe ${swipe.number}`));
        if (position === 0) heading.append(element('span', 'chat-manager-swipe-badge', 'Newest'));
        if (swipe.current) heading.append(element('span', 'chat-manager-swipe-badge is-current', 'Current'));
        card.append(heading, element('div', 'chat-manager-swipe-text', swipe.text));
        state.cards.append(card);
    }
    const remaining = swipes.length - shown.length;
    state.more.hidden = remaining === 0;
    state.more.textContent = `Show ${Math.min(SWIPE_PAGE_SIZE, remaining)} more swipes`;
    state.body.scrollTop = scrollTop;
    if (focusedSwipe !== undefined) {
        state.cards.querySelector(`[data-swipe-index="${focusedSwipe}"]`)?.focus({ preventScroll: true });
    }
}

/** Refresh without resetting a reader's chosen reply or scroll position. */
export function refreshSwipeBrowser() {
    const state = browser;
    if (!state) return;
    const context = SillyTavern.getContext();
    const identity = chatIdentity(context);
    const changedChat = identity !== state.identity;
    const scrollTop = state.body.scrollTop;
    if (changedChat) {
        state.identity = identity;
        state.followLatest = true;
        state.replyLimit = REPLY_PAGE_SIZE;
        state.swipeLimit = SWIPE_PAGE_SIZE;
    }
    state.fileName = resolveActiveChatFilename(context);
    const replies = identity ? getRecentReplies(context.chat, state.replyLimit + 1) : [];
    state.earlier.hidden = replies.length <= state.replyLimit;
    state.replies = replies.slice(0, state.replyLimit);
    // A new reply can push the oldest loaded option past the page boundary.
    // Retain a reply the reader deliberately selected until it is deleted.
    if (!changedChat && !state.followLatest && state.reply
        && !state.replies.some(reply => reply.message === state.reply.message)) {
        const index = context.chat?.indexOf(state.reply.message) ?? -1;
        if (index >= 0) state.replies.push({ index, message: state.reply.message });
    }
    const selected = !changedChat && !state.followLatest
        ? state.replies.find(reply => reply.message === state.reply?.message) : null;
    const reply = selected || state.replies[0] || null;
    const changedReply = reply?.message !== state.reply?.message;
    if (changedReply) {
        state.swipeLimit = SWIPE_PAGE_SIZE;
        state.extraCurrent = false;
    }
    if (!selected) state.followLatest = true;
    state.reply = reply;
    const title = context.characters?.[context.characterId]?.name || context.name2 || 'Conversation';
    state.subtitle.textContent = identity ? `${title} · Preview alternatives without changing the current swipe.` : 'Open a character conversation to browse its swipes.';
    state.select.replaceChildren();
    for (const [position, entry] of state.replies.entries()) {
        const snippet = String(entry.message.mes || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        const option = element('option', '', `${position === 0 ? 'Latest reply' : `Message #${entry.index}`} · ${snippet || '(empty reply)'}`);
        option.value = String(entry.index);
        option.selected = entry.message === state.reply?.message;
        state.select.append(option);
    }
    state.select.disabled = !state.reply;
    state.latest.disabled = !state.reply || state.followLatest;
    renderSwipes();
    state.body.scrollTop = changedChat || changedReply ? 0 : scrollTop;
}

export function openSwipeBrowser({ onJump } = {}) {
    if (browser) {
        refreshSwipeBrowser();
        browser.select.focus();
        return;
    }
    const dialog = element('dialog', 'chat-manager-swipe-dialog');
    dialog.setAttribute('aria-labelledby', 'chat-manager-swipe-title');
    dialog.setAttribute('aria-describedby', 'chat-manager-swipe-subtitle');
    const heading = element('div', 'chat-manager-swipe-heading');
    const title = element('h3', '', 'Recent swipes');
    title.id = 'chat-manager-swipe-title';
    const close = button('Close', 'fa-xmark', closeSwipeBrowser);
    heading.append(title, close);
    const subtitle = element('p', 'chat-manager-swipe-subtitle');
    subtitle.id = 'chat-manager-swipe-subtitle';
    const controls = element('div', 'chat-manager-swipe-controls');
    const label = element('label', 'chat-manager-swipe-reply-label', 'Reply');
    const select = element('select', 'chat-manager-swipe-reply-select');
    select.id = 'chat-manager-swipe-reply';
    label.htmlFor = select.id;
    const latest = button('Latest reply', 'fa-clock-rotate-left', () => {
        browser.followLatest = true;
        refreshSwipeBrowser();
    });
    const earlier = button('Load earlier replies', 'fa-chevron-up', () => {
        browser.replyLimit += REPLY_PAGE_SIZE;
        refreshSwipeBrowser();
    });
    const current = button('Show current swipe', 'fa-eye', revealCurrentSwipe);
    const jump = button('Jump to reply', 'fa-arrow-up-right-from-square', async () => {
        const state = browser;
        if (!state?.reply) return;
        const context = SillyTavern.getContext();
        if (chatIdentity(context) !== state.identity || context.chat?.[state.reply.index] !== state.reply.message) {
            refreshSwipeBrowser();
            return;
        }
        await state.onJump?.(state.fileName, state.reply.index);
    });
    controls.append(label, select, latest, earlier);
    const actions = element('div', 'chat-manager-swipe-actions');
    const count = element('span', 'chat-manager-swipe-count');
    count.setAttribute('role', 'status');
    actions.append(count, current, jump);
    const body = element('div', 'chat-manager-swipe-body');
    const cards = element('div', 'chat-manager-swipe-cards');
    const more = button('Show more swipes', 'fa-chevron-down', () => {
        browser.swipeLimit += SWIPE_PAGE_SIZE;
        renderSwipes();
    });
    more.classList.add('chat-manager-swipe-more');
    body.append(cards, more);
    dialog.append(heading, subtitle, controls, actions, body);
    browser = { dialog, subtitle, select, latest, earlier, current, jump, count, body, cards, more,
        returnFocus: document.activeElement, onJump, identity: null, reply: null,
        followLatest: true, replyLimit: REPLY_PAGE_SIZE, swipeLimit: SWIPE_PAGE_SIZE };
    select.addEventListener('change', () => {
        const reply = browser.replies.find(entry => entry.index === Number(select.value));
        if (!reply) return;
        browser.reply = reply;
        browser.followLatest = reply === browser.replies[0];
        browser.swipeLimit = SWIPE_PAGE_SIZE;
        browser.extraCurrent = false;
        browser.latest.disabled = browser.followLatest;
        renderSwipes();
        browser.body.scrollTop = 0;
    });
    dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        closeSwipeBrowser();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); closeSwipeBrowser(); });
    dialog.addEventListener('close', () => { if (browser?.dialog === dialog) closeSwipeBrowser(); });
    dialog.addEventListener('click', event => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) closeSwipeBrowser();
    });
    document.body.append(dialog);
    refreshSwipeBrowser();
    dialog.showModal();
    select.focus();
}
