# Lightweight Semantic Coloring for Icicle Chart

Reference document for two approaches to semantic node coloring without an embedding API, and how they combine.

---

## Approach 1: Keyword Hashing → Base Hue

### Concept
Extract the most "distinctive" words from each message, hash them to a hue value (0-360°). Messages about similar topics share vocabulary → similar hashes → similar colors.

### Algorithm

```
1. Preprocess message text:
   - Lowercase, strip punctuation
   - Split into words
   - Remove stopwords (the, is, a, and, to, of, in, it, that, was, for, on, with, ...)
   - Optionally stem (walk/walking/walked → walk) — simple suffix stripping

2. Score remaining words by frequency across the corpus:
   - Compute document frequency (DF): how many messages contain this word
   - TF-IDF-like weight: words that appear in THIS message but NOT in most others are most distinctive
   - Simpler alternative: just pick the top 2-3 least-common words (rarest = most topical)

3. Build a "topic fingerprint":
   - Take top 3 keywords by score
   - Sort alphabetically (order-independent)
   - Concatenate: "battle knight sword"

4. Hash to hue:
   - Simple string hash (djb2, FNV-1a, or even just charCode sum) → integer
   - hue = hash % 360
   - This is deterministic: same keywords always → same color
```

### Characteristics
- **Speed**: O(n × m) where n = nodes, m = avg words per message. Very fast.
- **Stability**: Same text always gets same color. Doesn't depend on what other messages are loaded.
- **Granularity**: Coarse — two messages need to share exact keywords to get similar colors. "cooking pasta" and "making spaghetti" would get different hues despite being semantically close.
- **No dependencies**: Pure string operations + a hash function.

### Tuning Knobs
- **Number of keywords** (2-3): More keywords = more specific fingerprint = more color variety. Fewer = broader topic grouping.
- **Stopword list size**: Larger list = more topical words survive. Can be aggressive since we only need distinctive words.
- **Hash distribution**: If colors cluster, try a different hash function or add salt.

### Example Output
```
"Let's go to the beach and swim"     → keywords: [beach, swim]       → hue 142 (green)
"The ocean waves were beautiful"     → keywords: [ocean, waves]      → hue 198 (cyan) — close but not identical
"I need to fix the car engine"       → keywords: [car, engine, fix]  → hue 31 (orange) — clearly different topic
"Can you help me cook dinner?"       → keywords: [cook, dinner]      → hue 275 (purple)
```

---

## Approach 2: Similarity Gradient → Saturation/Lightness

### Concept
Measure how much a message's content **changes** relative to its parent message in the trie. Color intensity encodes "topic continuity" vs "topic shift." Smooth transitions = staying on topic. Sharp color changes = conversation turning points.

### Algorithm

```
1. For each node, get its word set (after stopword removal):
   current_words = Set(words(node.normalizedText))
   parent_words  = Set(words(parent.normalizedText))

2. Compute Jaccard similarity:
   intersection = current_words ∩ parent_words
   union        = current_words ∪ parent_words
   similarity   = |intersection| / |union|    // 0.0 = totally different, 1.0 = identical vocab

3. Map to visual property:
   Option A — Saturation:
     saturation = 30 + (1 - similarity) * 50    // 30% (on-topic) → 80% (topic shift)

   Option B — Lightness:
     lightness = 35 + similarity * 25            // 35% (divergent, darker) → 60% (continuous, lighter)

   Option C — Both:
     High similarity:  desaturated, lighter  → "calm" continuation
     Low similarity:   saturated, darker     → "intense" shift — draws the eye to topic boundaries
```

### Characteristics
- **Speed**: O(n × m) — same as keyword hashing. Both just iterate words.
- **Instability across loads**: Depends on parent node, so it's stable as long as the trie structure doesn't change.
- **What it shows**: NOT "what topic is this" but "did the topic change here." Best for visualizing conversation flow/drift.
- **Edge cases**:
  - Root node children have no meaningful parent → use default saturation/lightness
  - Very short messages (1-2 words) have noisy similarity → could use a minimum word count threshold or fall back to default

### Tuning Knobs
- **Word set vs word bag**: Set (unique words) is simpler. Bag (with counts) weights repeated terms higher — marginal benefit.
- **N-gram overlap**: Instead of single words, use bigrams ("go beach", "beach swim") for more context sensitivity. More expensive but better quality.
- **Smoothing**: Average similarity over the last 2-3 ancestors instead of just the immediate parent. Reduces noise, shows longer-range topic continuity.
- **Threshold**: Below a minimum similarity (e.g., 0.05), treat as "complete topic change" — avoids tiny differences between two very-different messages both looking max-divergent.

