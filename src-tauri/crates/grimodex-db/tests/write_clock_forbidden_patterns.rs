//! write clock（DB 段 1 PR-1、DR-DBC-3）を迂回する書込み手段が、製品のソースに入らないことの
//! 静的な試験。
//!
//! clock は main schema の AFTER TRIGGER が進める。次の手段は TRIGGER を通らない、または
//! 無効にするので、製品コードには置かない。
//!
//! - (a) `SQLITE_DBCONFIG_ENABLE_TRIGGER`（TRIGGER 自体を接続ごとに無効にできる）
//! - (b) SQLite の blob incremental I/O（`blob_open`、`sqlite3_blob_*`。行を書き換えるが
//!   TRIGGER が走らない）。rusqlite の `blob` feature も同じ理由で製品の Cargo.toml に置かない
//! - (c) `rusqlite::backup::Backup::new` と、`Connection::backup`／`Connection::restore`
//!   （`nir1-material-diagnostics` が `rusqlite/backup` を有効にする）。ページ単位の複製で、
//!   書込み先の clock・lineage をそのまま持ち込む。製品の backup は `VACUUM INTO`。
//!   `#[cfg(test)]` と test 専用の feature（[`TEST_ONLY_FEATURES`]）以外は不可。
//!   `Connection::backup`／`restore` は名前が一般的なので、先頭の引数が文字列リテラルか
//!   `DatabaseName` の呼び出しだけを検出する（自前の `restore()` の誤検知を避ける）
//! - (d) `writable_schema` を有効にする設定（`sqlite_master` の直接編集で TRIGGER を消せる）、
//!   `ignore_check_constraints` を有効にする設定（clock 表の `CHECK(typeof(seq)='integer')`
//!   を無視させ、桁あふれの fail-closed を外せる）。
//!   `recursive_triggers` は規則にしない：OFF は SQLite の既定値で、入れ子の TRIGGER
//!   （他の表の TRIGGER が起こした書込みで発火する clock の TRIGGER）はその設定でも発火する
//!
//! # 走査の範囲と除外の仕組み
//!
//! 走査するのは製品のソース `src-tauri/crates/*/src`、`src-tauri/src`（frozen legacy の
//! Tauri shell）、`electron/native/grimodex-node/src` の `*.rs` と、各 crate の `Cargo.toml`。
//! 単純な文字列検索だが、次を取り除いてから探す（誤検知で許可リストが膨らまないように）。
//!
//! 1. コメント（`//`、`/* */`）。説明文に禁止語を書いてよい。
//! 2. `#[cfg(test)]`（`any(test, feature = "X")` を含む。ただし X は [`TEST_ONLY_FEATURES`] の
//!    test 専用 feature だけ。それ以外の feature は製品の build で有効になり得るので、
//!    製品として走査する。`all(test, ..)` は `test` が必須なので test 専用。`not(test)` は製品）
//!    が付いた item。
//!    `mod x { .. }` や `fn` は括弧の対応で、`mod x;` は宣言した file
//!    （`x.rs`、`x/mod.rs`、`x/**`）ごと除く。
//! 3. `tests/`、`test_support/`、`test-support/` の directory。
//!
//! 取り除いた後に残った既存の使用は [`ALLOWLIST`] に file と該当行の断片と理由を書く
//! （行番号はずれるので断片で照合する。失敗時の表示には行番号を出す）。許可リストの項目が
//! 一度も当たらなくなったら、古くなったのでこの試験が失敗する。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rule {
    EnableTrigger,
    BlobIo,
    BackupNew,
    BackupRestoreCall,
    WritableSchemaOn,
    IgnoreCheckConstraintsOn,
}

impl Rule {
    fn label(self) -> &'static str {
        match self {
            Rule::EnableTrigger => "(a) ENABLE_TRIGGER",
            Rule::BlobIo => "(b) blob incremental API",
            Rule::BackupNew => "(c) Backup::new outside test code",
            Rule::BackupRestoreCall => "(c) Connection::backup/restore outside test code",
            Rule::WritableSchemaOn => "(d) writable_schema enabled",
            Rule::IgnoreCheckConstraintsOn => "(d) ignore_check_constraints enabled",
        }
    }
}

