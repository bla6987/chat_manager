# Memory-efficient archive access

Chat Manager keeps one small summary per conversation and loads full text or
embeddings when an operation needs them. A conversation remaining indexed no
longer means that any of its messages or swipe variants must remain resident.

## Default limits

| Resource | Default policy |
| --- | --- |
| Resident chat bodies | 96 MiB logical byte budget, least recently used eviction; background indexing and archive scans hold none |
| Stored chat bodies | 1 GiB logical byte budget across all characters, filled only by reading chat text. Logical bytes overstate disk use: a 220 MB archive measured 758 MiB logical and about 70 MB in Chromium's compressed IndexedDB |
| Active chat | Pinned to preserve unsaved live edits; can exceed the body budget |
| Resident chat and message vectors | Combined 64 MiB of Float32 payload |
| Background body hydration | Two conversations at a time |
| Archive text/vector batches | At most 50 items in production consumers; 262,144 text characters per batch, except an individual longer message |
| Automatic message-vector restore | The newest 256 active-chat messages; alternate swipes stay outside automatic restore |
| Map/gradient PCA and archive clustering sample | At most 1,024 vectors and 8 MiB of Float32 sample payload |
| Keyword result page | 50 result groups; previous pages retain only identifiers and hashes |
| Semantic search results | Top 100 result groups; exact cosine scoring across the available saved vectors |
| Query-vector cache | At most 32 queries, cleared when the panel closes |

These are cache and working-set policies, **not a cap on Firefox's process RAM**.
The body estimate is conservative logical accounting; the vector limit counts
payload bytes rather than all JavaScript object overhead. The compact catalog,
rendered output, active chat, one or more in-flight body reads, provider responses,
browser structures, SillyTavern itself, and other extensions also use memory. An
individual large chat or message can exceed a batch's normal working size.

## Text storage and complete archive access

`src/chat-reader.js` separates these states:

- A catalog entry identifies a conversation. The host's list supplies its size,
  dates, last message and `main_chat`, with no download.
- `isLoaded` means its content has been indexed, so its summary is present.
- `bodyResident` says whether its full message bodies are currently cached in RAM.

A summary holds what the panel and the stats need: counts, the activity histogram,
branch links, the opening messages' identity, a content hash, which swipe variants
hold text, and the bounded text used for chat embeddings. It holds no per-message
objects. `readChatDescriptors()` supplies per-message records one chat at a time to
the few views that need them, and `readChatMessages()` and `iterateChatBodies()`
supply complete text from resident memory, IndexedDB, or the original server-side
chat files. A cold read stays ephemeral unless a caller explicitly requests
residency, and an archive scan holds one body at a time.

The IndexedDB database has three stores of derived data, so dropping any of them
loses nothing:

| Store | Holds | Read |
| --- | --- | --- |
| `chatSummaries` | One small record per chat | All of a character's at once, in one transaction |
| `chatDescriptors` | Compact per-message rows | One chat at a time |
| `chatBodies` | Complete text, under the byte budget | One chat at a time |

Upgrading from the earlier stores deletes them. Nothing is re-downloaded until it
is needed. Writes for the same file coalesce, and one write transaction runs at a
time. Removals, summaries and bodies commit separately, because a removal is the
only lasting record of a local edit and a body is the write most likely to fail. A single chat's read may displace the least recently used stored bodies. An
archive scan only fills free space, because evicting during a scan larger than the
budget would rewrite everything and leave nothing useful. Cache failures fall back
to the original chat files. Failed revalidation preserves previously known data but
rejects operations that would otherwise consume stale text. The caching code does
not edit chat files or delete swipes.

## When chats are read

Opening the panel reads no chats beyond the cards it renders, one page at a time.
Everything else is read when something needs it:

| Feature | Reads |
| --- | --- |
| Thread cards | Rendered cards only |
| Branch badges | Provenance relatives of the active chat among the rendered cards |
| Keyword search | Chats the server names, plus the open chat |
| Semantic search and map, graph | Every chat's text, one at a time, each time they run |
| Stats, timeline, sorting by creation date or cluster, filtering by creation date | The whole archive, once, with progress in the status line |
| **Verify chats** | The whole archive, every time |

Leaving a view that requested the whole archive, or closing the panel, stops that
work. Whatever was finished stays indexed.

Keyword search first asks `/api/chats/search` which chats could match. The server
requires every word of the query to appear somewhere in a chat, which any true
match satisfies, so narrowing never loses a result. The open chat is always read
too, because it may hold text no file has yet. The server cannot cancel a scan, so
one runs at a time and a longer query reuses the scan of any part of it until a
chat changes. If the request fails, the search reads every chat instead.

Background indexing runs in a worker when the browser allows it: only response text
crosses to it and only a summary and encoded rows come back, so a parsed body never
exists on the page. If the worker cannot start or dies, the same code runs on the
page. A read somebody is waiting for stays on the page, because it keeps the body.
The worker exits after 30 idle seconds.

The chart views load on first use through `src/lazy-views.js`.

## When chats are re-read

