# Chat Manager additional error and efficiency audit

October 14, 2026, America/New_York. Five GPT-6.1 Sol agents audited navigation, indexing, UI actions, embeddings, and semantic views. Parent review and repeated synthetic probes confirmed **24 additional findings: one P1, 21 P2, and two P3**. The two P3 findings are measured extra work/request behavior, without a claim about live latency. One additional search coverage limitation is listed separately.

The highest priority is the failed-save navigation guard, followed by message-index normalization and serialization of complete jump operations. Several independent refresh/cancellation defects affect the other visualizations as well as the branch chart.

The audit used current working files, including the earlier uncommitted branch-chart fixes. It made no implementation changes, commits, real chat mutations, or real provider requests. The original 42 automated tests passed; the probes below exercise additional cases those tests do not cover. These findings are additional to the [October 13 audit](/Users/macbookpro/projects/extensions/sillytavern/audit-reports/2026-10-13/chat_manager.md), whose nine existing findings are tracked separately below.

## Navigation and message identity

### 1 P1 Failed saves still permit switching away from unsaved edits

[ui-controller.js:4230](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:4230) awaits `context.saveChat()` and then opens the target. The host catches ordinary save failures internally at [script.js:7450](/Users/macbookpro/projects/source_projects/SillyTavern/public/script.js:7450). A resolved promise therefore does not confirm that the current edits were saved. Switching can clear those unsaved edits from the active chat.

**Evidence:** The actual host save function with a synthetic HTTP 500, followed by the actual extension switch helper, produced one save-error toast, one target open, and a successful switch result. No real data was lost in this probe. See [host-jumps.mjs](./probes/host-jumps.mjs).

**Repair:** Require a verifiable save-success outcome before switching. The existing test that mocks `saveChat()` rejecting does not model the host's actual failure contract. This defect predates removal of the fixed navigation delays.

### 2 P2 Archived messages receive indices one higher than host message positions

[chat-reader.js:306](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/chat-reader.js:306) skips the JSONL metadata header but assigns the original array offset to each message. The host removes the header before populating `context.chat` at [script.js:7630](/Users/macbookpro/projects/source_projects/SillyTavern/public/script.js:7630).

**Evidence:** The same two messages had indices `[1,2]` after HTTP hydration and `[0,1]` after an active-chat update. Search passes the stored index to `/chat-jump`, so an archived result can jump one message too far or beyond the final message. Deduplication and embedding identities also differ between the two representations. See [index.mjs](./probes/index.mjs).

**Repair:** Remove the header before assigning host-compatible message indices. Migrate or invalidate persistent chat caches containing shifted indices.

### 3 P2 An older jump can override the destination of a newer jump

[ui-controller.js:1725](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:1725) and [ui-controller.js:4206](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:4206) allow concurrent switch-and-scroll operations. The host `/chat-jump` command can await loading earlier messages, then resume against the current chat DOM after a newer action changes threads.

**Evidence:** Actual timeline handlers and the actual host slash-command callback scrolled the new chat to message 5, then the older operation scrolled that same new chat to message 1. See [host-jumps.mjs](./probes/host-jumps.mjs).

**Repair:** Serialize the entire switch-and-scroll operation across all jump entry points. A lock around switching alone cannot prevent a pending scroll command from targeting the next chat.

### 4 P2 Clicking an edited thread title opens the chat twice

[ui-controller.js:3740](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3740) adds a direct click handler to the replacement title span, while the container already delegates the same click at [ui-controller.js:3643](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3643). Saving or cancelling an inline edit creates this state.

**Evidence:** One bubbling click invoked `openCharacterChat()` twice before either call completed. The host open function clears, loads, and renders without serializing these calls. See [ui.mjs](./probes/ui.mjs).

**Repair:** Rely on the existing delegated listener and omit the direct listener on the replacement span.

## Chart lifecycle and focus

### 5 P2 Opening an empty visualization prevents normal recovery when data arrives

Three views share an initialization defect with different consequences. [icicle-view.js:246](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/icicle-view.js:246) returns before marking the branch chart mounted; the hydration scheduler only refreshes mounted charts. [semantic-map-view.js:162](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/semantic-map-view.js:162) and [graph-view.js:203](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/graph-view.js:203) mark themselves mounted but return before sizing the canvas or binding interaction handlers. The graph also skips its resize observer.

**Evidence:** Empty branch-chart mount followed by loaded data retained zero nodes and `mounted:false`. Empty map/graph mounts followed by nonempty updates made zero event-binding and sizing calls; graph observer calls also remained zero. See [navigation.mjs](./probes/navigation.mjs) and [semantic.mjs](./probes/semantic.mjs).

**Repair:** Initialize the view lifecycle and event/resize handling independently of whether data exists. Alternatively, explicitly remount on the first usable data update.