struct Allowed {
    /// repo root からの相対 path（`/` 区切り）。
    file: &'static str,
    rule: Rule,
    /// 該当行（コメント除去後の、前後の空白を除いた形）に含まれる断片。
    snippet: &'static str,
    /// この断片が当たる箇所の数（ちょうど一致を要求する。増えたら新規の使用なので失敗）。
    count: usize,
    reason: &'static str,
}

/// 既存の使用のうち、clock を迂回しないと判断したもの。新規に足すときは理由を書く。
const ALLOWLIST: &[Allowed] = &[
    Allowed {
        file: "src-tauri/crates/grimodex-db/src/bin/support/private_fixture.rs",
        rule: Rule::BackupNew,
        snippet: "Backup::new(&source, &mut destination)",
        count: 1,
        reason: "private fixture の bin 補助（required-features 付きの bin だけが取り込む）。\
                 製品の lib／napi には入らず、READ_ONLY で開いた複製元を新しい file へ写すだけで、\
                 既存 DB には書かない",
    },
    Allowed {
        file: "src-tauri/crates/grimodex-db/src/migrate.rs",
        rule: Rule::WritableSchemaOn,
        snippet: "pragma_update(None, \"writable_schema\", true)",
        count: 4,
        reason: "過去の版の one-shot migration 4 本（typo／intent／timeline／impact_review の CHECK \
                 widening。`verify_post_effect_category_migration` の呼び出し元）。post_effect_runs／\
                 post_effect_annotations の `sqlite_master.sql` の CHECK 文字列だけを書き換え、\
                 すぐ writable_schema を false に戻す。TRIGGER は触らず、clock の install は \
                 この後（stamp の直前）で表の実態から作り直すので、clock を迂回しない",
    },
];

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

/// `.rs` の source を 2 つの同じ長さの buffer にする。
/// - `code`: コメントを空白にしたもの（文字列は残す。検索はこちら）。
/// - `structure`: さらに文字列・文字リテラルの中身も空白にしたもの（括弧の対応はこちら）。
///
/// 改行は両方で保つ（行番号を変えない）。
fn mask(source: &str) -> (Vec<u8>, Vec<u8>) {
    let bytes = source.as_bytes();
    let mut code = bytes.to_vec();
    let mut structure = bytes.to_vec();
    let blank = |buf: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut buf[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        if byte == b'/' && bytes.get(i + 1) == Some(&b'/') {
            let end = bytes[i..]
                .iter()
                .position(|b| *b == b'\n')
                .map_or(bytes.len(), |p| i + p);
            blank(&mut code, i, end);
            blank(&mut structure, i, end);
            i = end;
        } else if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
            // Rust の block comment は入れ子にできる。
            let mut depth = 0usize;
            let mut j = i;
            while j < bytes.len() {
                if bytes[j] == b'/' && bytes.get(j + 1) == Some(&b'*') {
                    depth += 1;
                    j += 2;
                } else if bytes[j] == b'*' && bytes.get(j + 1) == Some(&b'/') {
                    depth -= 1;
                    j += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    j += 1;
                }
            }
            blank(&mut code, i, j);
            blank(&mut structure, i, j);
            i = j;
        } else if let Some((open, hashes)) = raw_string_start(bytes, i) {
            // r"..."、r#"..."#、br#"..."#。
            let mut closing = vec![b'"'];
            closing.extend(std::iter::repeat_n(b'#', hashes));
            let body = open;
            let end = find_sub(bytes, body, &closing).map_or(bytes.len(), |p| p + closing.len());
            blank(
                &mut structure,
                body,
                end.saturating_sub(closing.len()).max(body),
            );
            i = end;
        } else if byte == b'"' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j] != b'"' {
                j += if bytes[j] == b'\\' { 2 } else { 1 };
            }
            let end = (j + 1).min(bytes.len());
            blank(&mut structure, i + 1, j.min(bytes.len()));
            i = end;
        } else if byte == b'\'' {
            // 文字リテラルか lifetime か。`'x'`／`'\n'` だけをリテラルとして扱う。
            let rest = &source[i + 1..];
            let literal_end = if let Some(escaped) = rest.strip_prefix('\\') {
                escaped.find('\'').map(|p| i + 1 + 1 + p + 1)
            } else {
                rest.chars()
                    .next()
                    .filter(|c| rest[c.len_utf8()..].starts_with('\''))
                    .map(|c| i + 1 + c.len_utf8() + 1)
            };
            match literal_end {
                Some(end) => {
                    blank(&mut structure, i + 1, end - 1);
                    i = end;
                }
                None => i += 1,
            }
        } else {
            i += 1;
        }
    }
    (code, structure)
}

