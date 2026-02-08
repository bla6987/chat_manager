# Semantic Embeddings — Implementation Checklist

## Why This Feature

Chat Manager currently treats all chats as flat, unrelated items. Semantic embeddings let us understand what chats are **about** — enabling topic-based coloring in the icicle chart, automatic grouping of similar chats, concept-based search, and visualization of how conversations drift between topics over time.

## Key Architecture Decision: Direct Client-Side API Calls

**Problem**: SillyTavern's server-side vector API (`/api/vector/insert`, `/api/vector/query`) generates embeddings internally but never returns raw vectors to the client. It stores them in vectra for RAG retrieval. We need raw vectors for clustering and color mapping.

**Solution**: Call embedding APIs directly from the browser via `fetch()`. The user configures their API key and provider in our extension settings.

**Why this over alternatives**:
- **Server plugin** would require `enableServerPlugins: true` in config.yaml — not portable, adds deployment friction
- **Piggybacking on ST's vectra** would give us similarity scores (useful for search) but not raw vectors (needed for k-means and PCA)
- **Direct calls** are self-contained, work out of the box, and match the pattern users expect (enter key, select model, go)

**Supported providers**:
- **OpenRouter** (`https://openrouter.ai/api/v1/embeddings`) — most ST users already have an OpenRouter key, supports many embedding models
- **OpenAI** (`https://api.openai.com/v1/embeddings`) — `text-embedding-3-small` is cheap ($0.02/1M tokens) and high quality
- **Ollama** (`http://localhost:11434/api/embeddings`) — fully local, no API key needed, user must have Ollama running with an embedding model pulled

---

## Implementation Checklist

### 1. Embedding Service Module

**File**: `src/embedding-service.js` (NEW)

This is the foundation everything else depends on. It handles API communication, batching, caching, and provides a clean interface for the rest of the system.

- [x] **1.1 Settings schema** — Define and persist embedding settings in `extensionSettings.chat_manager.embeddings`:
  ```js
  {
    enabled: false,
    provider: 'openrouter',  // 'openrouter' | 'openai' | 'ollama'
    apiKey: '',               // for openrouter/openai (stored in ST extension settings, not a secret)
    ollamaUrl: 'http://localhost:11434',
    model: '',                // provider-specific model ID
    dimensions: null,         // auto-detected on first successful embed, cached
    colorMode: 'cluster',    // 'structural' | 'cluster' | 'gradient'
  }
  ```
  **Why store API key in extension settings**: ST's `secret_state` is server-side only and doesn't expose values to client JS. Our key goes in `extensionSettings` which is JSON on disk — same security model as ST's own extension configs. We can add a password-type input so it's masked in the UI.

- [x] **1.2 Provider dispatch** — `embedTexts(texts: string[]): Promise<number[][]>` that routes to the correct API based on `provider` setting:
  - **OpenRouter/OpenAI**: POST to `{baseUrl}/embeddings` with `{ model, input: texts }`, `Authorization: Bearer {apiKey}`. Response shape: `{ data: [{ embedding: number[] }] }`.
  - **Ollama**: POST to `{ollamaUrl}/api/embeddings` with `{ model, prompt: text }`. Ollama does NOT support batch — must loop and embed one at a time. Response shape: `{ embedding: number[] }`.

  **Why these three**: OpenRouter is the most popular ST API provider. OpenAI is the simplest/cheapest for embeddings specifically. Ollama covers the "fully local" use case. All three use standard REST APIs with no special auth flows.

