//! Import 用のファイル / フォルダ読み込みコマンド。
//!
//! **設計 (security audit PIO-2 徹底案 / finding #5)**: 選択ダイアログを
//! **Rust 側で開いてその場で読み込む**。renderer はフィルタ条件のみ渡し、
//! 読み込み先パスを一切渡さない。export.rs (`prompt_save_path` /
//! `export_save_text`) の保存フローと完全に対称。これにより:
//!   - renderer に `fs:read` capability を与えなくてよい（Tauri v2 の
//!     deny-by-default を維持。`fs:allow-read-*` は空 scope で機能せず、
//!     scope を $HOME/** 等に広げると無制限の任意読み取りプリミティブが
//!     復活してしまうため使わない）。
//!   - 侵害された renderer は（ユーザーに見える）選択ダイアログを出せる
//!     だけで、任意パスの silent な読み取りはできない（パスはダイアログ
//!     由来の user-chosen path に限られる）。
//!
//! renderer がパス文字列を渡す read コマンドにしてはならない。それ自体が
//! 無制限の任意読み取りプリミティブになり、scope 縮小より退行する
//! （export.rs ヘッダの警告と同じ趣旨）。

use serde::Serialize;
use tauri_plugin_dialog::DialogExt;

use super::AppError;

/// markdownFolderReader.ts (`MAX_FOLDER_DEPTH`) と同じ深さ上限。病的な木で
/// スタックを溢れさせないためのハードキャップ。
const MAX_FOLDER_DEPTH: usize = 64;

/// `import_open_text_file` の戻り値。JSON キーは TS 側 `OpenTextResult`
/// (src/lib/importFile.ts) と対（camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenTextResult {
    /// 拡張子込みのファイル名（ディレクトリは含まない）。
    name: String,
    content: String,
}

/// `import_pick_folder_markdown` が返す 1 ファイル分。JSON キーは TS 側
/// `CollectedFile` (src/features/import/markdownFolderReader.ts) と対。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CollectedFile {
    /// 選択フォルダを基準にした相対パス（区切りは常に `/`）。
    rel_path: String,
    content: String,
}

/// ネイティブのファイル選択ダイアログを Rust 側で開き、選んだ単一テキスト
/// ファイルを読み込んで返す。キャンセル時は `Ok(None)`。
///
/// 保存ダイアログを開いている間 invoke がブロックするため、フロント側は
/// `SLOW_COMMANDS` (src/lib/tauri.ts) に登録して IPC タイムアウトを延ばす。
#[tauri::command]
pub(crate) fn import_open_text_file(
    app: tauri::AppHandle,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenTextResult>, AppError> {
    let ext_refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let Some(picked) = app
        .dialog()
        .file()
        .add_filter(filter_name.as_str(), &ext_refs)
        .blocking_pick_file()
        .and_then(|fp| fp.into_path().ok())
    else {
        return Ok(None);
    };
    let name = picked
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| picked.to_string_lossy().into_owned());
    let content = std::fs::read_to_string(&picked)
        .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", picked.display()))?;
    Ok(Some(OpenTextResult { name, content }))
}

/// ネイティブのフォルダ選択ダイアログを Rust 側で開き、選んだフォルダ配下の
/// `.md` / `.markdown` を再帰収集して返す。キャンセル時は `Ok(None)`。
#[tauri::command]
pub(crate) fn import_pick_folder_markdown(
    app: tauri::AppHandle,
) -> Result<Option<Vec<CollectedFile>>, AppError> {
    let Some(dir) = app
        .dialog()
        .file()
        .blocking_pick_folder()
        .and_then(|fp| fp.into_path().ok())
    else {
        return Ok(None);
    };
    let mut out = Vec::new();
    collect_markdown_from_dir(&dir, &dir, 0, &mut out)?;
    Ok(Some(out))
}

/// `name` が `.md` / `.markdown` で終わるか（markdownFolderReader.ts と同じ
/// 大文字小文字を区別する判定）。
fn is_markdown_name(name: &std::ffi::OsStr) -> bool {
    let name = name.to_string_lossy();
    name.ends_with(".md") || name.ends_with(".markdown")
}

