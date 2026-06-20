# English stemming for 校閲(lint) + FTS(sparse search) — Design

- Date: 2026-06-20
- Status: Approved design (pre-implementation)
- Scope: Add English word-stemming to (1) the lint engine and (2) the FTS5 sparse-search arm. Dense embeddings are intentionally left untouched.

## 1. Summary & goals

English text currently receives **no morphological normalization**. Lindera/UniDic is Japanese-only; English flows through whitespace tokenization + heuristic sentence ranges. As a result:

- **Lint** treats `run` / `runs` / `running` as distinct words (e.g. `en/word-repetition` keys on `to_ascii_lowercase()`), and `en/filter-words` hard-codes 66 inflected surface forms.
- **FTS sparse search** uses a `trigram` tokenizer shared across all languages, which matches prefix substrings but produces morphologically-blind false positives (`run` matches `rune`, `runner`, `turner`).

Goal: introduce **Snowball stemming** for English so inflectional variants normalize to a common root, improving lint word-equality and FTS sparse-search **precision** (and, secondarily, inflectional recall).

## 2. Locked decisions (settled with the user)

1. **Dense embeddings (bge-small-en-v1.5) stay CLEAN — NO stemming.** bge's BERT/WordPiece tokenizer is trained on unstemmed text and already encodes morphological similarity semantically; stemming would feed out-of-distribution subwords (`studies`→`studi`→garbage WordPieces) and degrade embedding quality. Stemming is a *lexical* normalization that belongs only on lexical paths.
2. **Algorithm: Snowball (Porter2)** via the `rust-stemmers` crate for the lint layer.
3. **FTS architecture: 案A** — separate English FTS tables using FTS5's built-in `porter unicode61` tokenizer (not stemming into the existing trigram tables). This also replaces trigram's substring matching with word-boundary matching for English.
4. **Routing is hardcoded `language LIKE 'en%'`** (no general language-profile abstraction yet — YAGNI; build it only when a 3rd language arrives).

## 3. Background (verified current state)

- Lint crate: `src-tauri/crates/grimodex-lint`. English rules under `src/rules/en/` (14 rules). `LintContext.block_tokens` is populated only when a rule sets `requires_morphology()=true`, which triggers lindera (Japanese). **English stemming must NOT use this path** — English rules extract words via regex; stemming is a pure helper applied to those words.
- FTS: 5 external-content (`content=<base>`, `content_rowid=rowid`) FTS5 tables, all `tokenize='trigram'`, populated 100% by SQL triggers (`*_ai`/`*_ad`/`*_au`):
  - `codex_fts` ← `codex_entries` (has `project_id`)
  - `snippets_fts` ← `snippets` (has `project_id`)
  - `tree_nodes_fts` ← `tree_nodes` (has `project_id`)
  - `post_effect_annotations_fts` ← `post_effect_annotations` (has `project_id`)
  - `chat_messages_fts` ← `chat_messages` (**no** `project_id`; resolve via `chat_sessions.project_id`)
- Query path: `src-tauri/src/database/fts.rs::search_fts()` is project-scoped (`project_id` param) but **language-neutral** today. Sanitizer `to_fts_match()` (Rust) / `toFtsMatchQuery()` (`src/lib/fts.ts`) wraps tokens in double quotes and drops `<3`-codepoint tokens, falling back to `LIKE`.
- Search is **hybrid**: dense (bge/ruri) + sparse (FTS5 BM25) fused via RRF (`src/features/chat/semanticRecall.ts`, `chatRecall.ts`). Stemming affects **only the sparse arm**.
- Language source of truth: `projects.language` (`TEXT NOT NULL DEFAULT 'ja'`). No content auto-detection.

## 4. Verified facts (empirically confirmed, debunking two review objections)

A multi-lens advisor review flagged two "critical blockers"; both were **disproven** by direct SQLite (FTS5 3.40.1) testing:

1. **`tokenize='porter unicode61'` is valid.** `porter` is a *wrapper* tokenizer that takes the underlying tokenizer as arguments. `CREATE VIRTUAL TABLE ... USING fts5(content, tokenize='porter unicode61')` succeeds.
2. **Double-quoting does NOT disable stemming.** With `porter unicode61`, `MATCH '"studies"'` matches a row containing `studying` (both stem to `studi`). The tokenizer (including the porter stemmer) is applied inside double quotes. Corroborating proof: the *existing* trigram search wraps every token in quotes and works — which is only possible if FTS5 tokenizes quoted strings.

