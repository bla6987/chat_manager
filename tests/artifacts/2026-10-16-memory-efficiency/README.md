# Six performance and memory fixes — 2026-10-16

Four GPT-6.1 Sol agents implemented the six requested fixes in the saved project. The parent reviewed the changes, coordinated independent reviews, corrected integration issues, and verified the final code. Existing unrelated uncommitted work remains intact. No commit or push was made.

## Changes

1. `chat-reader.js` releases its flattened search cache immediately on index invalidation. Each restored cache batch also invalidates search so partially restored messages are visible immediately.
2. `semantic-engine.js` computes asynchronous PCA using full-data matrix-free covariance products. It removes the centered input copy and dense dimension-squared covariance matrix, retaining O(dimensions) working buffers plus required output. Time checks cover setup, seeding, iteration and projection. The synchronous reference implementation remains unchanged.
3. `cache-store.js` adds small validity records in IndexedDB schema v3. Restoration checks metadata before fetching bodies, pairs metadata/body reads and writes in transactions, and consumes at most 50 bodies per batch. Existing v2 bodies are preserved; records without the new metadata are rehydrated. Timestamp, signature, 60-second freshness and ownership checks remain enforced.
4. `icicle-view.js` draws candidates from visible depth columns, retaining original paint order and active-path appearance. Weak membership caches clear on rebuild and teardown.
5. `icicle-data.js` constructs memberships from terminal files and directly shares unary-prefix arrays, avoiding temporary file lists at every shared depth. Input order, terminal prefixes, cluster ties, layout and Explore behavior are preserved.
6. `semantic-search.js` scores in time-bounded chunks, calculates the query norm once, and selects the exact top 100 without fully sorting finite results. A second pass reconstructs per-file ranks only for those results. Request, index, settings, query-epoch and message-embedding-version checks reject stale work. Learned dimensions do not cancel the first query. Existing deduplication, alternate text, count and tie ordering are preserved.

## Validation

- **191/191 Node tests passed**, zero failures or skips: `node --test tests/*.test.mjs`. Full output: `automated-tests.txt`.
- **65/65 browser assertions passed** in Codex's built-in browser across five fixtures. Results: `browser-checks.json`. Coverage includes real IndexedDB v2-to-v3 migration, stale-body avoidance, bounded restoration, revision mismatches, PCA timer responsiveness, first-query dimension discovery, semantic alternate results, canvas/Worker lifecycle, timeline pixel equality and pagination.
- New regressions compare PCA against its synchronous reference, compare timeline memberships and canvas command traces against prior algorithms, and compare semantic ranking against legacy results over 30 randomized fixtures.
- Independent review found and fixed batch-level search invalidation and background embedding changes between search passes. Parent review also fixed query self-cancellation after learning dimensions and excessive search timer yields.
- Syntax checks and `git diff --check` passed. The existing semantic browser fixture's canvas-width assertion now accounts for device pixel ratio; no production canvas-sizing change was required.

## Bounded synthetic measurements

These are local Node measurements, not live SillyTavern latency or process peak-memory measurements.

| Workload | Before | After |
| --- | --- | --- |
| PCA: 128 vectors × 3,072 dimensions, initial blocking, three trials | 591.3–655.9 ms | 4.0–8.1 ms |
| Same PCA, total time | 694.1–765.1 ms | 58.4–79.2 ms |
| Dense covariance numeric storage for that PCA | 72 MiB, plus array overhead | Matrix eliminated |
| Timeline: 500 branches × 1,000 common turns, allocated membership references including root | 501,000 | 1,500 |
| Timeline render fixture: 12,000 nodes, five visible depth columns | Full-node traversal | 30 candidates |
| Search: 20,000 unique groups × 192 dimensions, three trials | 12.2–14.1 ms | 12.9–22.3 ms, 1–2 timer yields |
| Same search, per-file ranking maps | 20,000 | 100 |

The PCA maximum projected-coordinate difference was 3.56e-14 on the benchmark fixture. Search results matched serialized legacy output exactly. Search improves temporary allocation and responsiveness; the measured small workload does not establish a throughput improvement. Timing records are in `pca-benchmark.jsonl` and `search-benchmark.jsonl`.

## Limits

The current character's entire hydrated archive is still retained; these fixes do not introduce a strict archive-memory cap. Semantic search retains one compact winner descriptor per unique deduplication group. Malformed nonfinite scores retain the legacy full-sort fallback for compatibility. Individual candidate text/vector operations are not interrupted mid-operation. Floating-point PCA accumulation order differs, with numerical equivalence covered by tolerance tests. No live provider requests or user conversation writes were made during validation.
