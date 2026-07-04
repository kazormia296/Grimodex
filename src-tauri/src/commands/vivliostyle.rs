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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// 実行中プレビュープロセス (singleton)。多重起動時は旧を kill して置換。
    preview: Mutex<Option<PreviewProcess>>,
    /// プレビューの世代カウンタ。「stop/再起動で自分が kill した終了」と
    /// 「ユーザーがプレビューを閉じた自然終了」の race を区別する
    /// (詳細は `vivliostyle_preview_start` の doc コメント)。
    preview_generation: AtomicU64,
    /// stop 到来カウンタ。`kill_preview` (stop / アプリ終了) が bump する。
    /// preview_start は自分の起動前後で epoch が進んでいたら「起動中に stop が
    /// 来た」とみなし自分を kill する — バイナリ解決 await 中の stop は
    /// take_preview で拾えない (エントリ未 store) ための補完。
    preview_stop_epoch: AtomicU64,
    /// run_id → 実行中 build プロセスの pid。アプリ終了時の一括 kill 用
    /// (abort フラグ経由の kill はタスクのポーリング待ちになり、終了時は
    /// ランタイムごと落ちて間に合わないため pid を直接引ける必要がある)。
    run_pids: Mutex<HashMap<String, u32>>,
}

/// 実行中プレビューの管理エントリ。child 本体は wait タスクが所有し、
/// kill は pid ベースでプロセスグループごと行う。
pub(crate) struct PreviewProcess {
    /// 起動ごとに単調増加する世代 ID
    generation: u64,
    /// spawn 直後の pid (取得失敗時 None — kill は no-op になる)
    pid: Option<u32>,
    /// book.html / theme.css を書き出した temp dir
    dir: PathBuf,
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
        if let Ok(mut pids) = self.run_pids.lock() {
            pids.remove(run_id);
        }
    }

    /// 実行中 build の pid を登録する (spawn 直後、アプリ終了時 kill 用)。
    fn register_run_pid(&self, run_id: &str, pid: u32) {
        if let Ok(mut pids) = self.run_pids.lock() {
            pids.insert(run_id.to_string(), pid);
        }
    }

    /// 全 run の abort フラグを立て、登録済み pid を drain して返す
    /// (アプリ終了時の一括 kill 用。drain するので二重 kill しない)。
    fn abort_all_runs_and_drain_pids(&self) -> Vec<u32> {
        if let Ok(runs) = self.runs.lock() {
            for flag in runs.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
        match self.run_pids.lock() {
            Ok(mut pids) => pids.drain().map(|(_, pid)| pid).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// 現在の stop epoch (SeqCst — stop と in-flight start 間の可視性保証)。
    fn preview_stop_epoch(&self) -> u64 {
        self.preview_stop_epoch.load(Ordering::SeqCst)
    }

    fn bump_preview_stop_epoch(&self) {
        self.preview_stop_epoch.fetch_add(1, Ordering::SeqCst);
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

    /// 次のプレビュー世代 ID を払い出す (単調増加)。
    fn next_preview_generation(&self) -> u64 {
        self.preview_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// 新プレビューを登録し、置き換えられた旧エントリ (あれば) を返す。
    /// 呼び出し側は返ってきた旧エントリの kill / temp 掃除に責任を持つ。
    fn store_preview(&self, p: PreviewProcess) -> Option<PreviewProcess> {
        match self.preview.lock() {
            Ok(mut guard) => guard.replace(p),
            Err(_) => None,
        }
    }

    /// プレビューエントリを無条件に引き抜く (stop / 再起動 / アプリ終了用)。
    fn take_preview(&self) -> Option<PreviewProcess> {
        self.preview.lock().ok()?.take()
    }

    /// 世代が一致する場合のみエントリを引き抜く (自然終了ハンドラ用)。
    /// 不一致 = stop/再起動側が既に kill + 掃除済みなので None。
    fn take_preview_if_generation(&self, generation: u64) -> Option<PreviewProcess> {
        let mut guard = self.preview.lock().ok()?;
        match guard.as_ref() {
            Some(p) if p.generation == generation => guard.take(),
            _ => None,
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

/// `vivliostyle:preview-exited` の payload。中身は無いが、`{}` を emit する
/// 固定契約 (camelCase 規約の他イベントと同型) を明示するため空 struct にする。
#[derive(Clone, Serialize)]
struct VivliostylePreviewExitedEvent {}

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

/// `vivliostyle preview book.html` の引数列。
fn preview_vivliostyle_args(input: &str) -> Vec<String> {
    vec!["preview".to_string(), input.to_string()]
}

/// files の name がホワイトリストに載っているか。完全一致のみ許可するので
/// `../x` や絶対パス、サブディレクトリ付きの名前は自動的に拒否される。
fn is_allowed_file_name(name: &str) -> bool {
    ALLOWED_FILE_NAMES.contains(&name)
}

/// build / preview 共通の入力検証。空・ホワイトリスト外・book.html 欠落を拒否。
fn validate_input_files(files: &[VivliostyleFile]) -> anyhow::Result<()> {
    if files.is_empty() {
        anyhow::bail!("ビルド対象ファイルがありません");
    }
    for f in files {
        if !is_allowed_file_name(&f.name) {
            anyhow::bail!(
                "許可されていないファイル名です: {} ({} のみ)",
                f.name,
                ALLOWED_FILE_NAMES.join(" / ")
            );
        }
    }
    if !files.iter().any(|f| f.name == INPUT_FILE_NAME) {
        anyhow::bail!("{INPUT_FILE_NAME} が含まれていません");
    }
    Ok(())
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

/// temp dir を新規作成して files を書き出す (build / preview 共通)。
/// name は `validate_input_files` 検証済みが前提 (join が temp dir 内に閉じる)。
fn write_input_dir(files: &[VivliostyleFile]) -> anyhow::Result<PathBuf> {
    let dir = temp_root().join(Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)
        .map_err(|e| anyhow::anyhow!("temp dir の作成に失敗しました {}: {e}", dir.display()))?;
    for f in files {
        if let Err(e) = std::fs::write(dir.join(&f.name), &f.contents) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(anyhow::anyhow!("{} の書き出しに失敗しました: {e}", f.name));
        }
    }
    Ok(dir)
}

/// バイナリ解決: ユーザー指定 > PATH 検出 (build / preview 共通)。
async fn resolve_vivliostyle_binary(binary_path: Option<String>) -> anyhow::Result<String> {
    match binary_path.filter(|p| !p.trim().is_empty()) {
        Some(p) => Ok(p),
        None => detect_binary_named(VIVLIOSTYLE_BIN_NAME)
            .await
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "vivliostyle CLI が見つかりません。`npm install -g @vivliostyle/cli` \
                 でインストールするか、設定でパスを指定してください"
                )
            }),
    }
}

/// spawn 直前の Command 構築 (build / preview 共通)。
/// stdin null / stdout+stderr piped / Windows は NO_WINDOW / Unix は setsid で
/// 新プロセスグループを切り、kill 時に孫 (Chromium) まで纏めて殺せるようにする。
fn vivliostyle_command(bin: &str, args: &[String], dir: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
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
    cmd
}

/// パイプ詰まり防止の読み捨てタスク (debug ログに relay)。
fn spawn_pipe_drain<R>(reader: R, label: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.is_empty() {
                tracing::debug!("[vivliostyle {label}] {line}");
            }
        }
    });
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
    validate_input_files(&files)?;

    // 新 build 開始時に、save されなかった旧成果物の temp dir を掃除する。
    // (実行中 build の temp dir は outputs 未登録なので影響しない)
    for artifact in state.drain_outputs() {
        let _ = std::fs::remove_dir_all(&artifact.dir);
    }

    let dir = write_input_dir(&files)?;

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
// プレビュー
// ---------------------------------------------------------------------------

/// プレビューを開始する。build と同じ入力ファイル群を temp dir に書き出して
/// `vivliostyle preview book.html` を spawn する (CLI がブラウザを開く)。
/// 多重起動時は旧プレビューをプロセスグループごと kill + temp 掃除してから
/// 新規起動する。
///
/// ## 世代 ID による race 対策
/// 「stop / 再起動で自分が kill した終了」と「ユーザーがプレビューウィンドウ
/// を閉じた自然終了」を区別するため、エントリに単調増加の generation を持たせる:
/// - kill する側 (stop / 再起動 / アプリ終了) は `take_preview()` でエントリを
///   **先に**引き抜いてから kill + temp 掃除する
/// - 自然終了側 (wait タスク) は `take_preview_if_generation(自分の世代)` が
///   Some を返した場合のみ「現役プレビューの自然終了」とみなし、temp 掃除 +
///   `vivliostyle:preview-exited` を emit する
///
/// これで kill 済み旧プロセスの wait 完了が新プレビューの state を壊したり、
/// stop 時に余分な exited イベントを飛ばしたりしない。
#[tauri::command]
pub(crate) async fn vivliostyle_preview_start(
    app_handle: AppHandle,
    state: State<'_, VivliostyleState>,
    files: Vec<VivliostyleFile>,
    binary_path: Option<String>,
) -> AppResult<()> {
    validate_input_files(&files)?;

    // stop epoch を控える。以降の await 中に stop が来たら store 後に検知して
    // 自分を kill する (Important-1: 「stop → in-flight start」race 対策)。
    let stop_epoch = state.preview_stop_epoch();

    // 旧プレビューが居れば kill + temp 掃除。エントリを先に引き抜くので、
    // 旧 wait タスク側は generation 不一致 (エントリ無し) となり二重掃除しない。
    if let Some(prev) = state.take_preview() {
        kill_process_group(prev.pid, libc_sigkill());
        let _ = std::fs::remove_dir_all(&prev.dir);
    }

    // build と違い即 return する必要がない (進捗イベントを待つ相手がいない)
    // ので、バイナリ解決の失敗はこの場で invoke エラーとして返す。
    let bin = resolve_vivliostyle_binary(binary_path).await?;
    let dir = write_input_dir(&files)?;

    let args = preview_vivliostyle_args(INPUT_FILE_NAME);
    let mut child = match vivliostyle_command(&bin, &args, &dir).spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(
                anyhow::anyhow!("vivliostyle preview の起動に失敗しました ({bin}): {e}").into(),
            );
        }
    };
    let pid = child.id();

    // stdout / stderr はパイプ詰まり防止のため読み捨てる (debug ログに relay)。
    if let Some(stdout) = child.stdout.take() {
        spawn_pipe_drain(stdout, "preview stdout");
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_pipe_drain(stderr, "preview stderr");
    }

    let generation = state.next_preview_generation();
    if let Some(evicted) = state.store_preview(PreviewProcess {
        generation,
        pid,
        dir: dir.clone(),
    }) {
        // 同時 start の race で別 start に割り込まれた場合のみ通る
        // (通常は冒頭の take_preview で空になっている)。
        kill_process_group(evicted.pid, libc_sigkill());
        let _ = std::fs::remove_dir_all(&evicted.dir);
    }

    // 終了検知タスク。自然終了のときだけ state 掃除 + exited イベント。
    // kill された場合も child.wait() は返るので、ここが zombie reap を兼ねる。
    // (下の stop-epoch 自殺 kill より先に張る — 早期 return で child を drop
    //  すると reap されず zombie になるため)
    let app_for_wait = app_handle.clone();
    tokio::spawn(async move {
        let _ = child.wait().await;
        let state = app_for_wait.state::<VivliostyleState>();
        if let Some(p) = state.take_preview_if_generation(generation) {
            let _ = std::fs::remove_dir_all(&p.dir);
            let _ = app_for_wait.emit(
                "vivliostyle:preview-exited",
                VivliostylePreviewExitedEvent {},
            );
        }
        // 不一致/エントリ無し = stop / 再起動 / アプリ終了側が掃除済み。reap のみ。
    });

    // 起動中 (バイナリ解決〜spawn の await 中) に stop が来ていたら、その
    // stop はエントリ未 store のため素通りしている (Important-1)。ここで検知
    // して自分を kill し、FE には exited を流して idle に戻す。エントリの
    // 引き抜きは wait タスクと take セマンティクスで排他なので emit は高々1回。
    if state.preview_stop_epoch() != stop_epoch {
        if let Some(p) = state.take_preview_if_generation(generation) {
            kill_process_group(p.pid, libc_sigkill());
            let _ = std::fs::remove_dir_all(&p.dir);
            let _ = app_handle.emit(
                "vivliostyle:preview-exited",
                VivliostylePreviewExitedEvent {},
            );
        }
    }

    Ok(())
}