Consequence: the existing sanitizer's quoting is fine; the porter `_en` tables will stem on both index and query sides automatically. **No sanitizer change is required for stemming to work.**

## 5. Design

### 5.1 Language routing (hardcoded)

A single predicate, used identically at write-time (triggers) and query-time (`search_fts`):

> English ⇔ `projects.language LIKE 'en%'`. Everything else (`ja`, `de`, ``, NULL, unknown) → default/trigram path.

This matches the existing `spec_for_language()` convention (`en*` → English, else Japanese) and keeps write/query routing in agreement.

### 5.2 Lint stemming (Snowball / `rust-stemmers`)

- Add `rust-stemmers` to `grimodex-lint/Cargo.toml`.
- New pure helper `stem_en(word: &str) -> String` (e.g. `src/stem.rs`) wrapping `Stemmer::create(Language::English)`. **Does not** set `requires_morphology()`; **does not** touch lindera.
- Retrofits:
  - **`rules/en/word_repetition.rs` (PRIMARY):** dedup key `to_ascii_lowercase()` → `stem_en(&lower)`. Unifies `run`/`runs`/`running`.
  - **`rules/en/filter_words.rs` (SECONDARY):** replace the 66 inflected-form list with ~14 roots; match `stem_en(candidate)` against the root set.
  - **`rules/en/dialogue_punctuation.rs` (TERTIARY, optional):** stem the captured leading word before the said-verb check.
- Irregulars (`ran`→`run`) are NOT normalized by Snowball; accepted (lemmatization was rejected for binary-size/complexity).
- Lint value is **independent of search**: it improves regardless of any RRF/dense considerations.

### 5.3 FTS English tables (`porter unicode61`)

- For each of the 5 base tables, add an `_en` FTS5 table with `tokenize='porter unicode61'`, same column list and external-content config as its trigram sibling:
  `codex_fts_en`, `snippets_fts_en`, `tree_nodes_fts_en`, `post_effect_annotations_fts_en`, `chat_messages_fts_en`.
- **Write routing (triggers):** each base table gets language-guarded `*_ai`/`*_ad`/`*_au` triggers. English rows → `_en` table, others → existing trigram table. Use `WHEN` guards:
  - Direct `project_id` (codex/snippets/tree_nodes/post_effect_annotations):
    `WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'`
  - `chat_messages` (indirect):
    `WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'`
  - These are PK lookups (cheap), but see §7 perf note.
  - **Idempotency:** `DROP TRIGGER IF EXISTS` before each `CREATE TRIGGER` so re-running migrations with changed logic does not leave stale unguarded triggers.
- **Query routing:** `search_fts()` reads the project language once up front; when English, it MATCHes the `_en` tables. The sanitizer (`to_fts_match` / `toFtsMatchQuery`) is **unchanged** (quoting is compatible with stemming per §4).
- **Effect framing:** vs trigram, the primary win is **precision** (word-boundary + stem removes `run`→`rune`/`runner` false positives) plus inflectional recall (`studies`↔`study`). Net search impact must be measured (§8) because stemming only moves the sparse arm of the RRF fusion.

### 5.4 Rebuild, backfill, and language-change (shared code path)

External-content `('rebuild')` reads the whole base table and ignores trigger `WHEN` guards, so it would index every language into one `_en`/trigram table. It is therefore **unusable after the split**. Replace it with language-filtered repopulation.

- New Rust function `repopulate_fts_for_project(conn, project_id)`:
  1. Look up the project language.
  2. For each of the 5 content types: delete this project's rows from **both** the trigram and `_en` FTS tables, then INSERT this project's rows into the **correct** table per language.
- This single function serves three needs:
  - **Backfill** existing English projects when the migration first runs (call per English project).
  - **Language change**: call when `projects.language` changes (wired from the project-update path — see below).
  - Manual repair / consistency rebuild.
- Rewrite `fts_rebuild()` / `fts_optimize()` to be language-aware: iterate projects and route each project's content to the correct table (or call `repopulate_fts_for_project` per project). `optimize` is still issued per FTS table (both trigram and `_en`).
- **Language-change wiring:** `updateProject()` (`src/features/project/api.ts`) currently has no FTS hook (verified). When the `language` field changes, invoke a Tauri command that calls `repopulate_fts_for_project`. Without this, switching a project's language strands its index in the wrong table and silently breaks its search — this is the single most important correctness fix from the review.