/// `dir` 配下を再帰的に歩いて `.md` / `.markdown` を `out` に収集する。
///
/// markdownFolderReader.ts の `collectMarkdownFromDir` と同じ安全境界を守る:
///   - 深さ上限 `MAX_FOLDER_DEPTH`（病的な木でのスタック溢れ防止）。
///   - シンボリックリンクは辿らない（サイクル `a -> ../` 回避 & 選択フォルダ
///     外への漏出防止。src-tauri/src/external_mount/scan.rs と同方針）。
///
/// `base` は相対パス算出の基準（＝ユーザーが選択したフォルダのルート）。
fn collect_markdown_from_dir(
    dir: &std::path::Path,
    base: &std::path::Path,
    depth: usize,
    out: &mut Vec<CollectedFile>,
) -> anyhow::Result<()> {
    if depth > MAX_FOLDER_DEPTH {
        anyhow::bail!(
            "directory depth exceeded {MAX_FOLDER_DEPTH} at {}",
            dir.display()
        );
    }
    let entries = std::fs::read_dir(dir)
        .map_err(|e| anyhow::anyhow!("failed to read dir {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry
            .map_err(|e| anyhow::anyhow!("failed to read entry in {}: {e}", dir.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| anyhow::anyhow!("failed to stat {}: {e}", entry.path().display()))?;
        // scan.rs / markdownFolderReader.ts と同じく symlink は辿らない。
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            collect_markdown_from_dir(&path, base, depth + 1, out)?;
        } else if is_markdown_name(&entry.file_name()) {
            let content = std::fs::read_to_string(&path)
                .map_err(|e| anyhow::anyhow!("failed to read {}: {e}", path.display()))?;
            // TS 側は常に `/` 区切りの相対パスを作るので、native separator を
            // `/` に正規化して parseMarkdownMulti の想定と揃える。
            let rel_path = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(CollectedFile { rel_path, content });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// テスト用のユニークな temp サブディレクトリを作る（tempfile 依存を
    /// 増やさないため std のみで実装）。
    fn unique_temp_dir() -> std::path::PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("grimodex_import_fs_test_{nanos}_{n}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(path: &std::path::Path, contents: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create parent");
        }
        std::fs::write(path, contents).expect("write file");
    }

    #[test]
    fn collects_markdown_recursively_and_skips_non_markdown() {
        let root = unique_temp_dir();
        write(&root.join("a.md"), "A");
        write(&root.join("note.txt"), "ignored");
        write(&root.join("sub/b.markdown"), "B");
        write(&root.join("sub/deep/c.md"), "C");
        write(&root.join("sub/readme.rst"), "ignored too");

        let mut out = Vec::new();
        collect_markdown_from_dir(&root, &root, 0, &mut out).expect("walk ok");

        let mut got: Vec<(String, String)> = out
            .into_iter()
            .map(|f| (f.rel_path, f.content))
            .collect();
        got.sort();

        assert_eq!(
            got,
            vec![
                ("a.md".to_string(), "A".to_string()),
                ("sub/b.markdown".to_string(), "B".to_string()),
                ("sub/deep/c.md".to_string(), "C".to_string()),
            ]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rel_path_is_relative_to_the_picked_base() {
        let root = unique_temp_dir();
        write(&root.join("chapters/01/scene.md"), "hi");

        let mut out = Vec::new();
        collect_markdown_from_dir(&root, &root, 0, &mut out).expect("walk ok");

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].rel_path, "chapters/01/scene.md");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn depth_cap_is_enforced() {
        let root = unique_temp_dir();
        let mut out = Vec::new();
        // depth == MAX + 1 で即エラー（実 IO 前にガードされること）。
        let err = collect_markdown_from_dir(&root, &root, MAX_FOLDER_DEPTH + 1, &mut out)
            .expect_err("depth cap should trip");
        assert!(err.to_string().contains("directory depth exceeded"));

        let _ = std::fs::remove_dir_all(&root);
    }
}
