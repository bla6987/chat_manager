# Chat Manager fixes and verification

The 24 findings in [the additional audit](./README.md) and its nine previously reported issues have been addressed in the working tree. Seven GPT-6.1 Sol agents implemented the fixes in separate file areas; a further Sol agent independently reviewed navigation, indexing, caching, statistics, and lifecycle integration. The parent reviewed the combined changes and ran the integrated checks.

The earlier branch-chart repairs remain included: remove fixed navigation waits, keep archive refresh outside the host's awaited chat-change event, preserve viewport and branch ordering during refresh, retain Explore, and prevent late search results from moving a view the user has scrolled.

## Findings and regression coverage

Numbers refer to the additional audit. Test paths are relative to the repository's `tests` directory.

| Findings | Repair | Regression coverage |
| --- | --- | --- |
| 1, 3 | One navigation queue covers save verification, opening, loading earlier messages, and guarded scrolling. A fresh persisted read must match live messages and metadata before leaving the source. | `chat-navigation.test.mjs`, `ui-actions-regression.test.mjs`, `browser-chat-navigation.html` |
| 2, 18 | Disk and live messages use the same zero-based IDs; old chat-cache records are invalidated; successful empty archives invalidate search caches. | `index-cache-regressions.test.mjs` |
| 4, 19 | Edited titles use one delegated click handler; reverting a display name clears saved metadata. | `ui-actions-regression.test.mjs` |
| 5–7 | All views initialize while empty; branch focus reveals excluded targets; all depth-dependent trie traversals use explicit stacks. | `icicle-lifecycle.test.mjs`, `semantic-view-regressions.test.mjs`, branch and semantic browser fixtures |
| 8–10 | Query generations reject obsolete completions. Graph pins reserve capacity and validate lifecycle, duplicates, and limits after awaiting embeddings. | UI and semantic regression suites |
| 11–13 | Pins retain filename/message/swipe identity; refresh preserves existing positions and restarts changed simulations; drawing uses valid radii and opacity for negative cosine scores. | `semantic-view-regressions.test.mjs`, `browser-semantic-regressions.html` |
| 14–15 | Worker and synchronous/asynchronous engine PCA choose nondegenerate directions; map hit testing searches the full selection radius. | `semantic-view-regressions.test.mjs`, real Worker browser checks |
| 16–17 | Local calendar bounds handle daylight-saving changes; historical host timestamps normalize for sorting, filters, statistics, and date-range output. | `index-cache-regressions.test.mjs` |
| 20 | Persistent embeddings include provider, model, and normalized endpoint identity. Immutable operation settings and invalidation generations protect pending work. | `embedding-ai-concurrency.test.mjs`, UI and view regression suites |
| 21–22 | Missing alternate swipes queue even when active vectors are complete; completion includes configured alternate coverage; excerpts show the matched swipe. | `ui-actions-regression.test.mjs` |
| 23 | Cached chat restoration reconciles hydration-queue membership once rather than filtering once per chat. | 1,000-chat operation-count regression in `index-cache-regressions.test.mjs` |
| 24 | Transient Ollama failures get one bounded retry. Only explicit unsupported routes disable batching, separately for each endpoint. | `embedding-ai-concurrency.test.mjs` |

| Previously reported issue | Repair and coverage |
| --- | --- |
| Rename reads an already-removed popup input | Native input return value is captured; metadata moves only after a matching host rename event. UI regression suite. |
| AI results write under a newly selected character | Messages, character identity, and context are captured before awaiting; writes use the captured avatar. UI regression suite. |
| AI profile lock bypass and shared quiet-prompt race | Every operation enters the same queue; cleanup respects a subsequent user profile selection. Embedding/AI concurrency suite. |
| HTTP errors become valid empty data | Non-OK and malformed responses fail without discarding the last successful body; hydration remains retryable. Index/cache suite. |
| Last-message time misses earlier edits | Local dirty events and explicit reopen revalidate immediately; normal reuse checks size/count and expires after 60 seconds. In-flight stale responses retry. Index/cache and lifecycle suites. |
| Model changes/cache clears race with embedding responses | Epoch and entry-identity checks protect attachments; cache clearing waits for all issued writes to settle. Embedding/AI and UI suites. |
| Shared greetings imply branch ancestry | Prompt context requires host `main_chat` or `extra.branches` provenance; role-aware prefix comparison determines divergence. Index/cache suite. |
| Early generation exits defer embeddings indefinitely | Lifecycle follows host foreground generation state and reconciles pre-request exits, including a test using the actual host command-only preamble. Lifecycle suite. |
| Unrelated error toasts trigger failure audio | Failure detection uses unsuccessful termination or failed-stream state; timer cleanup covers success, stop, replacement, and expiry. Lifecycle suite. |

## Review follow-ups

Review additionally covered stale hydration during same-timestamp edits, historical date-range output, revalidation completeness indicators, partially failed cache-write batches, restarting fresh alternate-swipe work after an obsolete request, and clearing cached query vectors and pins across model/server changes. Confirmed dimension drift now clears live vectors centrally even when first discovered by a view's direct query; foreground generation retries once from fresh state. Browser fixtures use actual canvases and Workers with generated messages and mocked embedding responses.

## Validation

The parent final run passed **147/147 automated tests**, with zero failures or skips, and **47/47 browser assertions** across four fixtures. Syntax checks for every source module and Node test, plus `git diff --check`, passed. Full results are recorded in [fix-validation.txt](./fix-validation.txt) and [browser-validation.txt](./browser-validation.txt). The independent review's two findings were corrected and rechecked; no actionable issues remained in its assigned review area.

The historical probes and source snapshot in this directory remain unchanged: they document the pre-fix behavior and intentionally assert those older failures. The final source/test hashes are in `fixed-source-sha256.txt`. Browser screenshots are saved as `branch-browser-proof.png` and `navigation-browser-proof.png`.

## Practical limits

- This is local implementation and synthetic verification, with read-only comparison against the local SillyTavern host source. No live user chats or provider accounts were mutated. Production latency and a full real-chat session were not measured.
- Switching to another chat now requires one additional read to verify the save because the host absorbs save failures. Same-chat message jumps skip that read.
- Old chat-cache records and embedding vectors without endpoint provenance must be rebuilt. Chat files and extension metadata remain intact.
- The host exposes no reliable file revision. Remote edits with unchanged list metadata become visible on explicit reopen or the next index build after the 60-second reuse window; there is no background polling.
- The separately documented search-coverage policy question was not included in the confirmed bug set and remains unchanged.
- These fixes were initially left uncommitted in the saved project. The later branch integration and current validation are recorded in `docs/outstanding-work-review-2026-10-15.md`.
