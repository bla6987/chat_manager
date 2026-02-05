# Implementation Prompt: SillyTavern Chat Manager Extension

You are building a third-party extension for **SillyTavern Staging** called **Chat Manager**. This is a slide-out side panel extension that provides advanced chat/thread management for the currently selected character. It improves on the existing TopInfoBar by offering faster search with highlighted results, AI-powered titles and summaries, display-name aliasing that doesn't break file references, and branch-point detection.

Read this entire specification before writing any code. Ask clarifying questions if anything is ambiguous.

---

## 1. Project Structure

```
extensions/third-party/chat-manager/
├── manifest.json
├── index.js               # Main entry: lifecycle hooks, event listeners, UI injection
├── style.css              # All panel styling
├── templates/
│   ├── panel.html         # Main panel shell (search bar, container divs)
│   ├── thread-card.html   # Reusable per-thread card template
│   └── search-result.html # Search result item template
├── src/
│   ├── chat-reader.js     # JSONL parsing, branch detection, search index building
│   ├── metadata-store.js  # Read/write display names, summaries, cached titles
│   ├── ai-features.js     # LLM wrappers for title & summary generation
│   └── ui-controller.js   # Panel rendering, state management, event binding
└── README.md
```

---

## 2. manifest.json

```json
{
  "display_name": "Chat Manager",
  "loading_order": 10,
  "requires": [],
  "optional": [],
  "js": "index.js",
  "css": "style.css",
  "author": "User",
  "version": "1.0.0",
  "homePage": "",
  "auto_update": false
}
```

---

## 3. CRITICAL: SillyTavern API Access Pattern

**IMPORTANT**: All SillyTavern APIs must be accessed through the global `SillyTavern.getContext()` object, NOT through ES module imports from SillyTavern's internal files. Direct imports from files like `script.js` or `extensions.js` are unreliable and can break when SillyTavern updates its internal module structure. The official documentation explicitly warns against direct imports.

```javascript
// ✅ CORRECT — Use the global context object
const context = SillyTavern.getContext();
const {
    chat,                  // Current chat messages array (MUTABLE)
    characters,            // Full character list
    characterId,           // Index of current character (undefined in group chats!)
    name2,                 // Character display name
    onlineStatus,          // API connection status (e.g., 'no_connection')
    chatMetadata,          // Metadata bound to current chat (do NOT cache reference)
    eventSource,           // Event emitter for subscribing to app events
    eventTypes,            // Enum of event type strings (preferred)
    event_types,           // DEPRECATED alias for eventTypes (still works)
    extensionSettings,     // Persistent extension settings object
    saveSettingsDebounced, // Save extension settings to server (debounced)
    saveMetadataDebounced, // Save chat metadata to server (debounced)
    getRequestHeaders,     // Returns headers with CSRF token — REQUIRED for ALL fetch() calls
    openCharacterChat,     // Switch to a different chat file
    renameChat,            // Rename a chat file on disk
    generateQuietPrompt,   // Send prompt to LLM within current chat context (invisible)
    generateRaw,           // Generate text without any chat context
    Popup,                 // Built-in modal dialog class
    POPUP_TYPE,            // Popup type enum
    POPUP_RESULT,          // Popup result enum
} = context;

// ❌ WRONG — Do NOT use direct imports (they can break on updates)
// import { getContext, extension_settings } from '../../../extensions.js';
// import { generateQuietPrompt } from '../../../../script.js';
```

### Shared Libraries

SillyTavern bundles several npm libraries accessible without installing them:

```javascript
const { lodash: _, moment, DOMPurify, Handlebars } = SillyTavern.libs;
```

- **moment** — Date/time formatting (e.g., relative time like "2 days ago").
- **lodash** — Utility functions including `_.debounce()`.
- **DOMPurify** — Sanitize HTML before inserting into the DOM.

---

## 4. Core Requirements

### 4.1 Panel Behavior

- The panel is a **slide-out side panel** triggered by a button injected near or inside the TopInfoBar area.
- The panel slides in from the **right side**, approximately **350–400px wide**.
- The main chat remains visible behind it so the user retains context.
- The panel has two view modes controlled by the search input at the top:
  - **Summary Card View** (default): shown when the search input is empty.
  - **Search Results View**: shown when the search input contains any text.