/// 実行中プレビューを停止する。未実行なら no-op。
#[tauri::command]
pub(crate) fn vivliostyle_preview_stop(state: State<'_, VivliostyleState>) -> AppResult<()> {
    kill_preview(&state);
    Ok(())
}

/// プレビュープロセスをプロセスグループごと kill して temp を掃除する。冪等。
/// stop コマンドとアプリ終了 (lib.rs の RunEvent ハンドラ) の双方から呼ぶ。
///
/// SIGKILL 即殺の理由: プレビューは表示専用で graceful shutdown の必要がなく、
/// 孫の Chromium まで確実に道連れにする方を優先する (Windows は
/// taskkill /T /F 相当なのでもともと強制)。temp 削除はプロセス残存中の
/// ファイルロック (特に Windows) で失敗し得るが、次回起動時の
/// `cleanup_temp_root` が回収するので無視してよい。
pub(crate) fn kill_preview(state: &VivliostyleState) {
    // 先に epoch を bump — バイナリ解決 await 中でエントリ未 store の
    // in-flight start にも「stop が来た」ことを伝える (Important-1 対策)。
    state.bump_preview_stop_epoch();
    if let Some(p) = state.take_preview() {
        kill_process_group(p.pid, libc_sigkill());
        let _ = std::fs::remove_dir_all(&p.dir);
    }
}

