//! Vivliostyle CLI 連携コマンド群。
//!
//! フロントが組版用 HTML/CSS (`book.html` / `theme.css`) を渡し、Rust 側が
//! temp dir に書き出して `vivliostyle build` を実行、PDF / EPUB を生成する。
//!
//! 実行フロー (post_effect.rs と同型の fire-and-forget):
//!   `vivliostyle_build` → 即 run_id 返却
//!     → tokio::spawn したタスクが CLI を実行し
//!       `vivliostyle:log` / `vivliostyle:done` / `vivliostyle:error` を emit
//!   `vivliostyle_save_output` → 保存ダイアログ経由で成果物をユーザー選択先へコピー
//!
//! セキュリティ:
//! - `files[].name` は `book.html` / `theme.css` のホワイトリストのみ許可。
//!   パス区切りを含む名前は temp dir 外への書き込みプリミティブになるため
//!   ホワイトリスト自体で遮断する（連結前に検証）。
//! - 保存は export.rs と同じ「Rust 側ダイアログ → user-chosen path」方式。
//!   renderer は保存先パスを渡せない (PIO-2 徹底案と同じ理由)。
//!
//! temp dir のライフサイクル:
//! - `std::env::temp_dir()/grimodex-vivliostyle/<uuid>` に build ごとに作成。
//! - 成功時は save までディレクトリを残す（`outputs` レジストリで追跡）。
//! - save 完了 or 次の build 開始時に旧 temp を削除。abort / エラー時は即削除。
//! - アプリ起動時に `grimodex-vivliostyle/` 配下を一括掃除 (`cleanup_temp_root`)。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use uuid::Uuid;

use super::AppResult;
use crate::cli_provider::{
    detect_binary_named, kill_process_group, libc_sigkill, libc_sigterm, test_binary,
};

/// PATH 上で探すバイナリ名。
const VIVLIOSTYLE_BIN_NAME: &str = "vivliostyle";

/// temp dir に書き出しを許可するファイル名 (ホワイトリスト)。
const ALLOWED_FILE_NAMES: &[&str] = &["book.html", "theme.css"];

/// ビルド入力のエントリポイント。files に必ず含まれていること。
const INPUT_FILE_NAME: &str = "book.html";

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

/// 実行中 run と save 待ち成果物のレジストリ。lib.rs で `.manage()` される。
#[derive(Default)]
pub(crate) struct VivliostyleState {
    /// run_id → abort フラグ (post_effect の AbortFlag 管理と同型だが run 単位)
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// output_token → save 待ち成果物
    outputs: Mutex<HashMap<String, OutputArtifact>>,
}

/// save 待ちの成果物。`dir` ごと temp に残っており、save 完了 or
/// 次 build 開始時に `dir` を削除する。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OutputArtifact {
    /// 成果物ファイル (temp dir 内の output.pdf / output.epub)
    file: PathBuf,
    /// 成果物を含む temp dir
    dir: PathBuf,
}

