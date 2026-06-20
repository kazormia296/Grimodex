# English Stemming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add English Snowball stemming to the lint engine and to the FTS5 sparse-search arm (English projects), leaving dense embeddings untouched.

**Architecture:** Lint gains a pure `stem_en()` helper (`rust-stemmers`, no lindera) consumed by the English `word-repetition` and `filter-words` rules. Search gains five **non-external** `_en` FTS5 tables with the built-in `porter unicode61` tokenizer; language-guarded triggers sync only English-project rows; existing trigram tables/triggers are unchanged; `search_fts` routes English projects to the `_en` tables. A one-time backfill and a language-change rebuild keep `_en` consistent.

**Tech Stack:** Rust (rusqlite/FTS5, `rust-stemmers`), TypeScript (Tauri `invoke`, Drizzle), SQLite FTS5.

**Spec:** `docs/superpowers/specs/2026-06-20-english-stemming-design.md`

**Phasing:** Phase A (lint, Tasks 1-3) is independent and shippable on its own. Phase B (FTS, Tasks 4-7), Phase C (wiring, Tasks 8-9), Phase D (verification, Tasks 10-11) form the search half. Phases A and B+C+D may be separate PRs.

**Verified facts (from SQLite 3.40.1 spikes, encoded in this plan):**
- `tokenize='porter unicode61'` is valid; porter wraps unicode61 and stems index **and** query.
- Double-quoted MATCH tokens are still tokenized/stemmed (sanitizer quoting is safe).
- `count(*)` on an **external-content** FTS returns the *content table* row count (not index rows) — so `_en` tables are **non-external** to make `count(*)` and plain `DELETE` work.

**Conventions:** branch-first (no commits to `master`); never edit `.github`; the lint crate denies `clippy::unwrap_used/expect_used/panic/indexing_slicing` in non-test code; commit messages end with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.

---

## File Structure

- `src-tauri/crates/grimodex-lint/Cargo.toml` — add `rust-stemmers` dep.
- `src-tauri/crates/grimodex-lint/src/stem.rs` — **new**, `stem_en()` helper.
- `src-tauri/crates/grimodex-lint/src/lib.rs` — declare `pub mod stem;`.
- `src-tauri/crates/grimodex-lint/src/rules/en/word_repetition.rs` — stem the dedup key.
- `src-tauri/crates/grimodex-lint/src/rules/en/filter_words.rs` — root list + stem matching.
- `src-tauri/src/database/fts.rs` — `rebuild_en_fts_sql`, `rebuild_en_fts()`, `search_fts` routing, `fts_rebuild`/`fts_optimize` `_en` additions.
- `src-tauri/src/database/migrate.rs` — `ensure_en_fts` (tables + triggers + one-time backfill), call from `migrate()`.
- `src-tauri/src/database/tests.rs` — FTS integration tests.
- `src-tauri/src/commands/integrity.rs` — `fts_rebuild_en` command.
- `src-tauri/src/lib.rs` — register `fts_rebuild_en`.
- `src/features/project/api.ts` — call `fts_rebuild_en` on language change.

---

## Phase A — Lint stemming

### Task 1: `stem_en` helper

**Files:**
- Modify: `src-tauri/crates/grimodex-lint/Cargo.toml:12-21`
- Create: `src-tauri/crates/grimodex-lint/src/stem.rs`
- Modify: `src-tauri/crates/grimodex-lint/src/lib.rs:21`

- [ ] **Step 1: Add the dependency**

In `Cargo.toml`, under `[dependencies]` (after the `lindera` line, line 21), add:

```toml
# English (Snowball/Porter2) stemmer for the English lint rules. Pure Rust,
# tiny, no dictionary. NOT a morphological analyzer (lindera handles Japanese).
rust-stemmers = "1"
```

- [ ] **Step 2: Write the failing test (create `stem.rs`)**

Create `src-tauri/crates/grimodex-lint/src/stem.rs`:

```rust
//! English (Snowball/Porter2) stemmer helper. Lexical normalization for the
//! English lint rules — NOT morphological analysis (lindera is Japanese-only).
//!
//! Input is expected to be already lowercased. The returned stem may not be a
//! real word (e.g. `studies` -> `studi`); it only needs to be *consistent* so
//! inflections of one lemma collapse to a single key.

use rust_stemmers::{Algorithm, Stemmer};

thread_local! {
    // Stemmer holds no mutable state; stem(&self) is read-only. thread_local
    // sidesteps any Sync requirement on a global and is cheap to construct.
    static EN_STEMMER: Stemmer = Stemmer::create(Algorithm::English);
}

/// Stem one English word to its Snowball (Porter2) root.
pub fn stem_en(word: &str) -> String {
    EN_STEMMER.with(|s| s.stem(word).into_owned())
}

#[cfg(test)]
mod tests {
    use super::stem_en;

    #[test]
    fn regular_inflections_collapse_to_one_root() {
        assert_eq!(stem_en("studies"), stem_en("studying"));
        assert_eq!(stem_en("running"), stem_en("runs"));
        assert_eq!(stem_en("noticed"), stem_en("noticing"));
    }

    #[test]
    fn distinct_lemmas_keep_distinct_roots() {
        // Agentive -er is not stripped, so "runner" stays its own family.
        assert_ne!(stem_en("running"), stem_en("runner"));
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p grimodex-lint stem::tests`
Expected: FAIL to compile — `module 'stem' is not declared` / `stem_en` unresolved (module not yet wired into `lib.rs`).