- A small status label below the search bar indicates the current mode: `"Showing summaries"` or `"Showing N results across M threads for: <query>"`.

### 4.2 Thread Listing (Summary Card View)

For the currently selected character, list all chat threads as cards. Threads are **sorted by last message timestamp, most recent first**. The currently active thread should have a distinct visual indicator (e.g., highlighted border or an "Active" badge).

Each thread card displays:

**Header row:**
- The **display name** (editable inline via a pencil icon). This is the alias stored in the extension's own settings, NOT the filename.
- An **AI Title button** (🤖) that generates a new display name via the LLM.
- A **Rename Original File button** (📁) that renames the actual JSONL file on disk (with confirmation dialog — see section 4.6).

**Meta info row:**
- **Message count** (total lines in JSONL minus any metadata lines)
- **Date range**: first message timestamp → last message timestamp (e.g., `Jul 15 – Jul 22`)
- **Last active**: relative time since last message using `moment` from `SillyTavern.libs` (e.g., `"2 days ago"`, `"3 hours ago"`)
- **Branch indicator** (only if applicable): `"Branched at msg #42"` — the message index where this chat diverged from its parent.

**Summary block:**
- 2–4 sentence AI-generated summary with emphasis on recent events.
- An **Edit button** (✏️) that makes the summary inline-editable and saves on blur or Enter.
- A **Regenerate button** (🔄) that calls the LLM to produce a new summary.

**Original filename** displayed in small muted text so the user always knows which file this maps to.

### 4.3 Search

**Index building:**
When the panel opens or the chat changes, build an in-memory search index:

```javascript
// Pseudocode for index structure
{
  "2024-7-15_12h34m56s.jsonl": {
    lastModified: 1721052896000,
    messageCount: 142,
    messages: [
      { index: 0, role: "user", text: "full message text", timestamp: "2024-07-15T12:34:56Z" },
      { index: 1, role: "assistant", text: "full message text", timestamp: "2024-07-15T12:35:10Z" },
    ]
  },
}
```

- Fetch all chat filenames for the character using ST's API (see section 5 for endpoints).
- For each chat, fetch the JSONL content.
- Parse each message object. Extract the `mes` field (message text), `is_user` field (boolean for role), and `send_date` field for timestamp.
- Cache this index. Only rebuild when the character changes or a chat is modified.

**Search implementation (indexOf with streaming):**

Search uses plain case-insensitive `indexOf` for fast substring matching with a streaming approach:

```javascript
// At index time, pre-compute a lowercased field for each message
searchableMessages.push({
    filename,
    index: msg.index,
    role: msg.role,
    text: msg.text,
    textLower: msg.text.toLowerCase(),   // pre-lowercased for fast search
    timestamp: msg.timestamp,
});

// Search: stream results with early termination
const queryLower = query.toLowerCase();
const BATCH = 50;
let found = 0;

for (let i = searchState.startFrom; i < messages.length; i++) {
    if (messages[i].textLower.indexOf(queryLower) !== -1) {
        results.push(messages[i]);
        found++;
        if (found >= BATCH) {
            searchState.startFrom = i + 1;   // save position for "Load more"
            break;
        }
    }
}
```

- Each message stores a pre-lowercased `textLower` field so `toLowerCase()` runs once at index time, not per search.
- The first 50 matches are rendered immediately; the search pauses and saves its position.
- "Load more" resumes iteration from the saved position, returning the next batch.

**Search behavior:**
- **Scope**: current character's threads only.
- **Debounce**: 300ms delay using `SillyTavern.libs.lodash.debounce()`.
- **Result display**: show up to 50 results initially with a "Load more" button.
- **Result count**: display `"Found 247 matches across 12 threads"`.
- **Highlighting**: wrap matched substring in `<span class="chat-manager-highlight">`. Show ~50 characters of context on either side. **Sanitize all inserted HTML** with `SillyTavern.libs.DOMPurify`.

Each search result card shows:
- Thread display name (or original filename if no alias)
- Message number and role (e.g., `"Message #57 (Character, Jul 15)"`)
- Highlighted excerpt with surrounding context
- A **"Jump to message"** button

