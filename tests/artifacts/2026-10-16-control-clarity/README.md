# Control clarity — 2026-10-16

The UI now pairs consistent Font Awesome symbols with visible labels for views, filters, card actions, and timeline controls. Title edits and disk-file renames are separate, AI title/summary actions have distinct labels, and card actions remain visible without hovering. Native buttons provide keyboard activation and disabled states; generation spins only the icon. View toggles expose their pressed state. The timeline legend wraps in the toolbar rather than covering controls.

Validation:

- `node --test tests/*.test.mjs`: 152 passed, no failures or skips.
- `node --check` for the three modified JavaScript modules and `git diff --check`: passed.
- `tests/browser-control-clarity.html`: panel and popup, 18 assertions each, covering labels, visibility, native controls, hydration, AI busy/completion state, delegated nested clicks, 320px layouts, pressed state, and timeline legend overlap.
- Existing browser performance fixture: 13 passed. Existing branch-navigation fixture: 11 passed.
- Manual keyboard activation and a 320px timeline popup inspected in the built-in browser.

The browser fixture uses production source/templates, synthetic chats, and mocked AI. Visual QA uses the host SillyTavern Font Awesome 6.5.2 assets, optionally served at `/fontawesome/css/` and `/fontawesome/webfonts/`; those assets are not vendored into the extension. No production SillyTavern session or provider account was changed.

See `browser-checks.json`, `automated-tests.txt`, and the JPEG previews beside this file.