/// `i` が raw string の開始なら、本文の開始位置と `#` の数を返す。
fn raw_string_start(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let prev_is_ident = i > 0 && (bytes[i - 1].is_ascii_alphanumeric() || bytes[i - 1] == b'_');
    if prev_is_ident {
        return None;
    }
    let mut j = i;
    if bytes.get(j) == Some(&b'b') {
        j += 1;
    }
    if bytes.get(j) != Some(&b'r') {
        return None;
    }
    j += 1;
    let hashes = bytes[j..].iter().take_while(|b| **b == b'#').count();
    j += hashes;
    (bytes.get(j) == Some(&b'"')).then_some((j + 1, hashes))
}

fn find_sub(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|p| from + p)
}

/// `#[cfg(any(test, feature = "X"))]` の X として許す、test 専用の feature の名前。
/// 製品の build（napi・MCP・lib の既定）で有効にならない feature だけを置く。
/// `nir1-material-diagnostics`／`nir1-graph-eval` のような診断・評価用の feature は
/// 製品の artifact に入り得るのでここに置かず、製品として走査する。
const TEST_ONLY_FEATURES: &[&str] = &[
    "test-support",
    "workspace-maintenance-test-support",
    "ai-audit-commit-test-probe",
];

/// `a, b(c, d), e` を括弧の外のコンマで分ける。
fn split_top_level(text: &str) -> Vec<&str> {
    let mut terms = Vec::new();
    let mut depth = 0i32;
    let mut start = 0;
    for (at, byte) in text.bytes().enumerate() {
        match byte {
            b'(' => depth += 1,
            b')' => depth -= 1,
            b',' if depth == 0 => {
                terms.push(&text[start..at]);
                start = at + 1;
            }
            _ => {}
        }
    }
    terms.push(&text[start..]);
    terms.retain(|term| !term.is_empty());
    terms
}