### 6 P2 Jump in graph fails for loaded threads outside the current focus

[ui-controller.js:4127](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:4127) makes missing-target persistence depend on whether a thread is loaded, rather than whether it is visible in the chart. Current-thread focus can exclude a loaded search result. [icicle-view.js:2395](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/icicle-view.js:2395) then discards its focus request.

**Evidence:** With two unrelated loaded threads and default thread focus, targeting the second thread returned `false` and cleared the pending request. See [navigation.mjs](./probes/navigation.mjs).

**Repair:** Explicit navigation must include its target. Leave incompatible thread/exploration filters, rebuild the needed scope, then apply the focus request.

### 7 P2 Long chats overflow recursive chart construction

[icicle-data.js:361](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/icicle-data.js:361) recursively lays out every message in a linear path. Membership compaction, semantic annotation, and flattening also recurse at lines 157, 288, and 379.

**Evidence:** Actual construction passed 1,000–4,000 synthetic messages, failed with `RangeError` at 6,000 in layout, and failed at 8,000 in semantic annotation. The exact limit depends on the JavaScript runtime; these counts were measured in Node, not a live browser. See [navigation.mjs](./probes/navigation.mjs).

**Repair:** Replace all depth-recursive traversals with explicit stacks, including annotation and flattening rather than fixing only layout.

## Search and asynchronous state

### 8 P2 Clearing the main search can be undone by an older response

[ui-controller.js:3361](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3361) and [ui-controller.js:4290](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:4290) render cards for a short/empty query without invalidating the pending semantic request.

**Evidence:** A delayed semantic search, followed by clearing the input, painted the thread list and then replaced it with stale semantic results when the embedding completed. Independently reproduced by two agents, counted once. See [ui.mjs](./probes/ui.mjs) and [embeddings.mjs](./probes/embeddings.mjs).

**Repair:** Invalidate pending search work for every query transition, including empty input, and check current query/view identity before rendering.

### 9 P2 Clearing map scores can be undone by a worker response

[semantic-map-view.js:793](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/semantic-map-view.js:793) clears displayed scores but leaves the outstanding worker score job valid. The worker handler still accepts its response.

**Evidence:** Actual Search and Clear handlers retained job ID 2; a response delivered through the actual worker callback restored scores `[0.8,0.1]` while the query remained empty. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Advance a query generation immediately on Search/Clear, including short input. Guard both embedding completion and worker responses against it.

### 10 P2 Pending graph pins survive Clear and bypass duplicate and capacity limits

[graph-view.js:416](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/graph-view.js:416) checks duplicates and capacity before awaiting an embedding at line 436. Insertion at line 467 does not revalidate those conditions or the mount/clear lifecycle.

**Evidence:** Clearing while one pin was pending still allowed it to appear later. Ten simultaneous requests for the same term inserted ten identical pins despite the eight-pin limit. See [semantic.mjs](./probes/semantic.mjs). Missing lifecycle validation can also let old work enter a later mount; the probe directly tested Clear and concurrent insertion.

**Repair:** Track pending terms and a mount/clear generation. Discard obsolete completions and recheck capacity and duplicate identity immediately before insertion.

## Semantic graph correctness

### 11 P2 Message pins change identity when the collected array changes

[graph-view.js:499](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/graph-view.js:499) retains a numeric index into `messageRefs`. Filtering or refreshing replaces that array without remapping the pin. The old index is reused when excluding pinned messages and resolving tooltips.

**Evidence:** Pinning Beta in `[Alpha,Beta,Gamma]`, then filtering to `[Beta,Gamma]`, left the pin labelled Beta while its index resolved to Gamma. Gamma was excluded and Beta appeared as its own neighbor. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Store filename/message/swipe identity, remap after collection, refresh text/vector, and explicitly handle pins that leave scope or disappear.

### 12 P2 Refresh randomizes settled graph nodes without restarting simulation

[graph-view.js:301](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/graph-view.js:301) rebuilds nodes, which assigns random positions at line 638, but does not restart the force simulation.

**Evidence:** After settling, an actual data refresh rebuilt the nodes while `simRunning` remained false. Rendering showed newly randomized starting positions without any subsequent force updates. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Preserve stable positions where possible and restart simulation when a rebuild changes its nodes or forces.

### 13 P2 Negative similarity can produce an invalid canvas radius

[graph-view.js:927](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/graph-view.js:927) uses cosine similarity directly to interpolate radius from 3 to 7. Similarity below −0.75 produces a negative radius, which Canvas `arc()` rejects. A throw interrupts the animation callback before it schedules the next frame or clears its frame ID.

