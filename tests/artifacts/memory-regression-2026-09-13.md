# Chat Manager browser memory regression test — 2026-09-13

Tested in Codex's built-in browser against a separate SillyTavern 1.18.0 instance at http://127.0.0.1:8123/.
The sample character/thread is **CM Memory Test / cm-active**. Generation used a local mock OpenAI-compatible stream at port 8124 (about 12 seconds per response); embeddings used the same local mock provider. No existing user chats or paid API were used.

## Method

The baseline is the exact working tree at the start of this task, including earlier uncommitted performance changes, frozen at `/private/tmp/chat-manager-memory-test/baseline`. Sol implemented the fixes in the current repository. The served extension was updated and reloaded for patched tests; final source hashes are in `memory-source-sha256.txt`.

A test-only page panel seeded real IndexedDB with 5,000 compatible embedding records, each containing 1,536 numeric dimensions. It placed 20 synthetic loaded chats with 250 messages each into the real Chat Manager index. The probe then counted `IDBObjectStore.get` calls for `ChatManager_Embeddings`, tracked actual native generation/message events, and counted retained vectors in the actual extension maps. Dry-run prompt-building events were excluded from generation timing.

Native Send was clicked in the real sample chat. For the controlled bulk-load case, the probe explicitly called the production `scheduleEmbeddingBootstrap` function while generation was active. This reproduces bulk restore overlapping generation; it does **not** prove the user's original profile was triggered by the message-update fallback.

## Results

| Scenario | Cache reads during generation | Total cache reads | Retained vectors | Browser-reported heap |
| --- | ---: | ---: | ---: | --- |
| Baseline: Send alone, active entry absent, no pending bootstrap | 0 | 0 | 0 | 33.2 MiB start; 34.2 MiB peak |
| Baseline: automatic bootstrap scheduled during generation | 5,000 | 5,000 | 5,000 inactive | 33.2 MiB start; 155.7 MiB peak; 147.8 MiB end |
| Patched: same automatic bootstrap case | 0 | 0 | 0 | 31.6 MiB start; 33.8 MiB peak; 31.4 MiB end |
| Final source: loaded active chat plus automatic bootstrap during generation | 0 | 18, all after generation | 15 active; 0 inactive | 34.0 MiB start; 39.1 MiB peak; 34.2 MiB end |
| Patched: automatic restore of a 5,000-message active chat plus 5,000 inactive messages | N/A | 256 | 256 active; 0 inactive | Approximately 3 MiB numeric payload at 8 bytes per number |
| Patched: unchanged repeat of long-chat automatic restore | N/A | 0 additional | Still 256 active; 0 inactive | No older-history backfill |
| Patched: explicit cache-only restore with one selected 250-message chat | N/A | 250 | 250 in selected chat | Full selected scope restored |
| Patched: embeddings disabled, automatic and explicit restore attempted | N/A | 0 | 0 | No embedding work |

For the baseline bulk case, all 5,000 reads completed between 53,805.8 and 55,958.9 milliseconds after page time origin; generation ran from 52,836.5 to 65,149.2 milliseconds. Peak read concurrency was only 50, demonstrating that concurrency limiting did not bound retention.

For the final-source loaded-active case, generation ended at 106,556.2 milliseconds. The first embedding cache read began at 107,472.3 milliseconds, about 916 milliseconds later. The 18 reads include cache misses and cache metadata, so they do not equal the 15 retained message vectors.

## Implementation

- Failed active-chat updates no longer request an all-index embedding bootstrap.
- Automatic message restore targets the active chat and selects its newest 256 messages **before** finding missing vectors. Unchanged repeats do not progressively load older messages.
- Automatic work excludes alternate swipes and defers pending/queued work while real generation is active. Dry-run generation events are ignored; in-flight cache chunks can finish before deferral.
- Cache hydration applies results in groups of 50 and discards full cache-record wrappers after validation/projection.
- Explicit user-requested embedding retains full scope and truthful completion status. It can still use substantial memory for a large requested corpus; the patch does not impose a universal memory ceiling or evict manually loaded vectors.
- Fixed settled embedding-queue cleanup and avoided argument-spreading huge cache-miss arrays.

## Validation

- `node --test tests/*.test.mjs`: 10 passed, including 5,000-message window/repeat behavior, index retention, edit/swipe invalidation, and generation lifecycle.
- `tests/browser-performance.html` in the built-in browser: all 13 checks passed, covering pagination, card preservation, filters, and search.
- Syntax checks for changed production modules and `git diff --check` passed.
- Final sample response completed and persisted; browser logs contained normal stream-stat warnings and no reported application errors.

## Limits and correction to the initial diagnosis

The cache-load/memory mechanism is reproduced at 5,000 vectors. This was not a 489,000-record stress test or a recreation of the original Firefox recording. `performance.memory` is a browser-reported JavaScript heap metric; it is not whole-process resident memory, was not force-GC-normalized, and includes probe overhead. The strongest evidence is the actual IndexedDB count, timing, and retained-vector count.

An absent active entry does **not** itself take the message-update fallback: the active-filename resolver returns null when the entry is absent. The clean native-send control confirmed zero reads. Startup, chat-change, panel refresh, or an actual update exception can schedule bootstrap in the baseline. The original profile's exact trigger remains unverified.

The disposable server, mock provider, synthetic data, baseline, and browser probe remain under `/private/tmp/chat-manager-memory-test`. The server is running on loopback port 8123 and mock provider on 8124. The probe at `server/public/cm-probe.js` is test-only and must not be installed into a production page (its Seed control clears this isolated origin's embedding cache). Source changes are local and uncommitted; the user's original SillyTavern runtime and persistent cache were not changed.
