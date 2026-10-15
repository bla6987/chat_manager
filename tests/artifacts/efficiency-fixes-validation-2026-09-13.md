# Efficiency fixes validation

Implemented by three Sol agents, reviewed in the parent task, and tested on September 13, 2026. This follows the audit of baseline commit d8b1ad75f441e966083d9a3b96eae4e3a2f82bea.

## Changes

- Unchanged active-chat events preserve entry identity and skip version changes, full cache writes, and hydration notifications. Full message comparisons still run to detect earlier edits and swipe changes safely.
- Warm entries normalize once; branch comparisons reuse unchanged message-array pairs.
- Cold metadata publishes before cached bodies are loaded. Cache reads use batches of at most 50 records; hydration writes share transactions.
- Build ownership and hydration session guards prevent delayed results from overwriting newer active-chat or character state.
- Unchanged clustering reuses labels, including replacement entries retaining the same vectors. Changed vectors, membership, and fixed-k mode invalidate results.
- Alternate-swipe processing consumes only the next batch; identical in-flight query embeddings share a request with failure and invalidation handling.
- Semantic matches aggregate before sorting, preserving score ties, associated filenames, and the existing 100-result cap.
- Semantic maps keep one build in flight and one pending latest refresh. Message references and plotted points publish together; failed replacements retain the completed mapping.
- Icicle prefix nodes share identical membership arrays and aggregate/PCA results. Async mount/update work cannot revive an unmounted view.
- Graph pin norms are cached, neighbor selection is bounded, heatmap hit testing uses grid coordinates, and the unused worker distance buffer is removed.

## Verification

- `node --test tests/*.test.mjs`: 28 passed, zero failures.
- Syntax checks passed for every changed production JavaScript file; `git diff --check` passed.
- Built-in browser, existing UI fixture: 13 checks passed.
- Built-in browser, new view fixture: 17 checks passed. Includes deferred-worker coalescing, atomic message/point mapping, failure recovery, unmount cancellation, and a real Worker projection.
- All production source files served by the local SillyTavern test instance matched the working tree (`diff -qr src <local-server-extension>/src` returned no differences).

## Controlled operation counts

Actual reader functions, synthetic data:

- Two unchanged updates of a 10,000-message chat: zero cache writes and zero message records written (audit baseline: two writes / 20,000 records).
- Unchanged warm index: zero message filename checks (baseline: 10,000).
- 100 sibling chats with 2,000 messages: initial branch detection reads 400,000 text properties; unchanged repeat and subsequent sibling-context query each read zero additional text properties (baseline: 400,000 each).
- Actual clustering function with 320 synthetic 192-dimensional vectors: initial call 49.85 ms; unchanged cached repeat 2.62 ms. Single controlled Node run; not a browser latency guarantee.

## Local native generation

Full SillyTavern 1.18.0 at http://127.0.0.1:8123, isolated synthetic user data, local mock provider at port 8124, sample conversation `CM Memory Test / cm-active`. Armed the loaded active chat plus 5,000 inactive synthetic messages and scheduled the real automatic embedding bootstrap during native Send.

Visible browser result:

- Reply completed normally via the local streaming provider.
- Zero embedding-cache reads during generation.
- 20 reads total after generation, 17 active vectors retained, zero inactive vectors retained.
- Generation ended at 40921.3 ms; first cache read at 41840.1 ms (about 919 ms afterward).
- Sampled JS heap start/current/peak: 32.9 / 33.6 / 35.0 MiB.

These are bounded synthetic checks and one local native-generation test. They do not establish a universal memory ceiling for explicit full-corpus embedding requests or every user archive.