impl VivliostyleState {
    fn register_run(&self, run_id: &str, flag: Arc<AtomicBool>) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.insert(run_id.to_string(), flag);
        }
    }

    fn remove_run(&self, run_id: &str) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(run_id);
        }
    }

    /// abort フラグを立てる。run_id が未知 (終了済み等) なら false。
    fn request_abort(&self, run_id: &str) -> bool {
        match self.runs.lock() {
            Ok(runs) => match runs.get(run_id) {
                Some(flag) => {
                    flag.store(true, Ordering::Relaxed);
                    true
                }
                None => false,
            },
            Err(_) => false,
        }
    }

    fn register_output(&self, token: &str, artifact: OutputArtifact) {
        if let Ok(mut outputs) = self.outputs.lock() {
            outputs.insert(token.to_string(), artifact);
        }
    }

    /// token を消費せずに参照する (保存ダイアログのキャンセル時に再試行可能に保つ)。
    fn peek_output(&self, token: &str) -> Option<OutputArtifact> {
        self.outputs.lock().ok()?.get(token).cloned()
    }

    /// token を消費する (save 完了時)。
    fn remove_output(&self, token: &str) -> Option<OutputArtifact> {
        self.outputs.lock().ok()?.remove(token)
    }

    /// save されなかった成果物を全部取り出す (次 build 開始時の掃除用)。
    fn drain_outputs(&self) -> Vec<OutputArtifact> {
        match self.outputs.lock() {
            Ok(mut outputs) => outputs.drain().map(|(_, a)| a).collect(),
            Err(_) => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// IPC 型 / イベント payload (フィールド名は camelCase — FE と共有の固定契約)
// ---------------------------------------------------------------------------

/// `vivliostyle_detect` の結果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VivliostyleCliInfo {
    path: String,
    version: String,
}

/// `vivliostyle_build` に渡す入力ファイル。
#[derive(Deserialize)]
pub(crate) struct VivliostyleFile {
    name: String,
    contents: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VivliostyleLogEvent {
    run_id: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VivliostyleDoneEvent {
    run_id: String,
    output_token: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VivliostyleErrorEvent {
    run_id: String,
    message: String,
}

fn emit_log(app: &AppHandle, run_id: &str, line: String) {
    let _ = app.emit(
        "vivliostyle:log",
        VivliostyleLogEvent {
            run_id: run_id.to_string(),
            line,
        },
    );
}

fn emit_error(app: &AppHandle, run_id: &str, message: String) {
    let _ = app.emit(
        "vivliostyle:error",
        VivliostyleErrorEvent {
            run_id: run_id.to_string(),
            message,
        },
    );
}

// ---------------------------------------------------------------------------
// 純関数 (テスト対象)
// ---------------------------------------------------------------------------

/// `vivliostyle build book.html -f <format> -o output.pdf|output.epub` の引数列。
fn build_vivliostyle_args(format: &str, input: &str, output: &str) -> Vec<String> {
    vec![
        "build".to_string(),
        input.to_string(),
        "-f".to_string(),
        format.to_string(),
        "-o".to_string(),
        output.to_string(),
    ]
}

/// files の name がホワイトリストに載っているか。完全一致のみ許可するので
/// `../x` や絶対パス、サブディレクトリ付きの名前は自動的に拒否される。
fn is_allowed_file_name(name: &str) -> bool {
    ALLOWED_FILE_NAMES.contains(&name)
}

/// format ("pdf" | "epub") に対応する成果物ファイル名。未知 format は None。
fn output_file_name(format: &str) -> Option<&'static str> {
    match format {
        "pdf" => Some("output.pdf"),
        "epub" => Some("output.epub"),
        _ => None,
    }
}

/// temp dir のルート。build ごとに `<root>/<uuid>` を切る。
fn temp_root() -> PathBuf {
    std::env::temp_dir().join("grimodex-vivliostyle")
}

/// アプリ起動時に呼ぶ一括掃除 (lib.rs setup から spawn_blocking で)。
/// 前回セッションで save されずに残った成果物 temp dir を削除する。
pub(crate) fn cleanup_temp_root() {
    let _ = std::fs::remove_dir_all(temp_root());
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// PATH 等から vivliostyle CLI を検出し `--version` で起動確認する。
/// `binary_path` (ユーザー指定) があれば PATH 解決より優先。
/// 見つからない / 起動確認に失敗した場合は None (エラーにはしない)。
#[tauri::command]
pub(crate) async fn vivliostyle_detect(
    binary_path: Option<String>,
) -> AppResult<Option<VivliostyleCliInfo>> {
    let path = match binary_path.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => match detect_binary_named(VIVLIOSTYLE_BIN_NAME).await {
            Some(p) => p,
            None => return Ok(None),
        },
    };
    match test_binary(&path).await {
        Ok(version) => Ok(Some(VivliostyleCliInfo { path, version })),
        Err(e) => {
            tracing::warn!("[vivliostyle] --version 起動確認に失敗: {path}: {e}");
            Ok(None)
        }
    }
}

/// ビルドを開始し、即 run_id を返す (fire-and-forget)。
/// 進捗・完了は `vivliostyle:log` / `vivliostyle:done` / `vivliostyle:error` で通知。
#[tauri::command]
pub(crate) async fn vivliostyle_build(
    app_handle: AppHandle,
    state: State<'_, VivliostyleState>,
    files: Vec<VivliostyleFile>,
    format: String,
    binary_path: Option<String>,
) -> AppResult<String> {
    let output_name = output_file_name(&format)
        .ok_or_else(|| anyhow::anyhow!("未対応の出力形式です: {format} (pdf | epub のみ)"))?;
    if files.is_empty() {
        return Err(anyhow::anyhow!("ビルド対象ファイルがありません").into());
    }
    for f in &files {
        if !is_allowed_file_name(&f.name) {
            return Err(anyhow::anyhow!(
                "許可されていないファイル名です: {} ({} のみ)",
                f.name,
                ALLOWED_FILE_NAMES.join(" / ")
            )
            .into());
        }
    }
    if !files.iter().any(|f| f.name == INPUT_FILE_NAME) {
        return Err(anyhow::anyhow!("{INPUT_FILE_NAME} が含まれていません").into());
    }

    // 新 build 開始時に、save されなかった旧成果物の temp dir を掃除する。
    // (実行中 build の temp dir は outputs 未登録なので影響しない)
    for artifact in state.drain_outputs() {
        let _ = std::fs::remove_dir_all(&artifact.dir);
    }

    let dir = temp_root().join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("temp dir の作成に失敗しました {}: {e}", dir.display()))?;
    for f in &files {
        // name はホワイトリスト検証済みなので join は temp dir 内に閉じる
        std::fs::write(dir.join(&f.name), &f.contents)
            .map_err(|e| anyhow::anyhow!("{} の書き出しに失敗しました: {e}", f.name))?;
    }

    let run_id = Uuid::new_v4().to_string();
    let abort = Arc::new(AtomicBool::new(false));
    state.register_run(&run_id, Arc::clone(&abort));

    let app = app_handle.clone();
    let rid = run_id.clone();
    let out_name = output_name.to_string();
    tokio::spawn(async move {
        run_build_task(app, rid, dir, format, out_name, binary_path, abort).await;
    });

    Ok(run_id)
}

/// 実行中ビルドの中断を要求する。run_id が未知 (終了済み) なら no-op。
#[tauri::command]
pub(crate) fn vivliostyle_abort_build(
    state: State<'_, VivliostyleState>,
    run_id: String,
) -> AppResult<()> {
    if !state.request_abort(&run_id) {
        tracing::debug!("[vivliostyle] abort 対象の run が見つかりません: {run_id}");
    }
    Ok(())
}

/// temp の成果物を保存ダイアログ経由でユーザー選択先へコピーする。
/// キャンセル時は None (token は消費せず再試行可能)。保存完了で token を
/// 消費し temp dir を削除する。
///
/// export.rs と同じく sync command + `blocking_save_file` (renderer に
/// 保存先パスを渡させない流儀)。
#[tauri::command]
pub(crate) fn vivliostyle_save_output(
    app: AppHandle,
    state: State<'_, VivliostyleState>,
    output_token: String,
) -> AppResult<Option<String>> {
    let artifact = state.peek_output(&output_token).ok_or_else(|| {
        anyhow::anyhow!("成果物が見つかりません (期限切れの可能性があります。再ビルドしてください)")
    })?;
    let ext = artifact
        .file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("pdf")
        .to_string();
    let (filter_name, suggested_name) = match ext.as_str() {
        "epub" => ("EPUB", "book.epub"),
        _ => ("PDF", "book.pdf"),
    };
    let Some(dest) = super::export::prompt_save_path(&app, suggested_name, filter_name, &[ext])
    else {
        return Ok(None);
    };
    std::fs::copy(&artifact.file, &dest).map_err(|e| {
        anyhow::anyhow!(
            "成果物のコピーに失敗しました {} → {}: {e}",
            artifact.file.display(),
            dest.display()
        )
    })?;
    // 保存完了: token を消費し temp dir を削除
    if let Some(consumed) = state.remove_output(&output_token) {
        let _ = std::fs::remove_dir_all(&consumed.dir);
    }
    Ok(Some(dest.to_string_lossy().into_owned()))
}

// ---------------------------------------------------------------------------
// ビルドタスク本体
// ---------------------------------------------------------------------------

async fn run_build_task(
    app: AppHandle,
    run_id: String,
    dir: PathBuf,
    format: String,
    output_name: String,
    binary_path: Option<String>,
    abort: Arc<AtomicBool>,
) {
    let result = run_build_inner(
        &app,
        &run_id,
        &dir,
        &format,
        &output_name,
        binary_path,
        &abort,
    )
    .await;
    let state = app.state::<VivliostyleState>();
    state.remove_run(&run_id);
    match result {
        Ok(Some(output_file)) => {
            let token = Uuid::new_v4().to_string();
            state.register_output(
                &token,
                OutputArtifact {
                    file: output_file,
                    dir,
                },
            );
            let _ = app.emit(
                "vivliostyle:done",
                VivliostyleDoneEvent {
                    run_id: run_id.clone(),
                    output_token: token,
                },
            );
        }
        Ok(None) => {
            // ユーザー abort。成果物は無いので temp dir を即削除。
            let _ = std::fs::remove_dir_all(&dir);
            emit_error(&app, &run_id, "ビルドを中断しました".to_string());
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            tracing::warn!("[vivliostyle] build 失敗 run_id={run_id}: {e}");
            emit_error(&app, &run_id, e.to_string());
        }
    }
}

/// ビルド実行。Ok(Some(成果物パス)) = 成功 / Ok(None) = abort / Err = 失敗。
async fn run_build_inner(
    app: &AppHandle,
    run_id: &str,
    dir: &Path,
    format: &str,
    output_name: &str,
    binary_path: Option<String>,
    abort: &Arc<AtomicBool>,
) -> anyhow::Result<Option<PathBuf>> {
    // バイナリ解決: ユーザー指定 > PATH 検出。detect はログインシェル起動を
    // 伴い遅いことがあるため、即 return 後のこのタスク内で行う。
    let bin = match binary_path.filter(|p| !p.trim().is_empty()) {
        Some(p) => p,
        None => detect_binary_named(VIVLIOSTYLE_BIN_NAME)
            .await
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "vivliostyle CLI が見つかりません。`npm install -g @vivliostyle/cli` \
                 でインストールするか、設定でパスを指定してください"
                )
            })?,
    };

    let args = build_vivliostyle_args(format, INPUT_FILE_NAME, output_name);
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(&args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子プロセスの孫プロセス対策 (cli_provider::build_command と同じ流儀):
    // Unix では新しいプロセスグループを切って abort 時に -pgid で纏めて殺す。
    #[cfg(unix)]
    {
        // Safety: pre_exec は spawn 後 fork した子で同期実行される。
        // setsid() は signal-safe で副作用なし。
        unsafe {
            cmd.pre_exec(|| {
                let _ = libc::setsid();
                Ok(())
            });
        }
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow::anyhow!("vivliostyle の起動に失敗しました ({bin}): {e}"))?;
    let pid = child.id();

    // stderr は別タスクで読む (読まないとパイプ詰まりで子がブロックする)。
    // vivliostyle は進捗をほぼ stderr に出すのでログとして relay する。
    if let Some(stderr) = child.stderr.take() {
        let app_for_stderr = app.clone();
        let rid = run_id.to_string();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.is_empty() {
                    emit_log(&app_for_stderr, &rid, line);
                }
            }
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("vivliostyle の stdout が取得できません"))?;
    let mut lines = BufReader::new(stdout).lines();

    let mut aborted = false;
    loop {
        if abort.load(Ordering::Relaxed) {
            kill_process_group(pid, libc_sigterm());
            aborted = true;
            break;
        }
        // 行が長時間来なくても abort を確認できるよう timeout でポーリングする。
        // (Lines::next_line は cancel safe なので timeout drop で行を失わない)
        match tokio::time::timeout(std::time::Duration::from_millis(300), lines.next_line()).await {
            Err(_) => continue, // timeout → abort 再確認
            Ok(Ok(Some(line))) => {
                if !line.is_empty() {
                    emit_log(app, run_id, line);
                }
            }
            Ok(Ok(None)) => break, // EOF
            Ok(Err(e)) => {
                kill_process_group(pid, libc_sigkill());
                let _ = child.wait().await;
                return Err(anyhow::anyhow!(
                    "vivliostyle 出力の読み取りに失敗しました: {e}"
                ));
            }
        }
    }

    if aborted {
        // SIGTERM 送信済み。2 秒以内に終了しなければ SIGKILL へエスカレート。
        match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                kill_process_group(pid, libc_sigkill());
                let _ = child.wait().await;
            }
        }
        return Ok(None);
    }

    let status = child
        .wait()
        .await
        .map_err(|e| anyhow::anyhow!("vivliostyle の終了待ちに失敗しました: {e}"))?;
    if !status.success() {
        anyhow::bail!("vivliostyle build が異常終了しました ({status})");
    }
    let output_file = dir.join(output_name);
    if !output_file.is_file() {
        anyhow::bail!("成果物 {output_name} が生成されませんでした");
    }
    Ok(Some(output_file))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod build_vivliostyle_args_tests {
    use super::build_vivliostyle_args;

    #[test]
    fn pdf_args_in_order() {
        assert_eq!(
            build_vivliostyle_args("pdf", "book.html", "output.pdf"),
            vec!["build", "book.html", "-f", "pdf", "-o", "output.pdf"]
        );
    }

    #[test]
    fn epub_args_in_order() {
        assert_eq!(
            build_vivliostyle_args("epub", "book.html", "output.epub"),
            vec!["build", "book.html", "-f", "epub", "-o", "output.epub"]
        );
    }
}

