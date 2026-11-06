# Recent swipes — 2026-10-16

A labeled **Recent swipes** button in both Chat Manager headers opens a read-only dialog for the active character conversation. It starts on the latest assistant reply, shows full text alternatives newest first, marks the newest/current versions, and offers an earlier-reply selector, pagination, Show current swipe, and Jump to reply. Wide layouts compare two columns; narrow layouts use one.

The view uses the live conversation, including current unsaved edits. Message and chat events refresh it independently of archive hydration. An earlier selection is retained as replies arrive, including at the pagination boundary. Switching characters or conversations clears the previous view. Jumping rechecks conversation/message identity and uses the existing serialized navigation path. Previews render with textContent and never change the selected swipe, save messages, or call a provider.

Validation:

- `node --test tests/*.test.mjs`: 157 passed, no failures or skips.
- JavaScript syntax and `git diff --check`: passed.
- `tests/browser-swipes.html`: 23 checks each at desktop and 320px widths, covering latest-first selection, bounded cards, current/live text, nonmutation, earlier selections, incoming/deleted replies, pagination, stale navigation, HTML safety, focus restoration, layout, and empty states.
- Existing control-clarity fixture: 18 checks in panel mode and 18 in popup mode after adding the entry point.
- Native reply selection and Escape inspected through browser automation.

Browser checks use synthetic chats and a mocked jump callback. A production SillyTavern session and real host scrolling were not exercised; the existing chat-navigation unit tests passed. Optional Font Awesome preview assets are served locally, not included in the extension.

Results and desktop/mobile JPEGs are stored beside this file. Changes remain local and uncommitted, together with the earlier icon cleanup.