**Evidence:** Actual graph construction retained similarity −1 for vectors `[1,0]` and `[-1,0]`; actual drawing passed radius −1 to a Canvas-contract stub, which threw. This establishes the invalid drawing input; the probe did not run a real canvas. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Clamp or remap similarity to a valid visual range for radius and alpha. Filtering negative matches is a separate product choice.

### 14 P2 PCA projection can collapse distinct vectors or duplicate its axes

[semantic-map-worker.js:228](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/semantic-map-worker.js:228) starts both component searches on the first coordinate axis. If covariance multiplication or orthogonalization yields zero, the loop exits at line 270 and returns its unchanged seed.

**Evidence:** Four distinct vectors with constant first coordinate projected to four identical `(0,0)` points. Four vectors with diagonal covariance projected to just two points with identical x/y coordinates, discarding the second-coordinate variation. The worker also uses projected points for clustering. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Use seeds with support across dimensions, orthogonalize initial seeds, and retry degenerate directions. Return a zero component only when remaining covariance has no variance.

### 15 P2 Map hit testing misses nearby points inside its own tolerance

[semantic-map-view.js:1246](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/semantic-map-view.js:1246) only searches the adjacent 3×3 grid cells, regardless of the world-space size of the 10-pixel selection tolerance.

**Evidence:** On a 500×500 viewport covering `[0,1]²`, a point 9.55 pixels from the cursor returned no hit because its grid column was two cells away. See [semantic.mjs](./probes/semantic.mjs).

**Repair:** Calculate the grid range from the actual hit radius and cell size, then compare candidates using screen-space distance.

## Dates and metadata

### 16 P2 Calendar date filters use UTC boundaries

[chat-reader.js:1364](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/chat-reader.js:1364) and line 1374 parse date input through `new Date('YYYY-MM-DD')`, producing UTC midnight while the UI uses local calendar dates.

**Evidence:** Under America/New_York, an October 14-only filter included October 13 at 21:00 and excluded October 14 at 21:00. See [ui.mjs](./probes/ui.mjs).

**Repair:** Construct local midnight from year/month/day components and use an exclusive next-local-day upper bound, with calendar arithmetic for daylight-saving transitions.

### 17 P2 Historical host timestamps disappear from statistics

[stats-engine.js:125](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/stats-engine.js:125) uses JavaScript Date parsing and silently skips unsupported strings. Reader timestamp normalization has the same incompatibility. The host parser explicitly supports historical forms at [utils.js:1127](/Users/macbookpro/projects/source_projects/SillyTavern/public/scripts/utils.js:1127).

**Evidence:** A loaded chat with timestamp `2024-07-12@01h31m37s123ms` produced an empty heatmap marked complete. See [ui.mjs](./probes/ui.mjs).

**Repair:** Normalize timestamps with host-compatible parsing at ingestion and reuse normalized milliseconds across statistics, search, filters, and recency sorting.

### 18 P2 An empty archive can leave deleted messages searchable

[chat-reader.js:737](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/chat-reader.js:737) clears the index without incrementing its version. `getSearchableMessages()` consequently reuses the cached array.

**Evidence:** A successful empty archive response left index size zero, the version unchanged, and two removed messages in the identical search-cache array. See [index.mjs](./probes/index.mjs).

**Repair:** Invalidate the searchable cache and index version whenever this path removes entries, including a successful empty list.

### 19 P2 Clearing a display name does not clear its saved metadata

[ui-controller.js:3748](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3748) skips persistence when an inline title is blank or equals the filename. The visible span changes, but the previous custom name survives and returns on refresh.

**Evidence:** The visible title became `target.jsonl` while the actual metadata still contained `Old title`. See [ui.mjs](./probes/ui.mjs).

**Repair:** Explicitly persist an empty display name when reverting to the filename/default.

## Embeddings

### 20 P2 Cached embeddings ignore the Ollama server identity

[embedding-service.js:463](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/embedding-service.js:463) validates model/provider/text/dimensions but not the endpoint. Cache writes at line 639 omit endpoint identity. Changing servers under the same model alias can reuse another model's vectors.

**Evidence:** Embedding text on server A, switching the configured URL to B, then embedding the same text returned A's vector with only one total synthetic fetch. See [embeddings.mjs](./probes/embeddings.mjs).

**Repair:** Include normalized endpoint identity in cache recipe keys and metadata, and invalidate in-memory vectors when the endpoint changes.

### 21 P2 Missing alternate swipes are skipped when active vectors are complete

[ui-controller.js:933](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:933) collects alternate-swipe candidates, but the zero-work return at line 937 counts only active-message and chat candidates. It returns before the alternate queue at line 1038. Completion checks also ignore configured alternate coverage.

**Evidence:** One message with an existing active vector and missing alternate vector returned `skipped:true`, queued zero alternates, and reported `threadNeedsEmbeddings:false`. See [embeddings.mjs](./probes/embeddings.mjs).