#[cfg(test)]
mod file_name_whitelist_tests {
    use super::is_allowed_file_name;

    #[test]
    fn accepts_whitelisted_names() {
        assert!(is_allowed_file_name("book.html"));
        assert!(is_allowed_file_name("theme.css"));
    }

    #[test]
    fn rejects_path_traversal() {
        assert!(!is_allowed_file_name("../x"));
        assert!(!is_allowed_file_name("../../etc/passwd"));
        assert!(!is_allowed_file_name("sub/book.html"));
        assert!(!is_allowed_file_name("..\\x"));
    }

    #[test]
    fn rejects_absolute_paths() {
        assert!(!is_allowed_file_name("/etc/passwd"));
        assert!(!is_allowed_file_name("C:\\Windows\\book.html"));
    }

    #[test]
    fn rejects_unlisted_names() {
        assert!(!is_allowed_file_name("foo.txt"));
        assert!(!is_allowed_file_name("book.htm"));
        assert!(!is_allowed_file_name(""));
        // 大文字違いも拒否 (完全一致のみ)
        assert!(!is_allowed_file_name("Book.html"));
    }
}

#[cfg(test)]
mod output_file_name_tests {
    use super::output_file_name;

    #[test]
    fn maps_known_formats() {
        assert_eq!(output_file_name("pdf"), Some("output.pdf"));
        assert_eq!(output_file_name("epub"), Some("output.epub"));
    }