**Jump to message behavior:**
If the target is in a different thread, show a confirmation: `"Switch to thread 'A Date at the Café'?"`. If confirmed (or same thread), switch via `context.openCharacterChat(filename)` and scroll to `document.querySelector('#chat .mes[mesid="<index>"]')`. Apply a flash-highlight animation (1.5s CSS).

### 4.4 Display Name Aliasing (Non-Destructive Rename)

Store display names in `extensionSettings`, not by renaming files:

```javascript
const MODULE_NAME = 'chat_manager';
const context = SillyTavern.getContext();
const { extensionSettings, saveSettingsDebounced } = context;

// Initialize
if (!extensionSettings[MODULE_NAME]) {
    extensionSettings[MODULE_NAME] = { metadata: {} };
}

// Structure:
// extensionSettings.chat_manager.metadata = {
//   "character_avatar.png": {
//     "2024-7-15_12h34m56s.jsonl": {
//       "displayName": "A Date at the Café",
//       "summary": "They met at the riverside café...",
//       "summaryEditedByUser": false,
//       "titleEditedByUser": false
//     }
//   }
// }

// After modifying:
saveSettingsDebounced();
```

When a thread has no display name set, fall back to the original filename.

### 4.5 AI Features (Title & Summary Generation)

**Prerequisites check:**
```javascript
const context = SillyTavern.getContext();
if (!context.onlineStatus || context.onlineStatus === 'no_connection') {
    toastr.warning('Connect to an LLM API in SillyTavern\'s API settings to use AI-powered features.');
    return;
}
```

**Title generation (active chat — within chat context):**

`generateQuietPrompt` sends a prompt to the LLM in the context of the CURRENT chat (character card, system prompt, etc.) without rendering output in the UI.

```javascript
const context = SillyTavern.getContext();

// CRITICAL: generateQuietPrompt takes an OBJECT, not positional arguments
const result = await context.generateQuietPrompt({
    quietPrompt: 'Based on the recent messages, generate a short title (3-10 words) capturing the most recent key event or theme. Output ONLY the title text. No quotes, no explanation.',
});
// result is a string
```

**Title/summary generation (non-active chat — without chat context):**

Use `generateRaw` when you need to generate for a chat that isn't currently open:

```javascript
const context = SillyTavern.getContext();

const messageContext = messages.slice(-15).map(m =>
    `${m.role === 'user' ? 'User' : characterName}: ${m.text}`
).join('\n');

// CRITICAL: generateRaw also takes an OBJECT
const result = await context.generateRaw({
    prompt: `Given these recent roleplay messages:\n\n${messageContext}\n\nGenerate a short title (3-10 words) capturing the most recent key event. Output ONLY the title.`,
    systemPrompt: 'You are a concise title generator. Output only the requested title.',
});
```

**Summary generation prompt:**
```javascript
// For active chat:
const summary = await context.generateQuietPrompt({
    quietPrompt: 'Summarize this roleplay conversation with emphasis on recent events. 2-4 sentences. Focus on what happened, key actions, and current situation. Output ONLY the summary.',
});

// For non-active chats: use generateRaw with messages formatted into prompt.
```

**Loading states:** Show spinner, disable button to prevent duplicate calls.

### 4.6 Rename Original File (Destructive Action)