### Example Output
```
Depth 0: "Hi, how are you?"                    → (root child, default)
Depth 1: "I'm good! Want to go to the beach?"  → similarity to parent: 0.1 (low) → saturated/dark
Depth 2: "Yes! I love swimming at the beach"   → similarity to parent: 0.3 (medium) → moderate
Depth 3: "The waves are great for surfing too"  → similarity to parent: 0.2 (medium-low) → slightly saturated
Depth 4: "Speaking of sports, did you see the game?" → similarity to parent: 0.05 (very low) → very saturated/dark ← TOPIC BOUNDARY
Depth 5: "Yeah the game was incredible!"        → similarity to parent: 0.4 (high) → desaturated/light
```

---

## Combined Approach: Hue from Keywords, Intensity from Similarity

### How They Compose

```
For each node:
  hue        = keywordHash(node)                          // WHAT topic (approach 1)
  similarity = jaccardSimilarity(node, node.parent)       // HOW MUCH it changed (approach 2)

  saturation = 30 + (1 - similarity) * 50                 // 30-80%
  lightness  = 40 + similarity * 20                       // 40-60%

  color = hsl(hue, saturation%, lightness%)
```

### What This Looks Like

- **Staying on topic**: Consistent hue, light and desaturated → calm visual band
- **Gradual drift**: Hue slowly shifts, moderate saturation → gentle color gradient
- **Sharp topic change**: Abrupt hue shift AND high saturation/darkness → vivid color boundary (double signal)
- **Returning to earlier topic**: Hue snaps back to a previous color → visual "callback"

### Visual Interpretation Guide
```
Smooth blue band         → sustained conversation about one topic
Blue → vivid green       → abrupt topic shift (both hue change AND high saturation from low similarity)
Vivid green → soft green → conversation settling into new topic
Soft green → soft blue   → gradual drift back to original topic
```

---

## Integration Points in Current Codebase

### Where color is assigned
`src/icicle-view.js` lines ~639-659 — the `drawNode()` function determines fill color based on hover/active/divergence/role. Semantic coloring would be an additional (or alternative) color mode.

### Where to compute
- **Keyword hashing**: Compute during `buildIcicleData()` in `src/icicle-data.js` — each node already has `normalizedText`. Add a `topicHue` field to each node.
- **Similarity gradient**: Compute during `computeLayout()` pass (when parent relationships are already established). Add a `similarity` field to each node.

### Existing node fields to leverage
- `node.normalizedText` — the message text (already cleaned)
- `node.role` — could still influence coloring (user messages slightly different tone than assistant)
- `node.depth` — root children need special handling for similarity (no parent to compare to)
- `node.children.size` — divergence highlighting could coexist (e.g., gold border on branch points + semantic fill)

### Toggle UX
A simple toggle or dropdown in the icicle controls to switch between:
1. **Structural** (current default): active/divergence/role-based
2. **Semantic**: keyword hue + similarity gradient
3. **Hybrid**: semantic fill + structural borders (divergence gold stroke, active blue stroke)

---

## Stopword List (Minimal, English-focused)

For a roleplay/chat context, a smaller curated stopword list works better than a full NLP stopword list, since words like "feel" or "look" might be topically relevant in RP:

```javascript
const STOPWORDS = new Set([
  'i', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'them', 'their',
  'he', 'she', 'it', 'his', 'her', 'its',
  'a', 'an', 'the', 'this', 'that', 'these', 'those',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'can', 'may', 'might', 'shall', 'must',
  'and', 'but', 'or', 'nor', 'not', 'no', 'so', 'if', 'then',
  'of', 'in', 'on', 'at', 'to', 'for', 'with', 'from', 'by', 'as', 'into',
  'about', 'up', 'out', 'just', 'than', 'very', 'too', 'also',
  'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'some', 'any', 'such',
  'there', 'here', 'now', 'then', 'again', 'still',
  'like', 'well', 'back', 'even', 'only', 'over',
]);
```

---

## Cost / Complexity Summary

| Aspect | Keyword Hashing | Similarity Gradient | Combined |
|--------|----------------|-------------------|----------|
| Computation | ~1ms for 500 nodes | ~1ms for 500 nodes | ~2ms for 500 nodes |
| Memory | +1 field per node (hue) | +1 field per node (similarity) | +2 fields per node |
| Dependencies | None | None | None |
| Quality | Coarse topic grouping | Good flow visualization | Best of both |
| Stability | Fully deterministic | Depends on parent | Mostly stable |
| Code complexity | ~30 lines | ~20 lines | ~50 lines |