- [x] **1.3 Batch processing with rate limiting** — Wrap the provider dispatch with:
  - Batch size: 20 texts per API call (OpenRouter/OpenAI support batch natively)
  - Ollama: sequential single-text calls with no delay (it's local)
  - API providers: 100ms delay between batches to avoid rate limits
  - Progress callback: `onProgress(completed, total)` for UI progress bar
  - `await new Promise(r => setTimeout(r, 0))` between batches so the UI doesn't freeze

- [x] **1.4 Content-hash caching via IndexedDB** — Use `SillyTavern.libs.localforage.createInstance({ name: 'ChatManager_Embeddings' })`:
  - Key: FNV-1a hash of the text content (fast, non-crypto, deterministic)
  - Value: `{ vector: number[], dims: number, model: string }`
  - Before embedding, check cache. Only embed uncached texts.
  - On model/provider change: prompt user "Model changed. Clear embedding cache?" since vectors from different models are incompatible.
  - **Why LocalForage/IndexedDB**: Embedding vectors are large (384-1536 floats × 4 bytes = 1.5-6KB each). A collection of 5000 messages = 7.5-30MB. IndexedDB handles this fine (50MB+ quota). `extensionSettings` would bloat the settings JSON.

- [x] **1.5 Dimension auto-detection** — On first successful embed call, read `vector.length`, store as `settings.dimensions`. All subsequent vectors must match. If they don't (model changed without cache clear), warn and re-embed.

- [x] **1.6 Helper exports**:
  ```js
  export function isEmbeddingConfigured()    // → bool (provider + model + key set)
  export function getEmbeddingDimensions()   // → number | null
  export async function clearEmbeddingCache()
  export async function getCacheStats()      // → { count, estimatedSizeKB }
  ```

---

### 2. Semantic Engine Module

**File**: `src/semantic-engine.js` (NEW)

Pure math — no API calls, no DOM, no side effects. Takes vectors in, returns cluster labels and colors out.

- [x] **2.1 Cosine similarity** — `cosineSimilarity(a, b): number` — dot product / (norm(a) × norm(b)). Used everywhere: search ranking, drift detection, cluster quality.

- [x] **2.2 k-means clustering** — `kMeans(vectors, k, maxIter=50): { labels, centroids, inertia }`:
  - **k-means++ initialization**: Pick first centroid randomly, subsequent centroids proportional to squared distance from nearest existing centroid. This avoids poor convergence from random init.
  - **Lloyd's algorithm**: Assign → update centroids → repeat until convergence (centroid movement < 1e-6) or maxIter.
  - **Why k-means over DBSCAN/hierarchical**: k-means is simple, fast (O(nkid)), deterministic with k-means++ init, and gives us exactly k clusters which maps cleanly to k colors. DBSCAN requires epsilon tuning and can leave "noise" points unassigned. Hierarchical is O(n²) memory.

- [x] **2.3 Optimal k detection** — `findOptimalK(vectors, maxK=8): number`:
  - Run k-means for k=2,3,...,maxK
  - Compute inertia (within-cluster sum of squared distances) for each
  - Find "elbow" using the kneedle method: normalize the inertia curve, find the point of maximum curvature
  - Fallback: `min(5, ceil(n/3))` if elbow detection fails
  - **Why maxK=8**: More than 8 clusters makes colors hard to distinguish and groupings too fine-grained.

- [x] **2.4 PCA to 3 dimensions** — `pca3D(vectors): { projected, mean, components }`:
  - Center data (subtract mean vector)
  - Compute covariance matrix (d×d where d = embedding dims)
  - Power iteration for top 3 eigenvectors (much faster than full eigendecomposition when target dims << source dims)
  - Project all vectors to 3D
  - **Why PCA over UMAP/t-SNE**: PCA is deterministic, fast, has no hyperparameters, and preserves global structure. UMAP is better for visualization but requires a library (~100KB) and is stochastic. For color mapping (not 2D scatter plots), PCA is sufficient.
  - **Performance note**: For d=384, covariance matrix = 384×384 = ~590KB. Power iteration for 3 components = ~50ms. Acceptable on initial load. Cache the projection matrix for incremental updates.

- [x] **2.5 Color palette** — `clusterColor(clusterIdx): string`:
  ```js
  const PALETTE = [
    '#E05252', '#5294E0', '#52B788', '#E0A052',
    '#9B72CF', '#52BFB8', '#CF7298', '#7E8C4A'
  ];
  ```
  8 perceptually distinct colors chosen for: mutual contrast, readability on both light and dark backgrounds, accessibility (distinguishable with common color blindness types). Returns `PALETTE[idx % 8]`.

- [x] **2.6 Gradient color mapping** — `gradientColor(pca3dVector): string`:
  - Normalize each component to [0, 1] range
  - Map to HSL: `hsl(x×330, 55+y×30%, 42+z×18%)`
  - **Why HSL**: Natural perceptual model. Hue = topic identity, saturation = topic clarity, lightness = prevents too-dark/too-light colors.

- [x] **2.7 Topic shift scores** — `topicShiftScores(orderedVectors): number[]`:
  - For consecutive pairs: `1 - cosineSimilarity(v[i], v[i+1])`
  - Returns array of length N-1, values in [0, 2] (typically 0-1)
  - Values > 0.3 = moderate shift, > 0.5 = significant topic change

---

### 3. Settings UI

**Files**: `src/ui-controller.js`, `src/metadata-store.js`, `style.css`

The settings panel needs an "Embeddings" section so users can configure and trigger embedding generation.

- [x] **3.1 Add embedding settings to metadata-store.js** — `getEmbeddingSettings()`, `setEmbeddingSettings(settings)` helpers that read/write from `extensionSettings.chat_manager.embeddings`. Initialize defaults on first load.

- [x] **3.2 Settings UI section** — Add to the existing settings panel (rendered in `ui-controller.js`):
  - Enable/disable checkbox
  - Provider dropdown (OpenRouter / OpenAI / Ollama)
  - API Key input (password type, shown for OpenRouter/OpenAI)
  - Ollama URL input (shown when Ollama selected)
  - Model text input (with placeholder showing suggested model per provider)
  - Color mode dropdown (Structural / Cluster / Gradient) — controls icicle chart
  - "Generate Embeddings" button with progress bar
  - "Clear Cache" button
  - Cache stats display (N vectors, ~X KB)

- [x] **3.3 Generate Embeddings flow** — On button click:
  1. Validate config (provider, key, model set)
  2. Collect representative text for each chat in `chatIndex`:
     - If chat has an AI summary → use that (already concise + semantic)
     - Else → concatenate last 10 messages (or all if <10), truncated to 2000 chars
     - **Why summaries preferred**: They're denser signal in fewer tokens. Cheaper to embed and produces better cluster separation than raw message dumps.
  3. Filter out already-cached (content hash check)
  4. Call `embedTexts()` with progress callback → update progress bar
  5. Store vectors on `chatIndex[file].chatEmbedding`
  6. Run `findOptimalK()` + `kMeans()` → store labels on `chatIndex[file].clusterLabel`
  7. Re-render current view

- [x] **3.4 Wire up to index.js** — On extension init, if embeddings enabled, attempt to load cached embeddings and cluster labels from previous session. On CHAT_CHANGED / MESSAGE_SENT / MESSAGE_RECEIVED, schedule incremental re-embedding of affected chat (debounced).

---

### 4. Chat Card Clustering

**File**: `src/ui-controller.js`, `src/chat-reader.js`, `style.css`

The first user-visible feature. Once embeddings + clusters exist, cards show their cluster and can be sorted by it.

- [x] **4.1 Add fields to ChatIndexEntry** — In `chat-reader.js`, add transient (non-persisted) fields:
  ```js
  chatEmbedding: number[] | null,   // set after embedding
  clusterLabel: number | null,       // set after clustering
  ```

- [x] **4.2 Cluster dot on cards** — In `renderThreadCardsFromEntries()`, when `entry.clusterLabel != null`, render a small colored circle (8×8px, border-radius 50%) next to the card title. Color from `clusterColor(entry.clusterLabel)`. CSS class: `.chat-manager-cluster-dot`.

- [x] **4.3 Sort by cluster** — Add `'cluster'` option to the sort dropdown in `ensureFilterToolbar()`:
  ```js
  case 'cluster':
    cmp = (a.clusterLabel ?? 999) - (b.clusterLabel ?? 999);
    break;
  ```
  Within each cluster, secondary sort by existing sort preference (recency, alphabetical, etc.).

- [x] **4.4 Cluster dividers** — When sorted by cluster, insert a thin colored divider bar between groups with the cluster color. No label text (clusters don't have meaningful names yet — that's a future AI labeling feature).

---

### 5. Icicle Chart Semantic Coloring

**Files**: `src/icicle-view.js`, `src/icicle-data.js`

This is the most visually impactful feature — the entire icicle chart changes from structural blue/brown to a topic-colored view.

- [x] **5.1 Color mode toggle button** — Add to the icicle toolbar (alongside Reset/Focus buttons):
  - Cycles through: Structural → Cluster → Gradient
  - Label: icon or short text showing current mode
  - Only enabled when embeddings are generated (disabled/hidden otherwise)
  - State persisted in `extensionSettings.chat_manager.embeddings.colorMode`

- [x] **5.2 Propagate cluster data to trie nodes** — In `icicle-data.js`, during `buildIcicleData()`:
  - Each trie node tracks `chatFiles[]` — the chats that pass through it
  - For leaf nodes (single chat): `node.clusterLabel = chatIndex[file].clusterLabel`
  - For internal nodes (multiple chats): `node.clusterLabel = majorityCluster(node.chatFiles)` — the most common cluster among its chats
  - For gradient mode: `node.chatEmbedding = meanPool(chatEmbeddings of node.chatFiles)` then project via cached PCA matrix → `node.pca3d`
  - **Why majority vote for internal nodes**: Internal nodes represent shared message prefixes. The majority cluster gives the most representative color. Alternative (blended colors) looks muddy.

- [x] **5.3 Modify fillColor logic** — In `icicle-view.js` around line 644, add semantic color branches:
  ```js
  if (colorMode === 'cluster' && node.clusterLabel != null) {
    fillColor = clusterColor(node.clusterLabel);
    if (!isActive) fillColor = withAlpha(fillColor, 0.55);
    if (isHovered) fillColor = lighten(fillColor, 15);
  } else if (colorMode === 'gradient' && node.pca3d) {
    fillColor = gradientColor(node.pca3d);
    if (!isActive) fillColor = withAlpha(fillColor, 0.55);
  }
  // else: existing structural color logic (unchanged)
  ```
  - Active path nodes: full opacity
  - Non-active: slightly dimmed (0.55 alpha)
  - Hover: lightened
  - Branch divergence points: retain a subtle marker (border or glow) regardless of color mode

- [x] **5.4 Legend/key** — Small floating legend showing cluster colors (only in cluster mode). Position: bottom-right of icicle canvas. Shows colored dots. Clicking a cluster color highlights all nodes of that cluster.

---

### 6. Semantic Search

**Files**: `src/ui-controller.js`, `src/embedding-service.js`

Requires per-message embeddings (more expensive than per-chat). Can be deferred until after the clustering features are working.

- [x] **6.1 Per-message embedding generation** — Extend the "Generate Embeddings" flow to also embed individual messages:
  - Only embed messages from loaded chats
  - Cache aggressively (same message text across chats = same embedding)
  - Store on `chatIndex[file].messageEmbeddings = Map<msgIndex, number[]>`
  - **Why deferred**: Per-message is 10-50x more vectors than per-chat. For 100 chats × 50 msgs = 5000 embeds. At $0.02/1M tokens ≈ ~$0.01 total (cheap), but takes time.

- [x] **6.2 Hybrid search ranking** — In `performSearch()`, when embeddings available and query ≥ 5 chars:
  1. Embed query text via `embedText(query)`
  2. For each searchable message with an embedding:
     - `semanticScore = cosineSimilarity(queryEmbed, msgEmbed)`
     - `keywordScore = textLower.includes(queryLower) ? 1.0 : 0.0`
     - `combinedScore = 0.7 × semanticScore + 0.3 × keywordScore`
  3. Sort by `combinedScore`, take top 100
  - **Why hybrid**: Pure semantic search misses exact matches the user expects. Pure keyword misses conceptual matches. The 70/30 blend gives semantic priority while guaranteeing exact matches rank high.
  - Fall back to pure keyword search if embeddings unavailable

- [x] **6.3 Search mode indicator** — Small badge in search bar showing "Semantic" (when embeddings active) or "Keyword" (when not). Non-interactive, just informational.

---

### 7. Topic Drift Visualization

**Files**: `src/icicle-view.js`, `src/semantic-engine.js`

The most advanced feature. Shows where conversations change topic.

- [x] **7.1 Compute drift scores for active chat** — When a chat is focused in the icicle view, compute `topicShiftScores()` for its message embeddings. Cache result per chat file.

- [x] **7.2 Visual indicator on icicle nodes** — For the active chat path, modulate node appearance based on drift:
  - Low drift (< 0.2): normal appearance
  - Medium drift (0.2-0.4): subtle warm tint (topic is shifting)
  - High drift (> 0.4): bright accent border or glow (major topic change)
  - This overlays on top of whatever color mode is active (structural, cluster, or gradient)

- [x] **7.3 Drift summary in chat info** — When hovering a card or viewing chat details, show "N topic shifts detected" with approximate positions. Clicking could jump to those message positions.

---

### 8. Incremental Updates & Performance

**Files**: `index.js`, `src/embedding-service.js`, `src/ui-controller.js`

- [x] **8.1 Incremental re-embedding on new messages** — Listen for MESSAGE_SENT / MESSAGE_RECEIVED events:
  1. Re-compute representative text for the active chat
  2. If content hash changed → re-embed → update cache
  3. Track changed embeddings count

- [x] **8.2 Debounced re-clustering** — After 5+ embeddings change, or 60s of idle time after changes:
  1. Re-run k-means with same k (or re-detect optimal k if chat count changed >20%)
  2. Update cluster labels
  3. Re-render affected views

- [x] **8.3 Startup optimization** — On panel open:
  1. Load embedding settings from `extensionSettings`
  2. If enabled: asynchronously load cached embeddings from IndexedDB
  3. Match to current `chatIndex` entries by content hash
  4. Run clustering on loaded embeddings (fast, ~50-250ms for 100 chats)
  5. Don't block panel rendering — show cards/icicle immediately, add semantic data when ready

- [x] **8.4 Cache invalidation** — When user changes model or provider:
  - Prompt: "Embedding model changed. Clear cache and regenerate?"
  - If yes: `clearEmbeddingCache()` + clear all `chatEmbedding`/`clusterLabel` from chatIndex
  - If no: keep old embeddings but warn they may be inconsistent

---

## Reference: Existing Code to Reuse

| What | Where | How |
|------|-------|-----|
| Chat index structure | `chat-reader.js` → `chatIndex` | Add fields directly |
| Chat summaries | `metadata-store.js` → `getChatMeta(avatar, file).summary` | Use as embedding input text |
| Extension settings | `metadata-store.js` → `extensionSettings.chat_manager` | Add `.embeddings` key |
| Event listeners | `index.js` → `eventSource.on(...)` | Add embedding update handlers |
| Icicle trie nodes | `icicle-data.js` → `buildIcicleData()` returns `{ root, flatNodes }` | Each node has `chatFiles[]` |
| Icicle fill colors | `icicle-view.js` ~line 639-659 | Add semantic branch |
| Card rendering | `ui-controller.js` → `renderThreadCardsFromEntries()` | Add cluster dot |
| Sort options | `ui-controller.js` → `ensureFilterToolbar()` | Add 'cluster' |
| Filter/sort dispatch | `chat-reader.js` → `getFilteredSortedEntries()` | Add cluster sort case |
| Search | `ui-controller.js` → `performSearch()` | Add semantic ranking |
| Settings persistence | `metadata-store.js` → `saveMetadataDebounced()` | Reuse |
| LocalForage | `SillyTavern.libs.localforage` | Available globally |
| Request headers | Can import `getRequestHeaders` from ST scripts | Not needed (direct API calls) |

## Verification Checklist

1. Configure OpenRouter with `text-embedding-3-small` in settings → no errors
2. Click "Generate Embeddings" for a character with 10+ chats → progress bar fills, completes
3. Cards show cluster dots with distinct colors per group
4. Sort by cluster → cards visually grouped
5. Switch to icicle chart → toggle "Cluster" mode → nodes colored by topic
6. Toggle "Gradient" mode → nodes show continuous color spectrum
7. Toggle back to "Structural" → original blue/brown colors restored
8. Reload page → embeddings load from cache, no API calls, clusters re-computed instantly
9. Send a new message → active chat re-embeds, cluster may update
10. Change model → prompted to clear cache
11. Search with semantic mode → conceptual queries return relevant results
12. Switch to Ollama provider → works without API key, local endpoint