/// アプリ終了時の一括 kill: 実行中 build のプロセスグループ + プレビュー。
/// abort フラグ経由では build タスクのポーリング (300ms) を待つことになり、
/// 終了時は tokio ランタイムごと落ちて間に合わないため pid を直接 kill する。
/// temp dir は次回起動時の `cleanup_temp_root` が回収する。冪等。
pub(crate) fn kill_all(state: &VivliostyleState) {
    for pid in state.abort_all_runs_and_drain_pids() {
        kill_process_group(Some(pid), libc_sigkill());
    }
    kill_preview(state);
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
    // バイナリ解決は detect がログインシェル起動を伴い遅いことがあるため、
    // 即 return 後のこのタスク内で行う。
    let bin = resolve_vivliostyle_binary(binary_path).await?;

    let args = build_vivliostyle_args(format, INPUT_FILE_NAME, output_name);
    let mut child = vivliostyle_command(&bin, &args, dir)
        .spawn()
        .map_err(|e| anyhow::anyhow!("vivliostyle の起動に失敗しました ({bin}): {e}"))?;
    let pid = child.id();
    // アプリ終了時の一括 kill (kill_all) 用に pid を登録する。
    // 対応する削除は run_build_task 側の remove_run (pid も落とす)。
    if let Some(pid) = pid {
        app.state::<VivliostyleState>()
            .register_run_pid(run_id, pid);
    }

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
mod preview_vivliostyle_args_tests {
    use super::preview_vivliostyle_args;

    #[test]
    fn preview_args_in_order() {
        assert_eq!(
            preview_vivliostyle_args("book.html"),
            vec!["preview", "book.html"]
        );
    }
}

#[cfg(test)]
mod validate_input_files_tests {
    use super::{validate_input_files, VivliostyleFile};

    fn file(name: &str) -> VivliostyleFile {
        VivliostyleFile {
            name: name.to_string(),
            contents: String::new(),
        }
    }

    #[test]
    fn accepts_html_and_css() {
        assert!(validate_input_files(&[file("book.html"), file("theme.css")]).is_ok());
        assert!(validate_input_files(&[file("book.html")]).is_ok());
    }

    #[test]
    fn rejects_empty_files() {
        assert!(validate_input_files(&[]).is_err());
    }

    #[test]
    fn rejects_unlisted_names() {
        assert!(validate_input_files(&[file("book.html"), file("../x")]).is_err());
        assert!(validate_input_files(&[file("book.html"), file("evil.js")]).is_err());
    }

    #[test]
    fn rejects_missing_entrypoint() {
        assert!(validate_input_files(&[file("theme.css")]).is_err());
    }
}

#[cfg(test)]
mod preview_state_tests {
    use super::{PreviewProcess, VivliostyleState};
    use std::path::PathBuf;

    fn process(generation: u64) -> PreviewProcess {
        PreviewProcess {
            generation,
            pid: Some(1000 + generation as u32),
            dir: PathBuf::from(format!("/tmp/viv-preview/{generation}")),
        }
    }

    #[test]
    fn generation_is_monotonic() {
        let state = VivliostyleState::default();
        let g1 = state.next_preview_generation();
        let g2 = state.next_preview_generation();
        assert!(g2 > g1);
    }

    #[test]
    fn store_preview_returns_evicted_entry() {
        let state = VivliostyleState::default();
        assert!(state.store_preview(process(1)).is_none());
        let evicted = state.store_preview(process(2));
        assert_eq!(evicted.map(|p| p.generation), Some(1));
    }

    #[test]
    fn take_preview_consumes_entry() {
        let state = VivliostyleState::default();
        state.store_preview(process(1));
        assert_eq!(state.take_preview().map(|p| p.generation), Some(1));
        assert!(state.take_preview().is_none());
    }

    #[test]
    fn take_preview_if_generation_only_matches_current() {
        let state = VivliostyleState::default();
        state.store_preview(process(2));
        // 旧世代 (kill 済み) の wait タスクは引き抜けない
        assert!(state.take_preview_if_generation(1).is_none());
        assert_eq!(
            state.take_preview_if_generation(2).map(|p| p.generation),
            Some(2)
        );
        // 引き抜き済みなら同世代でも None (二重掃除しない)
        assert!(state.take_preview_if_generation(2).is_none());
    }

    // 敵対レビュー Important-1: 「stop → in-flight start」race。
    // start はエントリ時点の stop epoch を控え、store 後に epoch が進んで
    // いたら (= 起動中に stop が来た) 自分を kill する。
    #[test]
    fn stop_epoch_detects_stop_during_inflight_start() {
        let state = VivliostyleState::default();
        let epoch = state.preview_stop_epoch();
        // start がバイナリ解決 await 中に stop が来る
        kill_and_bump(&state);
        // store は成功するが epoch 差分で stop 到来を検知できる
        state.store_preview(process(1));
        assert_ne!(state.preview_stop_epoch(), epoch);
        // 検知後は自世代エントリを引き抜いて自殺 kill する
        assert!(state.take_preview_if_generation(1).is_some());
    }

    #[test]
    fn stop_epoch_unchanged_without_stop() {
        let state = VivliostyleState::default();
        let epoch = state.preview_stop_epoch();
        state.store_preview(process(1));
        assert_eq!(state.preview_stop_epoch(), epoch);
    }

    fn kill_and_bump(state: &VivliostyleState) {
        super::kill_preview(state);
    }
}

#[cfg(test)]
mod exit_kill_all_tests {
    use super::VivliostyleState;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    // 敵対レビュー Important-2: アプリ終了時は preview だけでなく実行中 build
    // もプロセスグループごと kill する。state レベルでは「全 run の abort
    // フラグが立ち、登録済み pid が全て drain される」ことを固定する。
    #[test]
    fn kill_all_runs_sets_abort_flags_and_drains_pids() {
        let state = VivliostyleState::default();
        let flag = Arc::new(AtomicBool::new(false));
        state.register_run("r1", Arc::clone(&flag));
        state.register_run_pid("r1", 12345);

        let pids = state.abort_all_runs_and_drain_pids();
        assert!(flag.load(Ordering::Relaxed));
        assert_eq!(pids, vec![12345]);
        // drain 済みなので二回目は空 (二重 kill しない)
        assert!(state.abort_all_runs_and_drain_pids().is_empty());
    }

    #[test]
    fn remove_run_also_drops_pid() {
        let state = VivliostyleState::default();
        state.register_run("r1", Arc::new(AtomicBool::new(false)));
        state.register_run_pid("r1", 111);
        state.remove_run("r1");
        assert!(state.abort_all_runs_and_drain_pids().is_empty());
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