/// `#[cfg(..)]` の中身が「test のときだけ」を意味するか。
/// - `test`
/// - `all(test, ..)`（`test` が必須なので、他の条件に依らず test のときだけ）
/// - `any(test, feature = "X", ..)` で、X が全て [`TEST_ONLY_FEATURES`] のとき
fn cfg_is_test_only(attribute_body: &str) -> bool {
    let compact: String = attribute_body
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let inner = compact
        .strip_prefix("cfg(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or("");
    if inner == "test" {
        return true;
    }
    if let Some(terms) = inner.strip_prefix("all(").and_then(|s| s.strip_suffix(')')) {
        return split_top_level(terms).contains(&"test");
    }
    let Some(terms) = inner.strip_prefix("any(").and_then(|s| s.strip_suffix(')')) else {
        return false;
    };
    let terms = split_top_level(terms);
    terms.contains(&"test")
        && terms.iter().all(|term| {
            *term == "test"
                || term
                    .strip_prefix("feature=\"")
                    .and_then(|rest| rest.strip_suffix('"'))
                    .is_some_and(|name| TEST_ONLY_FEATURES.contains(&name))
        })
}

/// `#[cfg(test)]` の付いた item を `code` から空白にして取り除く。
/// 戻り値は、`mod x;` として宣言された out-of-line module（`#[path = ".."]` 付きなら
/// その path）。
fn remove_cfg_test_items(code: &mut [u8], structure: &[u8]) -> Vec<TestModRef> {
    let mut out_of_line = Vec::new();
    let mut i = 0;
    while let Some(p) = find_sub(structure, i, b"#[") {
        let attr_start = p;
        let Some(attr_end) = matching_close(structure, p + 1, b'[', b']') else {
            break;
        };
        let body = std::str::from_utf8(&code[p + 2..attr_end]).unwrap_or("");
        if !cfg_is_test_only(body) {
            i = attr_end + 1;
            continue;
        }
        // 続く属性を飛ばして item の先頭へ（`#[path = ".."]` は控える）。
        let mut explicit_path: Option<String> = None;
        let mut cursor = attr_end + 1;
        loop {
            while cursor < structure.len() && structure[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if structure.get(cursor) == Some(&b'#') && structure.get(cursor + 1) == Some(&b'[') {
                match matching_close(structure, cursor + 1, b'[', b']') {
                    Some(end) => {
                        let attribute = String::from_utf8_lossy(&code[cursor + 2..end]);
                        if let Some(value) = path_attribute_value(&attribute) {
                            explicit_path = Some(value);
                        }
                        cursor = end + 1;
                    }
                    None => return out_of_line,
                }
            } else {
                break;
            }
        }
        // item の終端：depth 0 の `;` か、最初の `{ .. }` の対応。
        let item_start = cursor;
        let mut depth = 0i32;
        let mut end = structure.len();
        let mut j = cursor;
        while j < structure.len() {
            match structure[j] {
                b'(' | b'[' => depth += 1,
                b')' | b']' => depth -= 1,
                b';' if depth == 0 => {
                    end = j + 1;
                    break;
                }
                b'{' if depth == 0 => {
                    end =
                        matching_close(structure, j, b'{', b'}').map_or(structure.len(), |e| e + 1);
                    break;
                }
                _ => {}
            }
            j += 1;
        }
        let item = String::from_utf8_lossy(&code[item_start..end]).into_owned();
        if let Some(name) = out_of_line_mod_name(&item) {
            out_of_line.push(match explicit_path {
                Some(path) => TestModRef::Path(path),
                None => TestModRef::Name(name),
            });
        }
        for byte in &mut code[attr_start..end] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
        i = end;
    }
    out_of_line
}

#[derive(Debug, PartialEq, Eq)]
enum TestModRef {
    /// `mod x;`
    Name(String),
    /// `#[path = "x_tests.rs"] mod x;`（宣言した file の directory からの相対）
    Path(String),
}

fn path_attribute_value(attribute: &str) -> Option<String> {
    let rest = attribute.trim().strip_prefix("path")?.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let rest = rest.strip_prefix('"')?;
    Some(rest[..rest.find('"')?].to_string())
}

fn out_of_line_mod_name(item: &str) -> Option<String> {
    let trimmed = item.trim();
    let after_vis = trimmed
        .strip_prefix("pub(crate)")
        .or_else(|| trimmed.strip_prefix("pub(super)"))
        .or_else(|| trimmed.strip_prefix("pub"))
        .unwrap_or(trimmed)
        .trim_start();
    let name = after_vis.strip_prefix("mod ")?.trim().strip_suffix(';')?;
    Some(name.trim().to_string())
}

fn matching_close(buf: &[u8], open_at: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0i32;
    for (offset, byte) in buf[open_at..].iter().enumerate() {
        if *byte == open {
            depth += 1;
        } else if *byte == close {
            depth -= 1;
            if depth == 0 {
                return Some(open_at + offset);
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 規則
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq, Eq)]
struct Hit {
    rule: Rule,
    line: usize,
    text: String,
}

fn line_of(code: &[u8], at: usize) -> usize {
    code[..at].iter().filter(|b| **b == b'\n').count() + 1
}

fn line_text(code: &[u8], at: usize) -> String {
    let start = code[..at]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |p| p + 1);
    let end = code[at..]
        .iter()
        .position(|b| *b == b'\n')
        .map_or(code.len(), |p| at + p);
    String::from_utf8_lossy(&code[start..end])
        .trim()
        .to_string()
}

fn occurrences(lower: &str, needle: &str) -> Vec<usize> {
    lower.match_indices(needle).map(|(at, _)| at).collect()
}

/// keyword の後ろ（`)`／`;`／`}` まで、最大 80 byte）の token。値の判定に使う。
fn value_tokens(lower: &str, after: usize) -> Vec<String> {
    let mut end = (after + 80).min(lower.len());
    while !lower.is_char_boundary(end) {
        end -= 1;
    }
    let tail = &lower[after..end];
    let stop = tail.find([')', ';', '}']).unwrap_or(tail.len());
    tail[..stop]
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .collect()
}

/// 取り除き済みの `code` から禁止パターンを探す。
fn find_hits(code: &[u8]) -> Vec<Hit> {
    let text = String::from_utf8_lossy(code).into_owned();
    // ASCII の小文字化は byte 位置を変えない。
    let lower = text.to_ascii_lowercase();
    let mut hits = Vec::new();
    // 同じ行・同じ規則の重複（`sqlite3_blob_open` は 2 つの断片に当たる）は 1 件にする。
    let mut push = |rule: Rule, at: usize| {
        let line = line_of(code, at);
        if hits.iter().any(|h: &Hit| h.rule == rule && h.line == line) {
            return;
        }
        hits.push(Hit {
            rule,
            line,
            text: line_text(code, at),
        });
    };

    for at in occurrences(&lower, "enable_trigger") {
        push(Rule::EnableTrigger, at);
    }
    for needle in [
        "blob_open",
        "sqlite3_blob",
        "blob::open",
        "blob_reopen",
        "open_blob",
        ".blob(",
    ] {
        for at in occurrences(&lower, needle) {
            push(Rule::BlobIo, at);
        }
    }
    for at in occurrences(&lower, "backup::new") {
        push(Rule::BackupNew, at);
    }
    for at in occurrences(&lower, "writable_schema") {
        let after = at + "writable_schema".len();
        if value_tokens(&lower, after)
            .iter()
            .any(|t| matches!(t.as_str(), "true" | "on" | "1" | "yes"))
        {
            push(Rule::WritableSchemaOn, at);
        }
    }
    for at in occurrences(&lower, "ignore_check_constraints") {
        let after = at + "ignore_check_constraints".len();
        if value_tokens(&lower, after)
            .iter()
            .any(|t| matches!(t.as_str(), "true" | "on" | "1" | "yes"))
        {
            push(Rule::IgnoreCheckConstraintsOn, at);
        }
    }
    // UFCS の形は、名前が一般的でないのでそのまま検出する。
    for needle in ["connection::backup(", "connection::restore("] {
        for at in occurrences(&lower, needle) {
            push(Rule::BackupRestoreCall, at);
        }
    }
    // method の形は、先頭の引数が文字列リテラルか `DatabaseName` のときだけ。
    for needle in [".backup(", ".restore("] {
        for at in occurrences(&lower, needle) {
            let first_argument = lower[at + needle.len()..].trim_start();
            if first_argument.starts_with('"') || first_argument.starts_with("databasename") {
                push(Rule::BackupRestoreCall, at);
            }
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// file の列挙
// ---------------------------------------------------------------------------

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

fn product_source_roots(root: &Path) -> Vec<PathBuf> {
    let mut roots = vec![
        root.join("src-tauri/src"),
        root.join("electron/native/grimodex-node/src"),
    ];
    for entry in std::fs::read_dir(root.join("src-tauri/crates")).expect("read crates") {
        let src = entry.expect("crate entry").path().join("src");
        if src.is_dir() {
            roots.push(src);
        }
    }
    roots.sort();
    roots
}

fn walk(dir: &Path, files: &mut Vec<PathBuf>) {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|e| e.expect("entry").path())
        .collect();
    entries.sort();
    for path in entries {
        if path.is_dir() {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if matches!(name, "tests" | "test_support" | "test-support") {
                continue;
            }
            walk(&path, files);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
}

/// `#[cfg(test)] mod x;` が指す file と directory の集合を作るための、module の基準 directory。
fn module_base_dir(file: &Path) -> PathBuf {
    let dir = file.parent().expect("parent");
    match file.file_stem().and_then(|s| s.to_str()) {
        Some("mod" | "lib" | "main") => dir.to_path_buf(),
        Some(stem) => dir.join(stem),
        None => dir.to_path_buf(),
    }
}

struct Scanned {
    relative: String,
    code: Vec<u8>,
    out_of_line_test_mods: Vec<PathBuf>,
}

fn scan_file(root: &Path, file: &Path) -> Scanned {
    let source =
        std::fs::read_to_string(file).unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
    let (mut code, structure) = mask(&source);
    let refs = remove_cfg_test_items(&mut code, &structure);
    let base = module_base_dir(file);
    let out_of_line_test_mods = refs
        .iter()
        .map(|module| match module {
            TestModRef::Name(name) => base.join(name),
            TestModRef::Path(path) => file
                .parent()
                .expect("parent")
                .join(path.trim_end_matches(".rs")),
        })
        .collect();
    Scanned {
        relative: file
            .strip_prefix(root)
            .expect("under root")
            .to_string_lossy()
            .replace('\\', "/"),
        code,
        out_of_line_test_mods,
    }
}

fn is_excluded_by_test_mod(file: &Path, test_mods: &BTreeSet<PathBuf>) -> bool {
    let stem_path = file.with_extension("");
    if test_mods.contains(&stem_path) {
        return true; // `x.rs`
    }
    if file.file_name().is_some_and(|n| n == "mod.rs")
        && file.parent().is_some_and(|dir| test_mods.contains(dir))
    {
        return true; // `x/mod.rs`
    }
    // `x/**`（`x.rs` から入れ子にした module）。
    file.ancestors().skip(1).any(|dir| test_mods.contains(dir))
}

fn product_hits(root: &Path) -> Vec<(String, Hit)> {
    let mut files = Vec::new();
    for source_root in product_source_roots(root) {
        walk(&source_root, &mut files);
    }
    let scanned: Vec<(PathBuf, Scanned)> = files
        .iter()
        .map(|file| (file.clone(), scan_file(root, file)))
        .collect();
    let test_mods: BTreeSet<PathBuf> = scanned
        .iter()
        .flat_map(|(_, s)| s.out_of_line_test_mods.iter().cloned())
        .collect();
    let mut all = Vec::new();
    for (file, scanned) in &scanned {
        if is_excluded_by_test_mod(file, &test_mods) {
            continue;
        }
        for hit in find_hits(&scanned.code) {
            all.push((scanned.relative.clone(), hit));
        }
    }
    all
}

/// 製品の `[dependencies]` 系 table に rusqlite の `blob` feature が無いこと。
/// `[dev-dependencies]` は試験の道具なので対象外。
fn cargo_blob_feature_hits(root: &Path) -> Vec<String> {
    let mut manifests = vec![
        root.join("src-tauri/Cargo.toml"),
        root.join("electron/native/grimodex-node/Cargo.toml"),
    ];
    for entry in std::fs::read_dir(root.join("src-tauri/crates")).expect("read crates") {
        let manifest = entry.expect("entry").path().join("Cargo.toml");
        if manifest.is_file() {
            manifests.push(manifest);
        }
    }
    let mut hits = Vec::new();
    for manifest in manifests {
        let text = std::fs::read_to_string(&manifest).expect("read manifest");
        let mut section = String::new();
        for (index, line) in text.lines().enumerate() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                section = trimmed.to_string();
                continue;
            }
            let code = trimmed.split('#').next().unwrap_or("");
            if section.contains("dev-dependencies") {
                continue;
            }
            if code.contains("rusqlite") && code.contains("\"blob\"") {
                hits.push(format!("{}:{}: {trimmed}", manifest.display(), index + 1));
            }
            if section.starts_with("[features]") && code.contains("rusqlite/blob") {
                hits.push(format!("{}:{}: {trimmed}", manifest.display(), index + 1));
            }
        }
    }
    hits
}

// ---------------------------------------------------------------------------
// 試験
// ---------------------------------------------------------------------------

#[test]
fn product_source_has_no_forbidden_write_clock_bypass() {
    let root = repo_root();
    let hits = product_hits(&root);
    assert!(
        !hits.is_empty() || !ALLOWLIST.is_empty(),
        "scan found nothing: the walker is probably broken"
    );

    let mut used = vec![0usize; ALLOWLIST.len()];
    let mut violations = Vec::new();
    for (file, hit) in &hits {
        let allowed = ALLOWLIST
            .iter()
            .position(|a| a.file == file && a.rule == hit.rule && hit.text.contains(a.snippet));
        match allowed {
            Some(index) => used[index] += 1,
            None => violations.push(format!(
                "{file}:{}: {}: {}",
                hit.line,
                hit.rule.label(),
                hit.text
            )),
        }
    }
    assert!(
        violations.is_empty(),
        "forbidden write-clock bypass in product source (see the module docs; add to \
         ALLOWLIST with a reason only if it cannot skip the clock triggers):\n{}",
        violations.join("\n")
    );

    let mismatched: Vec<_> = ALLOWLIST
        .iter()
        .zip(&used)
        .filter(|(a, used)| a.count != **used)
        .map(|(a, used)| {
            format!(
                "{} ({}): expected {} use(s), found {used} (stale entry or a new use): {}",
                a.file,
                a.rule.label(),
                a.count,
                a.reason
            )
        })
        .collect();
    assert!(
        mismatched.is_empty(),
        "ALLOWLIST no longer matches the product source:\n{}",
        mismatched.join("\n")
    );
}

#[test]
fn product_manifests_do_not_enable_rusqlite_blob_feature() {
    let hits = cargo_blob_feature_hits(&repo_root());
    assert!(
        hits.is_empty(),
        "rusqlite blob feature in product manifests:\n{}",
        hits.join("\n")
    );
}

// --- 走査器そのものの試験（禁止パターンを実際に検出し、除外が働くこと） ---

fn hits_in(source: &str) -> Vec<(Rule, usize)> {
    let (mut code, structure) = mask(source);
    remove_cfg_test_items(&mut code, &structure);
    find_hits(&code)
        .into_iter()
        .map(|hit| (hit.rule, hit.line))
        .collect()
}

#[test]
fn scanner_detects_each_forbidden_pattern() {
    assert_eq!(
        hits_in(
            "fn f(c: &C) {\n c.set_db_config(DbConfig::SQLITE_DBCONFIG_ENABLE_TRIGGER, false);\n}"
        ),
        vec![(Rule::EnableTrigger, 2)]
    );
    assert_eq!(
        hits_in("let b = conn.blob_open(a, b, c, d, false);"),
        vec![(Rule::BlobIo, 1)]
    );
    assert_eq!(
        hits_in("unsafe { sqlite3_blob_open(db) }"),
        vec![(Rule::BlobIo, 1)]
    );
    assert_eq!(
        hits_in("let b = rusqlite::backup::Backup::new(&a, &mut b)?;"),
        vec![(Rule::BackupNew, 1)]
    );
    assert_eq!(
        hits_in("conn.pragma_update(None, \"writable_schema\", true)?;"),
        vec![(Rule::WritableSchemaOn, 1)]
    );
    assert_eq!(
        hits_in("conn.execute_batch(\"PRAGMA writable_schema = ON; x\")?;"),
        vec![(Rule::WritableSchemaOn, 1)]
    );
    assert_eq!(
        hits_in("c.set_db_config(DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA,\n true)?;"),
        vec![(Rule::WritableSchemaOn, 1)]
    );
    assert_eq!(
        hits_in("conn.pragma_update(None, \"ignore_check_constraints\", true)?;"),
        vec![(Rule::IgnoreCheckConstraintsOn, 1)]
    );
    assert_eq!(
        hits_in("conn.execute_batch(\"PRAGMA ignore_check_constraints = ON;\")?;"),
        vec![(Rule::IgnoreCheckConstraintsOn, 1)]
    );
    assert_eq!(
        hits_in("conn.backup(\"main\", &path, None)?;"),
        vec![(Rule::BackupRestoreCall, 1)]
    );
    assert_eq!(
        hits_in("conn.restore(DatabaseName::Main, &path, None::<fn(Progress)>)?;"),
        vec![(Rule::BackupRestoreCall, 1)]
    );
    assert_eq!(
        hits_in("rusqlite::Connection::backup(&conn, \"main\", p, None)?;"),
        vec![(Rule::BackupRestoreCall, 1)]
    );
}

#[test]
fn scanner_accepts_safe_settings_comments_and_test_code() {
    // 無効にする方向・有効にする方向が逆の設定は通す。
    assert!(hits_in("conn.pragma_update(None, \"writable_schema\", false)?;").is_empty());
    assert!(
        hits_in("c.set_db_config(DbConfig::SQLITE_DBCONFIG_WRITABLE_SCHEMA,\n false)?;").is_empty()
    );
    assert!(hits_in("conn.pragma_update(None, \"ignore_check_constraints\", false)?;").is_empty());
    assert!(hits_in("conn.execute_batch(\"PRAGMA ignore_check_constraints=OFF\")?;").is_empty());
    // `recursive_triggers` は規則ではない（OFF は既定値で、入れ子の TRIGGER は発火する）。
    assert!(hits_in("conn.pragma_update(None, \"recursive_triggers\", false)?;").is_empty());
    // 自前の `restore()`／`backup()` の誤検知はしない。
    assert!(hits_in("guard.restore(conn)?; self.restore()?; state.backup(path)?;").is_empty());
    // コメントと doc comment。
    assert!(hits_in("// ENABLE_TRIGGER and Backup::new are forbidden\n/// blob_open\n/* sqlite3_blob_open */ fn f() {}").is_empty());
    // `#[cfg(test)]` の module／fn と、`any(test, ..)`。
    assert!(hits_in(
        "#[cfg(test)]\nmod tests {\n fn f() { let _ = \"}\"; Backup::new(a, b); }\n}\nfn g() {}"
    )
    .is_empty());
    assert!(
        hits_in("#[cfg(test)]\n#[allow(dead_code)]\nfn f(a: [u8; 3]) { Backup::new(a, b); }")
            .is_empty()
    );
    assert!(hits_in(
        "#[cfg(any(test, feature = \"test-support\"))]\nfn f() { Backup::new(a, b); }"
    )
    .is_empty());
    assert!(hits_in(
        "#[cfg(any(test, feature = \"workspace-maintenance-test-support\"))]\nfn f() { Backup::new(a, b); }"
    )
    .is_empty());
    // test 専用ではない feature は、製品の build で有効になり得るので走査する。
    assert_eq!(
        hits_in("#[cfg(any(test, feature = \"nir1-material-diagnostics\"))]\nfn f() { Backup::new(a, b); }"),
        vec![(Rule::BackupNew, 2)]
    );
    assert_eq!(
        hits_in("#[cfg(any(test, feature = \"test-support\", feature = \"other\"))]\nfn f() { Backup::new(a, b); }"),
        vec![(Rule::BackupNew, 2)]
    );
    assert!(
        hits_in("#[cfg(all(test, feature = \"nir1-material-diagnostics\"))]\nfn f() { Backup::new(a, b); }")
            .is_empty(),
        "all(test, ..) needs `test`, so it is test-only"
    );
    assert_eq!(
        hits_in("#[cfg(all(feature = \"test-support\", unix))]\nfn f() { Backup::new(a, b); }"),
        vec![(Rule::BackupNew, 2)]
    );
    // `not(test)` は製品コード。
    assert_eq!(
        hits_in("#[cfg(not(test))]\nfn f() { Backup::new(a, b); }"),
        vec![(Rule::BackupNew, 2)]
    );
    // test module の後ろの製品コードは検出し続ける（括弧の対応が壊れない）。
    assert_eq!(
        hits_in(
            "#[cfg(test)]\nmod t { fn f() { let s = r#\"}\"#; } }\nfn g() { Backup::new(a, b); }"
        ),
        vec![(Rule::BackupNew, 3)]
    );
}

#[test]
fn scanner_reports_out_of_line_test_modules() {
    let source = "#[cfg(test)]\nmod nir1_packing_tests;\npub(crate) fn real() {}";
    let (mut code, structure) = mask(source);
    let names = remove_cfg_test_items(&mut code, &structure);
    assert_eq!(
        names,
        vec![TestModRef::Name("nir1_packing_tests".to_string())]
    );
    assert!(String::from_utf8_lossy(&code).contains("fn real"));
}

#[test]
fn scanner_reports_path_attribute_test_modules() {
    let source = "#[cfg(test)]\n#[path = \"x_tests.rs\"]\npub(super) mod tests;\nfn real() {}";
    let (mut code, structure) = mask(source);
    let refs = remove_cfg_test_items(&mut code, &structure);
    assert_eq!(refs, vec![TestModRef::Path("x_tests.rs".to_string())]);
}