An indexed chat stays valid while its summary matches the host's chat list:
formatted file size, message count, and last message date. Age alone never expires
a record. A chat needs reading again only when its list metadata differs, it has no
cached record, or the user chooses **Verify chats**.

The server answers a request for a missing file with an empty chat, and the host
selects a new character before announcing it. So nothing is read or saved while the
host is on another character, and an empty answer for a chat the list counted is not
saved. Otherwise the chat would show as empty until it next changed.

An edit in the host deletes that chat's cached records, even if the panel has never
opened, so the next use re-reads it. The chat open in the host reads from the host's
live array, which is newer than the file while a debounced save is pending. Its body
is not stored, because the host holds it and its file follows the save.

Automatic embedding restoration at page load and on character switches lists chats
and restores summaries without downloading any. It restores vectors only for chats
already indexed.

The host's list has no file revision, and its file size is rounded. An edit that
leaves all three list values unchanged stays unseen until **Verify chats** runs or
the chat changes again, if it came from another device or browser, or from an
extension that saves a chat without emitting a message event.

Closing the panel releases inactive bodies and rendered view state. Stale search
references are dropped on invalidation rather than waiting for the next search.
Late requests cannot recreate a closed panel or refill its query cache.

## Search, embeddings, and visualizations

Archive search reads complete bodies in bounded batches. Keyword search retains
the existing active-message substring behavior. Semantic search optionally
includes alternate swipes according to the existing settings. Result groups
preserve filename, message, and swipe identifiers. Fingerprints narrow duplicate
candidates; exact text comparison verifies search deduplication, including long
messages and fingerprint collisions. Only copied excerpts remain in results.

Each keyword page uses a bounded selection pass and a second pass to recover
duplicate-thread links, both over the chats the server named. A query whose words
appear in most chats therefore still reads most chats. Navigating backward rescans
saved data. This trades additional IndexedDB/server reads for bounded result
retention. A missing
semantic corpus falls back to keyword search in automatic mode. Query vectors
are validated against the current provider/model/endpoint operation.

Embedding generation persists and consumes one bounded batch before requesting
the next. The background alternate-swipe queue holds file identifiers rather
than message text. Explicit generation includes cold conversations and awaits
their authoritative bodies. Automatic work remains deferred during host
generation. Existing numeric-array cache entries remain readable and are
converted to Float32; partial typed-array views are copied so a small vector does
not retain a much larger backing buffer.

Search, map queries, graph neighbors, gradient colors, drift summaries, and
cluster assignment read persisted vectors without promoting the whole corpus
back into the resident cache. The semantic map keeps projected coordinates and
compact identifiers. The graph keeps pins and bounded top neighbors. Thread
cards calculate drift serially for rendered cards and retain scalar summaries.

PCA uses matrix-free covariance multiplication, avoiding a dense dimension-by-
dimension matrix and a centered copy of every vector. Structural and cluster
icicle color modes skip PCA entirely. Large-corpus visualization bases and
archive cluster fitting use the bounded deterministic sample; every available
archive item is still projected or assigned in a streaming pass. For corpora
larger than that sample, layouts and cluster boundaries can differ from a fit on
every vector. Semantic similarity scoring still examines every available vector.

Unmounting views clears workers, pending requests, animation frames, timers,
listeners, CPU render arrays, and WebGL resources. Operation, character, content,
and cancellation guards prevent obsolete results from republishing data.

## AI actions and branch context

Title generation captures the last 15 messages; summary generation captures the
last 30, matching their existing prompt windows. The branch marker is adjusted
when the older prefix is dropped. Title-only actions do not fetch sibling
context. Summary and injected sibling context read up to three siblings
sequentially and retain bounded text per message.

Prompt preparation awaits cold sibling reads. If a newer edit supersedes a read,
preparation retries only while the same chat and character remain selected and
branch context remains enabled. Changing chats or disabling the feature prevents
late prompt writes.

## Diagnostics and validation

The reader exports `getBodyCacheStats()` and `getVectorCacheStats()` for logical
residency counters, plus `setBodyCacheBudget(bytes)` and
`setVectorCacheBudget(bytes)` for controlled testing. `trimBodyCache()` and
`clearResidentVectors()` release cached data without deleting authoritative chat
files or persistent embeddings.

Run the regression suite with:

```sh
node --test tests/*.test.mjs
```

The suite covers body and vector eviction, persistence failures, the stored-body
budget, cold reads, on-demand indexing, keyword narrowing, the index worker and its
fallback, lazy view loading, complete archive search, exact deduplication, swipe
identity, branch context, stale requests, provider changes, bounded batches,
matrix-free PCA, worker transfers, and view teardown. Stress cases include full
123-message embedding generation under a 32-byte resident vector budget,
32,768-dimensional PCA input, thousands of projected archived messages, and
archive clustering with zero resident vector bytes.

The automated tests verify implementation bounds and functional correctness.
They do not measure Firefox's actual heap or process RAM. For a real comparison,
use the same character, chat, swipe data, enabled extensions, and sequence of
panel/view operations before and after updating. Compare an idle baseline,
opened views, and the closed-panel state; distinguish the SillyTavern tab's
memory from the entire Firefox process group.