## 6. Edge cases & decisions

- **Unsupported language values** (`'de'`, `'EN'`, ``, NULL): fall to the default/trigram path (same as today's `spec_for_language`). Routing predicate `LIKE 'en%'` is case-sensitive; DB stores lowercase `'en'` by default. A `CHECK(language IN ('ja','en'))` constraint is **out of scope** (too invasive for existing data); document the open language set instead.
- **Two stemmers** (lint = Snowball/Porter2, FTS = FTS5 classic Porter): the two subsystems share no state; each is internally symmetric (query and document use the same stemmer within the subsystem). Functionally harmless; documented in code comments. (Unifying would require a custom FTS5 tokenizer in Rust — rejected as not worth the fragility.)
- **Proper nouns** get stemmed in FTS (`Running`→`run`); acceptable for prose search (unicode61 is case-insensitive anyway).
- **Short words (`<3` codepoints):** the sanitizer drops them before MATCH, so unicode61's ability to index `go`/`AI` is not realized at query time. This is **orthogonal to stemming** and left as-is; an optional future enhancement is an `_en`-only query path that permits 2-char tokens.
- **Stopwords:** FTS indexes everything (no stopword filtering, unchanged). Lint keeps its own `STOP_WORDS` set for `word-repetition`.

## 7. Performance

- Each insert/update on the 4 direct + 1 indirect base table now evaluates a `projects`/`chat_sessions` subquery in the trigger `WHEN` clause. These are primary-key lookups (cheap), but this codebase has known DB-lock sensitivity (ONNX mutex / `db_execute` timeouts). **Add a write-latency check** to confirm no regression; mitigation if needed: cache language on the child table or a small lookup table.

## 8. Testing & eval gate

- **Lint unit tests:** `word_repetition` unifies `run`/`running`; `filter_words` matches via root + stem.
- **FTS integration tests:** English project — `studies` indexed → `study` query hits; verify content lands in exactly one table (not both, not neither) across insert/update/delete and a language switch (`en→ja→en`). Japanese unaffected (trigram) regression.
- **Eval gate (validates the search half is worth it):** measure English sparse-arm precision/recall (trigram vs `porter unicode61`) on a small held-out query set drawn from English sample content, and the hybrid end-to-end (RRF) before/after. Record a baseline so future changes regress-test. Fits this repo's existing eval-harness culture.
- **Cross-project isolation test:** a DB with mixed-language projects returns correctly isolated results.
- Respect existing guards: `noControlBytes`, branch-first (no master direct commit), no `.github` edits.

## 9. Blast radius / files touched

- `src-tauri/crates/grimodex-lint/Cargo.toml` — add `rust-stemmers`.
- `src-tauri/crates/grimodex-lint/src/stem.rs` (new) — `stem_en`.
- `src-tauri/crates/grimodex-lint/src/rules/en/{word_repetition,filter_words,dialogue_punctuation}.rs` — retrofits.
- `src-tauri/src/database/migrate.rs` — 5 `_en` tables + language-guarded triggers (DROP-before-CREATE).
- `src-tauri/src/database/fts.rs` — `search_fts` language routing; `fts_rebuild`/`fts_optimize` language-aware; `repopulate_fts_for_project`.
- `src-tauri/src/commands/*` — command to trigger repopulate (backfill + language-change).
- `src/features/project/api.ts` — call repopulate when `language` changes.
- `src/lib/fts.ts` — **unchanged** (quoting compatible with stemming).

## 10. Risks & open points

- Search end-to-end gain is **unproven until the eval gate runs** (dense arm may dominate). Lint gain is independent and clear. If eval shows negligible search gain, the FTS half can be reconsidered while keeping lint.
- DB size: English projects effectively occupy one FTS table (the trigram sibling stays empty for them); negligible.
- Migration backfill cost scales with existing English-project content volume (one-time).

## 11. Out of scope / future

- Lemmatization (irregulars), query expansion, relaxing the `<3`-codepoint short-word filter, a general per-language profile abstraction, CJK languages (`zh`/`ko` would reuse the trigram table + need their own chunker/model), `CHECK` constraint on `projects.language`.
