# Memory-efficient archive access

Chat Manager keeps a compact catalog of conversations and loads full text or
embeddings when an operation needs them. A conversation remaining indexed no
longer means that all of its messages and swipe variants must remain resident.

## Default limits

| Resource | Default policy |
| --- | --- |
| Resident chat bodies | 96 MiB logical byte budget, least recently used eviction |
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

`src/chat-reader.js` separates three states:

- A catalog entry identifies a conversation.
- `isLoaded` means its content has been indexed successfully.
- `bodyResident` says whether its full message bodies are currently cached in RAM.

Evicted entries retain compact message descriptors: message indices, roles,
timestamps, branch links, content fingerprints, counts, and copied previews.
Descriptors preserve branch structure without retaining full message strings.
`readChatMessages()` and `iterateChatBodies()` supply complete text from resident
memory, IndexedDB, or the original server-side chat files. A cold read stays
ephemeral unless a caller explicitly requests residency.

The existing IndexedDB v2 store gains separate catalog records; there is no
destructive database migration. Writes for the same file coalesce, and one write
transaction runs at a time. Cache failures fall back to the original chat files.
Failed revalidation preserves previously known data but rejects operations that
would otherwise consume stale text. The caching code does not edit chat files or
delete swipes.

## When chats are re-read

Opening the panel reuses every chat whose cached record still matches the host's
chat list: formatted file size, message count, and last message date. Age alone
never expires a record. A chat is downloaded again only when its list metadata
differs, it has no trusted cached record, or the user chooses **Verify chats**.

An edit in the host deletes that chat's cached record, even if the panel has never
opened, so the next build re-reads it. The chat open in the host reads from the
host's live array, which is newer than the file while a debounced save is pending.
Catalogs written before edit tracking existed lack `localEditsTracked`, so they are
re-read once after updating.

Automatic embedding restoration at page load and on character switches lists chats
and restores catalogs without downloading any. Unknown chats stay queued until the
panel or another feature requests hydration.

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
duplicate-thread links. Navigating backward rescans saved data. This trades
additional IndexedDB/server reads for bounded result retention. A missing
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

The suite covers body and vector eviction, persistence failures, legacy cache
compatibility, cold reads, complete archive search, exact deduplication, swipe
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