1. User clicks 📁 button.
2. Show confirmation dialog (use ST's `Popup` class or a custom modal):
   - Warning: `"This will rename the actual chat file on disk. Checkpoints or bookmarks referencing the old filename may break."`
   - Show current filename + editable input for new name.
   - Cancel (neutral) and Rename (danger-styled) buttons.
3. On confirm:

```javascript
const context = SillyTavern.getContext();
await context.renameChat(oldFilename, newFilename);
```

4. Update `extensionSettings` key mapping.
5. Show success/error toast.

### 4.7 Branch Detection

SillyTavern's "Create Branch" and "Create Checkpoint" clone the chat up to a specific message as a new JSONL file. **There is no metadata field recording the branch source.** Branches are separate files with overlapping message content.

**Detection approach:**
1. Load the first N messages (10-20) of each chat during index build.
2. Compare opening messages across chats for the same character.
3. If two chats share the same first N messages but diverge at message M, that's a branch point.
4. The chat with fewer messages or a later timestamp is likely the branch.
5. Display `"Branched at msg #M"`. If undeterminable, don't show indicator.

**Performance note**: O(n²) comparison — for 50+ chats, limit to chats with nearby timestamps or only compare first few messages. This is best-effort.

**Heuristic shortcut**: Checkpoints often have user-chosen names (not the default timestamp pattern `YYYY-M-DD_HHhMMmSSs`). Non-timestamp filenames may indicate checkpoints.

### 4.8 Non-Destructive Guarantee

**This extension must NEVER modify the contents of any chat JSONL file.** Only the "Rename Original File" action touches ST's filesystem (renaming only, no content changes).

All extension data lives in `extensionSettings.chat_manager`.

---

## 5. SillyTavern Server API Endpoints

**All `fetch()` calls MUST include headers from `context.getRequestHeaders()`** which provides CSRF tokens.

### Listing Chats for a Character
```javascript
const context = SillyTavern.getContext();
const character = context.characters[context.characterId];

const response = await fetch('/api/characters/chats', {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({ avatar_url: character.avatar })
});
const chatList = await response.json();
```

### Loading a Specific Chat's Content
```javascript
const response = await fetch('/api/chats/get', {
    method: 'POST',
    headers: context.getRequestHeaders(),
    body: JSON.stringify({
        ch_name: character.name,
        file_name: chatFilename,
        avatar_url: character.avatar
    })
});
const chatData = await response.json(); // Array of message objects
```

### Switching to a Chat
```javascript
await context.openCharacterChat(chatFilename);
```

### Renaming a Chat File
```javascript
await context.renameChat(oldFilename, newFilename);
```

### Toast Notifications
```javascript
// Globally available — no import needed
toastr.info('Message');
toastr.success('Success');
toastr.warning('Warning');
toastr.error('Error');
```

---

## 6. Event Handling

Use `eventTypes` (preferred) not the deprecated `event_types`:

```javascript
const { eventSource, eventTypes } = SillyTavern.getContext();

// Fires on ANY chat switch: character change, manual switch, branch nav, etc.
eventSource.on(eventTypes.CHAT_CHANGED, () => {
    rebuildIndex();
    rerenderPanel();
});

eventSource.on(eventTypes.MESSAGE_SENT, () => updateIndexForActiveChat());
eventSource.on(eventTypes.MESSAGE_RECEIVED, () => updateIndexForActiveChat());
eventSource.on(eventTypes.ONLINE_STATUS_CHANGED, () => updateAIButtonStates());
```

**Key notes:**
- **No `CHARACTER_SELECTED` event exists.** Character switches trigger `CHAT_CHANGED`.
- **No dedicated `CHAT_DELETED` event.** ST fires `CHAT_CHANGED` when switching after deletion.
- `CHAT_CHANGED` is the primary event for almost all state changes.

---

## 7. UI/UX Specifications

### CSS Theme Integration
Use ST's CSS custom properties:
- `var(--SmartThemeBlurTintColor)` — panel backgrounds
- `var(--SmartThemeBodyColor)` — text color
- `var(--mainFontSize)` — base font size

### Search Highlight
```css
.chat-manager-highlight {
    background-color: rgba(255, 200, 50, 0.4);
    border-radius: 2px;
    padding: 0 2px;
}
```

### Flash Highlight (Jump to Message)
```css
.chat-manager-flash {
    animation: chat-manager-flash-anim 1.5s ease-out;
}
@keyframes chat-manager-flash-anim {
    0% { background-color: rgba(255, 200, 50, 0.5); }
    100% { background-color: transparent; }
}
```

### HTML Sanitization
Always sanitize before DOM insertion:
```javascript
const { DOMPurify } = SillyTavern.libs;
element.innerHTML = DOMPurify.sanitize(htmlContent);
```

---

## 8. Performance Considerations

| Scenario | Strategy |
|---|---|
| Index build <50 chats | Synchronous, ~1-2s |
| Index build 50-200 chats | Progress indicator, async batches of 25 |
| Index build 200+ chats | Progressive rendering — show cards as indexed |
| Search across cached index | <50ms |
| Search input | 300ms debounce via `_.debounce()` |
| Search results DOM | Max 50 results, "Load more" for pagination |
| AI title generation | Spinner on button, 2-5s typical |
| AI summary generation | Spinner on summary area, 5-15s typical |

---

## 9. Edge Cases

1. **No chats**: Empty state message.
2. **0-message chat**: Skip or show with filename only.
3. **Long messages in search**: Truncate excerpt to ~120 chars.
4. **LLM garbage output**: Reject if empty or >200 chars (title) / >1000 chars (summary).
5. **Rapid AI requests**: Disable button during flight.
6. **No character selected / group chat** (`characterId` undefined): Hide panel or show "Not available" message.
7. **Panel open during character switch**: `CHAT_CHANGED` fires → rebuild.
8. **Filename sanitization**: Allow `a-z`, `0-9`, `-`, `_` only. Preserve `.jsonl`.
9. **Regex special chars in search**: Escape with `query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`.
10. **Missing display name**: Fall back to original filename.

---

## 10. Implementation Order

1. **Scaffold**: `manifest.json`, `index.js`, basic panel toggle. Use `SillyTavern.getContext()` for everything.
2. **Chat Reader**: Fetch chat list + JSONL parsing. Include `getRequestHeaders()` in all fetches.
3. **Thread Cards**: Render with real data, use `moment` for dates.
4. **Metadata Store**: Display name save/load via `extensionSettings`.
5. **Search**: Build index, debounced search with `lodash`, highlighted results with `DOMPurify`.
6. **Jump to Message**: `context.openCharacterChat()` + scroll + flash.
7. **AI Title**: `generateQuietPrompt({ quietPrompt })` — object syntax.
8. **AI Summary**: Same pattern. `generateRaw({ prompt, systemPrompt })` for non-active chats.
9. **Branch Detection**: Message content comparison across files.
10. **Rename Original**: Confirmation dialog + `context.renameChat()`.
11. **Polish**: CSS variables, animations, error handling.

---

## 11. Testing Checklist

- [ ] Panel opens/closes smoothly
- [ ] Thread cards load for selected character
- [ ] Sorted by most recent first
- [ ] Active thread visually distinct
- [ ] Card click switches thread
- [ ] Display name edit saves without file rename
- [ ] AI title works (object syntax for generateQuietPrompt)
- [ ] AI summary works
- [ ] Manual title/summary edit works
- [ ] Search highlights correctly
- [ ] Search debounce works
- [ ] Jump to message scrolls correctly
- [ ] Cross-thread jump switches chat first
- [ ] Flash highlight animation plays
- [ ] Branch indicator shows (where detectable)
- [ ] Rename original shows confirmation
- [ ] Rename original works via context.renameChat()
- [ ] Rename updates settings mapping
- [ ] Disconnected API shows toast
- [ ] Manual features work without API
- [ ] Empty character shows empty state
- [ ] CHAT_CHANGED rebuilds index
- [ ] No JSONL files ever modified
- [ ] All fetch() calls include getRequestHeaders()
- [ ] Group chats handled (characterId undefined)
- [ ] HTML sanitized with DOMPurify

---

## 12. Key Differences from Older SillyTavern Code / Tutorials

If you find examples online, beware of these recent staging changes:

1. **`generateQuietPrompt`** takes `{ quietPrompt, ... }` object — NOT positional args `(prompt, quietToLoud, skipWIAN)`.
2. **`generateRaw`** takes `{ prompt, systemPrompt, prefill }` object — NOT positional args. The `prompt` can also be an array of chat completion message objects.
3. **`event_types`** is deprecated → use **`eventTypes`** from context.
4. **Direct ES module imports** from ST internals are discouraged → use `SillyTavern.getContext()`.
5. **`getRequestHeaders()`** MUST be included in ALL server fetch calls (CSRF protection).
6. **`Popup`, `POPUP_TYPE`, `POPUP_RESULT`** are available from context for modal dialogs.
7. **`saveMetadataDebounced`** is preferred over `saveMetadata` for chat metadata.
8. **`chatMetadata` reference changes** on chat switch — always re-read from `SillyTavern.getContext().chatMetadata`, never cache the reference.