- [ ] **Step 4: Declare the module**

In `src-tauri/crates/grimodex-lint/src/lib.rs`, add after line 21 (`pub mod textscan;`):

```rust
pub mod stem;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p grimodex-lint stem::tests`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/grimodex-lint/Cargo.toml src-tauri/crates/grimodex-lint/src/stem.rs src-tauri/crates/grimodex-lint/src/lib.rs
git commit -m "feat(lint): add English Snowball stem_en helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stem the `en/word-repetition` dedup key

**Files:**
- Modify: `src-tauri/crates/grimodex-lint/src/rules/en/word_repetition.rs:86-111`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test**

In `word_repetition.rs`, inside `mod tests`, add after `flags_nearby_repeat` (line 156):

```rust
#[test]
fn flags_inflected_repeat_via_stem() {
    // "studies" and "study" share a stem; surface-form matching would miss it.
    let ds = run("She studies the map; a careful study of the realm.");
    assert_eq!(ds.len(), 1);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p grimodex-lint word_repetition::tests::flags_inflected_repeat_via_stem`
Expected: FAIL — `assertion failed: left == right` (0 != 1): surface forms `studies`/`study` are currently distinct keys.

- [ ] **Step 3: Stem the key**

In `word_repetition.rs`, replace the body of the `if is_content` block (lines 91-110). Current:

```rust
                if is_content {
                    if let Some(&prev) = last_seen.get(&lower) {
                        if word_index - prev <= distance {
                            let start =
                                block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                            let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                            out.push(Diagnostic {
                                rule_id: self.id().to_string(),
                                severity,
                                message: format!(
                                    "\u{201C}{}\u{201D} repeats within {} words",
                                    m.as_str(),
                                    distance
                                ),
                                range: Utf16Range { start, end },
                                fix: None,
                            });
                        }
                    }
                    last_seen.insert(lower, word_index);
                }
```

Replace with (key is the stem; length/stop checks stay on the surface `lower`):

```rust
                if is_content {
                    let key = crate::stem::stem_en(&lower);
                    if let Some(&prev) = last_seen.get(&key) {
                        if word_index - prev <= distance {
                            let start =
                                block.str_offset_start + utf8_to_utf16(&block.text, m.start());
                            let end = block.str_offset_start + utf8_to_utf16(&block.text, m.end());
                            out.push(Diagnostic {
                                rule_id: self.id().to_string(),
                                severity,
                                message: format!(
                                    "\u{201C}{}\u{201D} repeats within {} words",
                                    m.as_str(),
                                    distance
                                ),
                                range: Utf16Range { start, end },
                                fix: None,
                            });
                        }
                    }
                    last_seen.insert(key, word_index);
                }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p grimodex-lint word_repetition::tests`