    #[test]
    fn rejects_unknown_formats() {
        assert_eq!(output_file_name("html"), None);
        assert_eq!(output_file_name(""), None);
        assert_eq!(output_file_name("PDF"), None);
    }
}

#[cfg(test)]
mod output_token_registry_tests {
    use super::{OutputArtifact, VivliostyleState};
    use std::path::PathBuf;

    fn artifact(n: u32) -> OutputArtifact {
        OutputArtifact {
            file: PathBuf::from(format!("/tmp/viv/{n}/output.pdf")),
            dir: PathBuf::from(format!("/tmp/viv/{n}")),
        }
    }

    #[test]
    fn register_then_peek_returns_artifact_without_consuming() {
        let state = VivliostyleState::default();
        state.register_output("tok-1", artifact(1));
        assert_eq!(state.peek_output("tok-1"), Some(artifact(1)));
        // peek は消費しない (保存ダイアログキャンセル後の再試行を許す)
        assert_eq!(state.peek_output("tok-1"), Some(artifact(1)));
    }

    #[test]
    fn remove_consumes_token() {
        let state = VivliostyleState::default();
        state.register_output("tok-1", artifact(1));
        assert_eq!(state.remove_output("tok-1"), Some(artifact(1)));
        assert_eq!(state.peek_output("tok-1"), None);
        assert_eq!(state.remove_output("tok-1"), None);
    }

    #[test]
    fn unknown_token_returns_none() {
        let state = VivliostyleState::default();
        assert_eq!(state.peek_output("ghost"), None);
        assert_eq!(state.remove_output("ghost"), None);
    }

    #[test]
    fn drain_outputs_empties_registry() {
        let state = VivliostyleState::default();
        state.register_output("tok-1", artifact(1));
        state.register_output("tok-2", artifact(2));
        let drained = state.drain_outputs();
        assert_eq!(drained.len(), 2);
        assert_eq!(state.peek_output("tok-1"), None);
        assert_eq!(state.peek_output("tok-2"), None);
        assert!(state.drain_outputs().is_empty());
    }

    #[test]
    fn abort_request_only_hits_registered_runs() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let state = VivliostyleState::default();
        let flag = Arc::new(AtomicBool::new(false));
        state.register_run("run-1", Arc::clone(&flag));

        assert!(!state.request_abort("ghost-run"));
        assert!(!flag.load(Ordering::Relaxed));

        assert!(state.request_abort("run-1"));
        assert!(flag.load(Ordering::Relaxed));

        state.remove_run("run-1");
        assert!(!state.request_abort("run-1"));
    }
}