**Repair:** Queue alternate candidates even when active/chat work is zero and include their configured coverage in completion checks.

### 22 P2 Alternate swipe matches show the active swipe excerpt

[ui-controller.js:3298](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3298) scores the variant but stores the original active message as `result.item`. The renderer reads `item.text` at line 3476.

**Evidence:** Query `treasure` matched alternate swipe 1, `alternate treasure answer`, but the result excerpt used `active unrelated answer`. See [embeddings.mjs](./probes/embeddings.mjs).

**Repair:** Store and render the matched variant text separately while preserving the original message identity for navigation.

## Confirmed inefficiencies

### 23 P3 Restoring cached chats repeatedly scans the hydration queue

[chat-reader.js:939](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/chat-reader.js:939) filters the shrinking hydration queue separately for each cached entry.

**Evidence:** An instrumented copy of current source counted **500,500 predicate visits for 1,000 cached chats**, exactly `N(N+1)/2`. All bodies came from the synthetic cache. See [queue-cost.mjs](./probes/queue-cost.mjs).

**Repair:** Collect restored filenames and filter once, or create the queue after cache reconciliation. This is a measured operation count, not a measured live slowdown.

### 24 P3 A transient Ollama error disables batching for the rest of the session

[embedding-service.js:618](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/embedding-service.js:618) treats any batch exception as unsupported endpoint capability and changes a global flag to false. Later healthy requests and other servers continue using sequential single requests.

**Evidence:** One synthetic HTTP 503 caused the first three-text batch to fall back; a subsequent healthy three-text batch never retried batching. Totals were one batch attempt plus six single requests. See [embeddings.mjs](./probes/embeddings.mjs).

**Repair:** Persist fallback only for explicit unsupported-route responses, scope capability by endpoint, and retry transient failures with bounded backoff. Live latency was not measured.

## Search coverage decision

Automatic semantic search starts when any message vector exists and excludes messages without vectors before checking keyword matches. The embedding probe confirmed that an exact keyword match in a loaded but unembedded thread disappeared from a query of at least five characters. Relevant code: [ui-controller.js:3274](/Users/macbookpro/projects/extensions/sillytavern/chat_manager/src/ui-controller.js:3274).

This is a confirmed coverage limitation, not included in the bug count because no documented promise of keyword fallback was established. A union of keyword results and semantic results would preserve keyword recall while embedding coverage is partial.

## Previously reported issues

The [October 13 report](/Users/macbookpro/projects/extensions/sillytavern/audit-reports/2026-10-13/chat_manager.md) remains applicable to these nine findings. They are not counted again.

| Prior issue | Status in this audit |
| --- | --- |
| Filename rename reads its input after the host removes the popup | Reproduced again in the UI probe; zero rename calls after affirmative confirmation |
| AI results can write metadata under the newly selected character | Relevant source path remains; prior reproduction retained |
| Temporary AI profile locking is bypassed when the target profile is already selected | Shortcut remains in source; prior reproduction retained |
| Non-OK HTTP responses become valid empty chat/index data | Relevant source paths remain; prior reproduction retained |
| Last-message time is an insufficient cache-freshness marker | Relevant source path remains; prior reproduction retained |
| In-flight embedding responses can be tagged with newly selected model settings | Reproduced again: model A response persisted as model B after a cache clear |
| Shared greetings are treated as proof of branch ancestry | Relevant source path remains; prior reproduction retained |
| Early generation exits can leave embeddings deferred | Event subscriptions remain; prior reproduction retained |
| Unrelated error toasts trigger failed-generation alerts | Generic toast observation remains; prior reproduction retained |

## Reproduction and scope

The parent reran all seven probe scripts successfully against the audited source. Probes use actual modules or extracted current functions with synthetic contexts, mocked network/cache/DOM boundaries, and selected actual host functions. They do not establish real browser stack limits or production latency. The canvas exception probe checks the Canvas radius contract with a stub. Source links refer to this working tree's current line numbers.

The scripts retain local absolute paths to the extension and host checkouts. Run them separately so each process has fresh module state:

```sh
node tests/artifacts/2026-10-14-additional-audit/probes/navigation.mjs
node tests/artifacts/2026-10-14-additional-audit/probes/host-jumps.mjs
node tests/artifacts/2026-10-14-additional-audit/probes/index.mjs
TZ=America/New_York node tests/artifacts/2026-10-14-additional-audit/probes/ui.mjs
node tests/artifacts/2026-10-14-additional-audit/probes/embeddings.mjs
node tests/artifacts/2026-10-14-additional-audit/probes/semantic.mjs
node tests/artifacts/2026-10-14-additional-audit/probes/queue-cost.mjs
```

Unmeasured ideas such as bounded intermediate graph scoring allocations and reducing repeated embedding-availability scans were excluded from the confirmed finding count.