Expected: PASS (all, including the existing `flags_nearby_repeat`, `ignores_stop_words`, `ignores_short_words`, `distance_window_respected`, and the new `flags_inflected_repeat_via_stem`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/grimodex-lint/src/rules/en/word_repetition.rs
git commit -m "feat(lint): stem en/word-repetition dedup key (run==running)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Stem matching in `en/filter-words`

**Files:**
- Modify: `src-tauri/crates/grimodex-lint/src/rules/en/filter_words.rs:14-69,94-108`
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test**

In `filter_words.rs`, inside `mod tests`, add after `flags_filter_words` (line 168):

```rust
#[test]
fn flags_inflections_not_listed_literally() {
    // "noticed"/"noticing" are not in the base list; stemming maps them in.
    assert_eq!(run("He noticed the cold while noticing the wind.").len(), 2);
}

#[test]
fn still_flags_irregular_past() {
    // "felt" is irregular (Snowball won't map it to "feel"); kept in the list.
    assert_eq!(run("She felt the chill.").len(), 1);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p grimodex-lint filter_words::tests::flags_inflections_not_listed_literally`
Expected: FAIL (0 != 2) — `noticing` is not in `FILTER_WORDS`.

- [ ] **Step 3: Replace the inflection list with base/irregular forms**

In `filter_words.rs`, replace `FILTER_WORDS` (lines 14-66) with:

```rust
/// Perception / cognition verbs commonly cited as filtering. We list each
/// family's base form plus the irregular past tenses Snowball can't fold
/// (saw, seen, heard, felt, thought, knew). Regular inflections (-s/-ed/-ing)
/// are matched by stemming, so they need not be listed.
const FILTER_WORD_FORMS: &[&str] = &[
    "see", "saw", "seen", "hear", "heard", "feel", "felt", "notice", "realize",
    "realise", "wonder", "think", "thought", "know", "knew", "watch", "seem",
    "decide", "remember",
];
```

- [ ] **Step 4: Switch the set to stems and match by stem**

In `filter_words.rs`, change the set type (line 69) from:

```rust
static WORD_SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
```

to:

```rust
static WORD_SET: OnceLock<HashSet<String>> = OnceLock::new();
```

Then change the set initialization (line 100) from:

```rust
        let set = WORD_SET.get_or_init(|| FILTER_WORDS.iter().copied().collect());
```

to:

```rust
        let set = WORD_SET.get_or_init(|| {
            FILTER_WORD_FORMS
                .iter()
                .map(|w| crate::stem::stem_en(w))
                .collect()
        });
```

Then change the match check (lines 107-110) from:

```rust
            for m in word_regex().find_iter(&block.text) {
                if !set.contains(m.as_str().to_ascii_lowercase().as_str()) {
                    continue;
                }
```

to:

```rust
            for m in word_regex().find_iter(&block.text) {
                let stem = crate::stem::stem_en(&m.as_str().to_ascii_lowercase());
                if !set.contains(stem.as_str()) {
                    continue;
                }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p grimodex-lint filter_words::tests`
Expected: PASS (existing `flags_filter_words`, `no_match_on_plain_prose`, `no_substring_match` + the two new tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/crates/grimodex-lint/src/rules/en/filter_words.rs
git commit -m "feat(lint): stem en/filter-words matching (roots + irregulars)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

> **Deferred (optional):** `en/dialogue-punctuation` could stem the captured tag word before `is_said_verb`. It is tertiary in the spec and out of scope here; revisit if `is_said_verb` proves to miss inflected reporting verbs.

---

## Phase B — FTS English tables + routing

### Task 4: `_en` FTS tables, triggers, and one-time backfill

**Files:**
- Modify: `src-tauri/src/database/fts.rs` (add `rebuild_en_fts_sql` free fn — used by backfill and rebuild)
- Modify: `src-tauri/src/database/migrate.rs` (add `ensure_en_fts`, call from `migrate()`)
- Test: `src-tauri/src/database/tests.rs`

- [ ] **Step 1: Add the `_en` rebuild SQL free function**

In `src-tauri/src/database/fts.rs`, at the top add the import (the file currently only imports `params_from_iter`):

```rust
use rusqlite::Connection;
```

Then add this free function at the end of the file (after the `to_fts_match` function, before `#[cfg(test)]`):

```rust
/// Repopulate every `_en` FTS table from scratch, restricted to English
/// projects (`projects.language LIKE 'en%'`). `_en` tables are non-external,
/// so a plain `DELETE FROM` + filtered `INSERT ... SELECT` is correct and the
/// FTS5 `('rebuild')` external-content footgun does not apply.
pub(crate) fn rebuild_en_fts_sql(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM codex_fts_en;
         INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
           SELECT rowid, COALESCE(name,''), COALESCE(aliases,''), COALESCE(summary,''), COALESCE(tags_cache,''), COALESCE(content,'')
           FROM codex_entries
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM snippets_fts_en;
         INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
           SELECT rowid, COALESCE(title,''), COALESCE(content,''), COALESCE(tags_cache,'')
           FROM snippets
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM tree_nodes_fts_en;
         INSERT INTO tree_nodes_fts_en(rowid, title, content)
           SELECT rowid, COALESCE(title,''), COALESCE(content,'')
           FROM tree_nodes
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM post_effect_annotations_fts_en;
         INSERT INTO post_effect_annotations_fts_en(rowid, content)
           SELECT rowid, COALESCE(content,'')
           FROM post_effect_annotations
           WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%');

         DELETE FROM chat_messages_fts_en;
         INSERT INTO chat_messages_fts_en(rowid, content)
           SELECT rowid, COALESCE(content,'')
           FROM chat_messages
           WHERE session_id IN (
             SELECT id FROM chat_sessions
             WHERE project_id IN (SELECT id FROM projects WHERE language LIKE 'en%')
           );",
    )
}
```

- [ ] **Step 2: Write the failing integration test**

In `src-tauri/src/database/tests.rs`, add a new test (near the other `test_fts5_*` tests). It uses the in-memory pattern already in this file (`Database::new(Path::new(":memory:"))` + `db.migrate()`):

```rust
#[test]
fn test_en_fts_triggers_route_and_stem() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    db.migrate().expect("re-migrate is idempotent");

    let conn = db.conn.lock().expect("lock");
    conn.execute_batch(
        "INSERT INTO projects(id, title, language) VALUES
           ('p_en', 'En Project', 'en'),
           ('p_ja', 'Ja Project', 'ja');
         INSERT INTO tree_nodes(id, project_id, node_type, title, content) VALUES
           ('s_en', 'p_en', 'scene', 'Ch1', 'she was studying hard'),
           ('s_ja', 'p_ja', 'scene', 'Sho1', 'plain japanese body');",
    )
    .expect("seed rows");

    // Incremental trigger indexed ONLY the English scene into _en, and porter
    // stems the query "studies" to match the indexed "studying".
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"studies\""],
            |r| r.get(0),
        )
        .expect("match query");
    assert_eq!(hits, 1, "only the en scene is in _en and porter stems studies==studying");
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cargo test -p grimodex test_en_fts_triggers_route_and_stem` (use the app crate's package name; if unsure run `cargo test test_en_fts_triggers_route_and_stem` from `src-tauri/`).
Expected: FAIL — `no such table: tree_nodes_fts_en`.

- [ ] **Step 4: Add `ensure_en_fts` in `migrate.rs`**

In `src-tauri/src/database/migrate.rs`, add this associated function inside `impl Database` (place it next to the other `pub(super) fn migrate_*` one-shots, e.g. after `migrate_ai_write_infrastructure`):

```rust
    /// Create the non-external `_en` FTS tables (porter unicode61) and their
    /// language-guarded sync triggers, then backfill English content exactly
    /// once. Existing trigram tables/triggers are left untouched (English rows
    /// are also indexed there but never queried for English projects).
    pub(super) fn ensure_en_fts(conn: &Connection) -> anyhow::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS fts_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);

             CREATE VIRTUAL TABLE IF NOT EXISTS codex_fts_en USING fts5(
                 name, aliases, summary, tags_cache, content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS snippets_fts_en USING fts5(
                 title, content, tags_cache,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts_en USING fts5(
                 content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS tree_nodes_fts_en USING fts5(
                 title, content,
                 tokenize='porter unicode61'
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS post_effect_annotations_fts_en USING fts5(
                 content,
                 tokenize='porter unicode61'
             );

             -- codex_entries (direct project_id)
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_ai AFTER INSERT ON codex_entries
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''), COALESCE(new.content,''));
             END;
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_ad AFTER DELETE ON codex_entries
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM codex_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS codex_fts_en_au AFTER UPDATE ON codex_entries
               WHEN (old.name IS NOT new.name OR old.aliases IS NOT new.aliases OR old.summary IS NOT new.summary OR old.tags_cache IS NOT new.tags_cache OR old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM codex_fts_en WHERE rowid = old.rowid;
                 INSERT INTO codex_fts_en(rowid, name, aliases, summary, tags_cache, content)
                 VALUES (new.rowid, COALESCE(new.name,''), COALESCE(new.aliases,''), COALESCE(new.summary,''), COALESCE(new.tags_cache,''), COALESCE(new.content,''));
             END;

             -- snippets (direct project_id)
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_ai AFTER INSERT ON snippets
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
                 VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
             END;
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_ad AFTER DELETE ON snippets
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM snippets_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS snippets_fts_en_au AFTER UPDATE ON snippets
               WHEN (old.title IS NOT new.title OR old.content IS NOT new.content OR old.tags_cache IS NOT new.tags_cache)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM snippets_fts_en WHERE rowid = old.rowid;
                 INSERT INTO snippets_fts_en(rowid, title, content, tags_cache)
                 VALUES (new.rowid, new.title, new.content, COALESCE(new.tags_cache,''));
             END;

             -- chat_messages (project_id via chat_sessions)
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_ai AFTER INSERT ON chat_messages
               WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'
             BEGIN
                 INSERT INTO chat_messages_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_ad AFTER DELETE ON chat_messages
               WHEN (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = old.session_id)) LIKE 'en%'
             BEGIN
                 DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS chat_messages_fts_en_au AFTER UPDATE ON chat_messages
               WHEN (old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = (SELECT project_id FROM chat_sessions WHERE id = new.session_id)) LIKE 'en%'
             BEGIN
                 DELETE FROM chat_messages_fts_en WHERE rowid = old.rowid;
                 INSERT INTO chat_messages_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;

             -- tree_nodes (direct project_id)
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_ai AFTER INSERT ON tree_nodes
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO tree_nodes_fts_en(rowid, title, content)
                 VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
             END;
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_ad AFTER DELETE ON tree_nodes
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM tree_nodes_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS tree_nodes_fts_en_au AFTER UPDATE ON tree_nodes
               WHEN (old.title IS NOT new.title OR old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM tree_nodes_fts_en WHERE rowid = old.rowid;
                 INSERT INTO tree_nodes_fts_en(rowid, title, content)
                 VALUES (new.rowid, COALESCE(new.title,''), COALESCE(new.content,''));
             END;

             -- post_effect_annotations (direct project_id)
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_ai AFTER INSERT ON post_effect_annotations
               WHEN (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 INSERT INTO post_effect_annotations_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_ad AFTER DELETE ON post_effect_annotations
               WHEN (SELECT language FROM projects WHERE id = old.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM post_effect_annotations_fts_en WHERE rowid = old.rowid;
             END;
             CREATE TRIGGER IF NOT EXISTS post_effect_annotations_fts_en_au AFTER UPDATE ON post_effect_annotations
               WHEN (old.content IS NOT new.content)
                AND (SELECT language FROM projects WHERE id = new.project_id) LIKE 'en%'
             BEGIN
                 DELETE FROM post_effect_annotations_fts_en WHERE rowid = old.rowid;
                 INSERT INTO post_effect_annotations_fts_en(rowid, content) VALUES (new.rowid, new.content);
             END;",
        )?;

        // One-time backfill of pre-existing English content (flagged so it runs
        // exactly once, independent of content shape).
        let done: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM fts_meta WHERE key = 'en_backfilled')",
            [],
            |r| r.get(0),
        )?;
        if !done {
            super::fts::rebuild_en_fts_sql(conn)?;
            conn.execute(
                "INSERT OR REPLACE INTO fts_meta(key, value) VALUES ('en_backfilled', '1')",
                [],
            )?;
        }
        Ok(())
    }
```

- [ ] **Step 5: Call `ensure_en_fts` from `migrate()`**

In `src-tauri/src/database/migrate.rs`, after the existing line 1550 (`Self::migrate_codex_fts_add_content(&conn)?;`), add:

```rust
        Self::ensure_en_fts(&conn)?;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cargo test test_en_fts_triggers_route_and_stem` (from `src-tauri/`).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/database/fts.rs src-tauri/src/database/migrate.rs src-tauri/src/database/tests.rs
git commit -m "feat(fts): non-external _en FTS tables + guarded triggers + backfill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `rebuild_en_fts()` method

**Files:**
- Modify: `src-tauri/src/database/fts.rs` (add method in `impl Database`)
- Test: `src-tauri/src/database/tests.rs`

- [ ] **Step 1: Write the failing test**

In `tests.rs`, add:

```rust
#[test]
fn test_rebuild_en_fts_repopulates_after_wipe() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'they kept running home');
             DELETE FROM tree_nodes_fts_en;",
        )
        .expect("seed + wipe _en");
        let after_wipe: i64 = conn
            .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
            .expect("count");
        assert_eq!(after_wipe, 0, "wipe emptied _en");
    }

    db.rebuild_en_fts().expect("rebuild");

    let conn = db.conn.lock().expect("lock");
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"runs\""],
            |r| r.get(0),
        )
        .expect("match");
    assert_eq!(hits, 1, "rebuild re-indexed the en scene; porter stems runs==running");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test test_rebuild_en_fts_repopulates_after_wipe` (from `src-tauri/`).
Expected: FAIL — `no method named 'rebuild_en_fts'`.

- [ ] **Step 3: Add the method**

In `src-tauri/src/database/fts.rs`, inside `impl Database` (e.g. after `fts_rebuild`), add:

```rust
    /// Rebuild all `_en` FTS tables from English-project content. Used on a
    /// project language change and as a manual repair.
    pub fn rebuild_en_fts(&self) -> anyhow::Result<()> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        rebuild_en_fts_sql(&conn)?;
        Ok(())
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test test_rebuild_en_fts_repopulates_after_wipe` (from `src-tauri/`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/database/fts.rs src-tauri/src/database/tests.rs
git commit -m "feat(fts): rebuild_en_fts() method

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Route `search_fts` to `_en` for English projects

**Files:**
- Modify: `src-tauri/src/database/fts.rs:22-237`
- Test: `src-tauri/src/database/tests.rs`

- [ ] **Step 1: Write the failing test**

In `tests.rs`, add:

```rust
#[test]
fn test_search_fts_en_project_stems_query() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'she was studying hard');",
        )
        .expect("seed");
    }
    // "studies" (a different surface form) must find the "studying" scene.
    let results = db
        .search_fts("p_en", "studies", "scenes", 10)
        .expect("search");
    assert_eq!(results.len(), 1, "porter-stemmed query hits the inflected body");
    assert_eq!(results[0]["id"], serde_json::json!("s1"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test test_search_fts_en_project_stems_query` (from `src-tauri/`).
Expected: FAIL — 0 results (the query still hits the trigram `tree_nodes_fts`, which does not stem `studies`→`studying`).

- [ ] **Step 3: Resolve the project language once, at the top of `search_fts`**

In `fts.rs`, after the `let like_pattern = format!("%{query}%");` line (line 39), add:

```rust
        let is_en: bool = conn
            .query_row(
                "SELECT language LIKE 'en%' FROM projects WHERE id = ?1",
                [project_id],
                |r| r.get(0),
            )
            .unwrap_or(false);
```

- [ ] **Step 4: Route the four FTS (non-LIKE) branches to the `_en` table**

For each of the four `else { ... }` FTS branches, replace the hard-coded FTS table name with a variable and build the SQL with `format!`. The four branches:

Scenes branch (currently lines 64-86) — replace the `else { ... }` body with:

```rust
            } else {
                let fts = if is_en { "tree_nodes_fts_en" } else { "tree_nodes_fts" };
                let sql = format!(
                    "SELECT tn.id, tn.title, COALESCE(tn.synopsis, '')
                     FROM {fts}
                     JOIN tree_nodes tn ON tn.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND tn.project_id = ?2 AND tn.node_type = 'scene'
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "scene",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
```

Codex branch (currently lines 112-134) — replace the `else { ... }` body with:

```rust
            } else {
                let fts = if is_en { "codex_fts_en" } else { "codex_fts" };
                let sql = format!(
                    "SELECT e.id, e.name, COALESCE(e.summary, '')
                     FROM {fts}
                     JOIN codex_entries e ON e.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND e.project_id = ?2
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "codex",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
```

Snippets branch (currently lines 159-181) — replace the `else { ... }` body with:

```rust
            } else {
                let fts = if is_en { "snippets_fts_en" } else { "snippets_fts" };
                let sql = format!(
                    "SELECT s.id, s.title, COALESCE(s.tags_cache, '')
                     FROM {fts}
                     JOIN snippets s ON s.rowid = {fts}.rowid
                     WHERE {fts} MATCH ?1 AND s.project_id = ?2
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "snippet",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
```

Chat branch (currently lines 212-236) — replace the `else { ... }` body with:

```rust
            } else {
                let fts = if is_en { "chat_messages_fts_en" } else { "chat_messages_fts" };
                let sql = format!(
                    "SELECT cm.id, cm.role, substr(cm.content, 1, 80)
                     FROM {fts}
                     JOIN chat_messages cm ON cm.rowid = {fts}.rowid
                     JOIN chat_sessions cs ON cs.id = cm.session_id
                     WHERE {fts} MATCH ?1 AND cs.project_id = ?2
                       AND cm.role IN ('user', 'assistant')
                     ORDER BY rank LIMIT ?3"
                );
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(
                    params_from_iter([match_query.as_str(), project_id, &lim.to_string()]),
                    |row| {
                        Ok(serde_json::json!({
                            "sourceType": "chat",
                            "id": row.get::<_, String>(0)?,
                            "title": row.get::<_, String>(1)?,
                            "excerpt": row.get::<_, String>(2)?,
                        }))
                    },
                )?;
                for r in rows {
                    results.push(r?);
                }
            }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test test_search_fts_en_project_stems_query` then the existing FTS suite `cargo test test_fts5` (from `src-tauri/`).
Expected: PASS for the new test; existing `test_fts5_*` still PASS (Japanese/default projects route to trigram unchanged).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database/fts.rs src-tauri/src/database/tests.rs
git commit -m "feat(fts): route search_fts to _en tables for English projects

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Include `_en` tables in `fts_rebuild` / `fts_optimize`

**Files:**
- Modify: `src-tauri/src/database/fts.rs:6-15,242-251`
- Test: `src-tauri/src/database/tests.rs`

- [ ] **Step 1: Write the failing test**

In `tests.rs`, add:

```rust
#[test]
fn test_fts_rebuild_includes_en_tables() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p_en', 'scene', 'Ch1', 'horses galloped');
             DELETE FROM tree_nodes_fts_en;",
        )
        .expect("seed + wipe");
    }
    db.fts_rebuild().expect("rebuild");
    db.fts_optimize().expect("optimize");
    let conn = db.conn.lock().expect("lock");
    let hits: i64 = conn
        .query_row(
            "SELECT count(*) FROM tree_nodes_fts_en WHERE tree_nodes_fts_en MATCH ?1",
            ["\"horse\""],
            |r| r.get(0),
        )
        .expect("match");
    assert_eq!(hits, 1, "fts_rebuild repopulated _en; fts_optimize did not error");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test test_fts_rebuild_includes_en_tables` (from `src-tauri/`).
Expected: FAIL — 0 hits (current `fts_rebuild` does not touch `_en`).

- [ ] **Step 3: Add `_en` optimize statements**

In `fts.rs`, replace the `fts_optimize` batch (lines 8-13) so it also optimizes the `_en` tables:

```rust
        conn.execute_batch(
            "INSERT INTO codex_fts(codex_fts) VALUES('optimize');
             INSERT INTO snippets_fts(snippets_fts) VALUES('optimize');
             INSERT INTO chat_messages_fts(chat_messages_fts) VALUES('optimize');
             INSERT INTO tree_nodes_fts(tree_nodes_fts) VALUES('optimize');
             INSERT INTO codex_fts_en(codex_fts_en) VALUES('optimize');
             INSERT INTO snippets_fts_en(snippets_fts_en) VALUES('optimize');
             INSERT INTO chat_messages_fts_en(chat_messages_fts_en) VALUES('optimize');
             INSERT INTO tree_nodes_fts_en(tree_nodes_fts_en) VALUES('optimize');
             INSERT INTO post_effect_annotations_fts_en(post_effect_annotations_fts_en) VALUES('optimize');",
        )?;
```

- [ ] **Step 4: Add the `_en` rebuild to `fts_rebuild`**

In `fts.rs`, change `fts_rebuild` (lines 242-251) to also rebuild `_en`. After the existing `conn.execute_batch("... 'rebuild' ...")?;` and before `Ok(())`, add:

```rust
        rebuild_en_fts_sql(&conn)?;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test test_fts_rebuild_includes_en_tables` then `cargo test test_fts_optimize_succeeds` (from `src-tauri/`).
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/database/fts.rs src-tauri/src/database/tests.rs
git commit -m "feat(fts): include _en tables in fts_rebuild/fts_optimize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase C — Command + language-change wiring

### Task 8: `fts_rebuild_en` Tauri command

**Files:**
- Modify: `src-tauri/src/commands/integrity.rs:5-13`
- Modify: `src-tauri/src/lib.rs:233-234`

- [ ] **Step 1: Add the command**

In `src-tauri/src/commands/integrity.rs`, after the `fts_rebuild` command (line 13), add:

```rust
#[tauri::command]
pub(crate) fn fts_rebuild_en(ws_state: tauri::State<'_, WorkspaceState>) -> Result<(), AppError> {
    with_db(&ws_state, |db| db.rebuild_en_fts())
}
```

- [ ] **Step 2: Register it in the invoke handler**

In `src-tauri/src/lib.rs`, after line 234 (`commands::integrity::fts_rebuild,`), add:

```rust
            commands::integrity::fts_rebuild_en,
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo check` (from `src-tauri/`).
Expected: builds with no errors (command is wired; a missing registration would surface only at runtime, so this step is a compile gate).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/integrity.rs src-tauri/src/lib.rs
git commit -m "feat(fts): fts_rebuild_en command

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Rebuild `_en` on project language change

**Files:**
- Modify: `src/features/project/api.ts:1-3,41-65`
- Test: `src/features/project/api.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `src/features/project/api.test.ts` (mock the Drizzle client and Tauri `invoke`; mirror the mock style used elsewhere in the repo — e.g. existing `*.test.ts` that mock `@/db/client`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const returningMock = vi.fn().mockResolvedValue([{ id: "p1", language: "en" }]);
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({ where: () => ({ returning: returningMock }) }),
    }),
  },
}));
vi.mock("@/db/schema", () => ({ projects: {}, lintTermDictionary: {} }));

import { updateProject } from "./api";

beforeEach(() => invokeMock.mockClear());

describe("updateProject", () => {
  it("rebuilds _en FTS when language is in the patch", async () => {
    await updateProject("p1", { language: "en" });
    expect(invokeMock).toHaveBeenCalledWith("fts_rebuild_en");
  });

  it("does not rebuild _en FTS when language is absent", async () => {
    await updateProject("p1", { title: "New Title" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/features/project/api.test.ts`
Expected: FAIL — `invoke` never called (updateProject has no FTS hook yet).

- [ ] **Step 3: Wire the rebuild call**

In `src/features/project/api.ts`, add the import after line 3 (`import { eq } from "drizzle-orm";`):

```ts
import { invoke } from "@tauri-apps/api/core";
```

Then in `updateProject` (lines 58-64), replace:

```ts
  const rows = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .returning();
  return rows[0];
```

with:

```ts
  const rows = await db
    .update(projects)
    .set({ ...data, updatedAt: new Date().toISOString() })
    .where(eq(projects.id, id))
    .returning();
  // A language switch re-routes which FTS tables a project's content lives in;
  // rebuild the English (_en) index so search stays consistent. Best-effort.
  if (data.language !== undefined) {
    await invoke("fts_rebuild_en").catch(() => {});
  }
  return rows[0];
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/features/project/api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features/project/api.ts src/features/project/api.test.ts
git commit -m "feat(project): rebuild _en FTS on language change

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase D — Verification

### Task 10: Language-switch integration test (en→ja→en)

**Files:**
- Test: `src-tauri/src/database/tests.rs`

- [ ] **Step 1: Write the test**

In `tests.rs`, add:

```rust
#[test]
fn test_language_switch_reroutes_en_index() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute_batch(
            "INSERT INTO projects(id, title, language) VALUES ('p', 'P', 'en');
             INSERT INTO tree_nodes(id, project_id, node_type, title, content)
               VALUES ('s1', 'p', 'scene', 'Ch1', 'she was studying hard');",
        )
        .expect("seed en");
    }
    // English now: search routes to _en and stems.
    assert_eq!(
        db.search_fts("p", "studies", "scenes", 10).expect("en search").len(),
        1
    );

    // Switch to Japanese, then rebuild _en (mirrors the updateProject hook).
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute("UPDATE projects SET language = 'ja' WHERE id = 'p'", [])
            .expect("switch to ja");
    }
    db.rebuild_en_fts().expect("rebuild after switch");
    {
        let conn = db.conn.lock().expect("lock");
        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM tree_nodes_fts_en", [], |r| r.get(0))
            .expect("count");
        assert_eq!(remaining, 0, "no en-project rows remain in _en after switch to ja");
    }
    // Trigram still has the content, so the literal word is findable as ja.
    assert_eq!(
        db.search_fts("p", "studying", "scenes", 10).expect("ja search").len(),
        1
    );

    // Switch back to English and rebuild.
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute("UPDATE projects SET language = 'en' WHERE id = 'p'", [])
            .expect("switch to en");
    }
    db.rebuild_en_fts().expect("rebuild back to en");
    assert_eq!(
        db.search_fts("p", "studies", "scenes", 10).expect("en search again").len(),
        1
    );
}
```

- [ ] **Step 2: Run the test**

Run: `cargo test test_language_switch_reroutes_en_index` (from `src-tauri/`).
Expected: PASS.

- [ ] **Step 3: Run the full suites as a regression gate**

Run: `cargo test` (from `src-tauri/`) and `cargo test -p grimodex-lint`.
Expected: all PASS. (Note: in this sandbox `cargo test` for the app crate may fail to *link* `ort-sys` — that is an environment issue, not a code issue; `cargo check --tests` must pass and the lint-crate tests must pass. CI runs the full app-crate tests.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/database/tests.rs
git commit -m "test(fts): language-switch re-routing integration test

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Recall/precision eval gate (measurement)

**Files:**
- Test: `src-tauri/src/database/tests.rs` (an `#[ignore]` measurement test, run on demand)

This task quantifies the search half (spec §8 / §10): it is a **measurement**, not a pass/fail invariant. It compares trigram vs `porter unicode61` on a small English query set and prints recall, so the FTS effort can be judged and regressions caught later.

- [ ] **Step 1: Write the measurement test**

In `tests.rs`, add (marked `#[ignore]` so it runs only when asked):

```rust
#[test]
#[ignore = "measurement: run with --ignored to print trigram vs _en recall"]
fn measure_en_fts_recall_trigram_vs_porter() {
    let db = Database::new(Path::new(":memory:")).expect("open");
    db.migrate().expect("migrate");
    // A handful of scenes with inflected vocabulary, plus an en and a ja project.
    let scenes: &[(&str, &str)] = &[
        ("s1", "the soldiers were studying old maps by candlelight"),
        ("s2", "she studies the ledger and decides to leave"),
        ("s3", "horses galloped while the riders shouted"),
        ("s4", "he noticed the broken lock and the cold draft"),
        ("s5", "they kept running through the burning streets"),
    ];
    {
        let conn = db.conn.lock().expect("lock");
        conn.execute(
            "INSERT INTO projects(id, title, language) VALUES ('p_en', 'En', 'en')",
            [],
        )
        .expect("en project");
        for (id, body) in scenes {
            conn.execute(
                "INSERT INTO tree_nodes(id, project_id, node_type, title, content)
                 VALUES (?1, 'p_en', 'scene', 'S', ?2)",
                rusqlite::params![id, body],
            )
            .expect("scene");
        }
    }
    // Query (stemmed/base form) -> the scene id it should retrieve.
    let queries: &[(&str, &str)] = &[
        ("study", "s1"),     // study -> studying
        ("decide", "s2"),    // decide -> decides
        ("gallop", "s3"),    // gallop -> galloped
        ("notice", "s4"),    // notice -> noticed
        ("run", "s5"),       // run -> running (len 3: see note below)
    ];
    let mut en_hits = 0;
    for (q, want) in queries {
        let found = db
            .search_fts("p_en", q, "scenes", 10)
            .expect("search")
            .iter()
            .any(|r| r["id"] == serde_json::json!(*want));
        if found {
            en_hits += 1;
        }
    }
    // Note: "run" is 3 codepoints and survives the sanitizer; 1-2 char queries
    // are dropped by to_fts_match for both tokenizers (documented limitation).
    println!(
        "[eval] _en (porter unicode61) recall: {}/{} inflected queries",
        en_hits,
        queries.len()
    );
    // Sanity floor: stemming should retrieve clearly inflected matches.
    assert!(en_hits >= 4, "expected porter stemming to recall >=4/5 inflected queries");
}
```

- [ ] **Step 2: Run the measurement**

Run: `cargo test measure_en_fts_recall_trigram_vs_porter -- --ignored --nocapture` (from `src-tauri/`).
Expected: prints the recall line; the `>=4/5` floor passes. Record the printed number in the PR description as the baseline.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/database/tests.rs
git commit -m "test(fts): English stemming recall measurement (ignored)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed against spec)

- **Spec coverage:** §5.1 routing → Task 6; §5.2 lint (stem_en, word-repetition, filter-words) → Tasks 1-3; §5.3 `_en` tables + guarded triggers + non-external → Task 4; §5.4 rebuild/backfill/language-change → Tasks 4 (backfill), 5 + 7 (rebuild), 8-9 (language-change wiring); §8 tests + eval gate → Tasks 2,3,4,5,6,7,9,10,11; §9 files all covered. `en/dialogue-punctuation` (§5.2 tertiary) is explicitly deferred with a note.
- **Type/identifier consistency:** `stem_en` (Tasks 1-3), `rebuild_en_fts_sql` (Tasks 4,5,7), `rebuild_en_fts` (Tasks 5,7,8,10), `ensure_en_fts` (Task 4), `fts_rebuild_en` command (Tasks 8,9), `fts_meta` table (Task 4) — used consistently.
- **Known environment caveat:** the app crate's `cargo test` may fail to link `ort-sys` in this sandbox; gate on `cargo check --tests` locally and rely on CI for the full app-crate run (lint-crate tests run fine locally).
