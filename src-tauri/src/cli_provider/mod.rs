//! CLI エージェント (Claude Code / Codex CLI / OpenCode) を Chat バックエンドとして
//! 流用するためのレイヤ。
//!
//! 設計書 §CLI プロバイダ（サブスクリプション流用） に従い、目的を「サブスク
//! (Claude Pro / ChatGPT Plus 等) 流用による API コスト削減」に限定する。
//! 各 CLI の起動オプションでツール (ファイル R/W / shell / WebSearch) を全 OFF
//! にして、実質「テキスト応答だけを返す HTTP API」相当に縛る。
//!
//! Phase C.1: Claude Code の NDJSON parser のみ実装。Codex / OpenCode は
//! Phase C.2 で追加予定 (現在は detect_binary のみ対応)。

pub mod adapter;

use serde::{Deserialize, Serialize};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// CLI 種別。フロントエンドから文字列で渡される。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CliKind {
    Claude,
    Codex,
    Opencode,
}

impl CliKind {
    /// PATH 上で探すバイナリ名 (デフォルト)。ユーザーが Settings で上書き可能。
    pub fn default_binary_name(&self) -> &'static str {
        match self {
            CliKind::Claude => "claude",
            CliKind::Codex => "codex",
            CliKind::Opencode => "opencode",
        }
    }
}

/// CLI 起動時のパラメータ。
#[derive(Debug, Clone)]
pub struct CliRunOpts {
    /// ユーザーが Settings で指定した実行可能ファイルのパス。空なら PATH 上を探す。
    pub binary_path: Option<String>,
    /// CLI に `--model` フラグで渡すモデル名。None なら省略 (CLI のデフォルト)。
    pub model: Option<String>,
    /// CLI に渡すプロンプト本体。stdin ではなく `-p <prompt>` 等の引数で渡す。
    pub prompt: String,
}

/// CLI subprocess から取り出したイベント。
/// `commands/cli_ai.rs` が Tauri Event (`chat:stream-chunk` / `chat:stream-done`) に
/// マッピングする。
#[derive(Debug, Clone)]
pub enum CliEvent {
    /// テキスト応答の差分 (assistant メッセージ)
    TextDelta(String),
    /// (将来用) 思考ブロックの差分。Phase C.1 では未使用
    #[allow(dead_code)]
    ThinkingDelta(String),
    /// 処理完了
    Done {
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
        stop_reason: String,
    },
}

/// PATH 上のバイナリパスを解決する。
///
/// - **Unix**: macOS GUI 起動時に shell 初期化前で PATH が貧弱になりがちなため、
///   `bash -lc 'which <bin>'` でログイン shell 相当の PATH を使う。
/// - **Windows**: `where.exe` で解決 (コンソールウィンドウは出さない)。
pub async fn detect_binary(kind: CliKind) -> Option<String> {
    let bin_name = kind.default_binary_name();
    #[cfg(unix)]
    {
        let output = Command::new("bash")
            .arg("-lc")
            .arg(format!("which {bin_name}"))
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8(output.stdout).ok()?.trim().to_string();
        if path.is_empty() {
            return None;
        }
        Some(path)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = Command::new("where.exe")
            .arg(bin_name)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout)
            .lines()
            .next()?
            .trim()
            .to_string();
        if path.is_empty() {
            return None;
        }
        Some(path)
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = bin_name;
        None
    }
}

/// バイナリパスの存在確認 (`<bin> --version` を叩いて 0 終了するか)。
/// 認証状態までは確認しない (CLI 側でログインプロンプトが出る or stderr を読む)。
pub async fn test_binary(binary_path: &str) -> anyhow::Result<String> {
    let mut cmd = Command::new(binary_path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to spawn `{binary_path} --version`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!(
            "{binary_path} --version exited with {}: {stderr}",
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 各 CLI 用のコマンドラインを組み立てる。ツールはすべて OFF 固定。
fn build_command(kind: CliKind, opts: &CliRunOpts) -> Command {
    let bin = opts
        .binary_path
        .as_deref()
        .unwrap_or_else(|| kind.default_binary_name());
    let mut cmd = Command::new(bin);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    // 子プロセスの孫プロセス対策: Unix では新しいプロセスグループを切って
    // abort 時に -pgid kill で纏めて殺せるようにする
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
    match kind {
        CliKind::Claude => {
            cmd.arg("-p")
                .arg(&opts.prompt)
                .arg("--output-format")
                .arg("stream-json")
                // `-p` / print モードでは stream-json が追加ログを stderr に出す前提で --verbose 必須
                .arg("--verbose")
                .arg("--allowed-tools")
                .arg("")
                // ツールは --allowed-tools "" で無効。plan は「プラン専用」挙動になり
                // チャット用途で不自然なので default（危険操作のみ確認、読み取りはそのまま）。
                .arg("--permission-mode")
                .arg("default");
            if let Some(model) = opts.model.as_deref() {
                if !model.is_empty() {
                    cmd.arg("--model").arg(model);
                }
            }
        }
        CliKind::Codex => {
            // Phase C.2 で実装。スケルトンとして shape だけ用意。
            cmd.arg("exec")
                .arg("--json")
                .arg("--sandbox")
                .arg("read-only");
            if let Some(model) = opts.model.as_deref() {
                if !model.is_empty() {
                    cmd.arg("--model").arg(model);
                }
            }
            cmd.arg(&opts.prompt);
        }
        CliKind::Opencode => {
            // Phase C.2 で実装。スケルトン。
            cmd.arg("run").arg("--print-logs").arg("--no-tools");
            if let Some(model) = opts.model.as_deref() {
                if !model.is_empty() {
                    cmd.arg("--model").arg(model);
                }
            }
            cmd.arg(&opts.prompt);
        }
    }
    cmd
}

/// CLI を起動し、stdout を行単位でパースして `on_event` に流す。
/// `abort_flag` が立ったら子プロセス (および子孫) を SIGTERM で殺す。
pub async fn run<F>(
    kind: CliKind,
    opts: CliRunOpts,
    abort_flag: Arc<AtomicBool>,
    mut on_event: F,
) -> anyhow::Result<()>
where
    F: FnMut(CliEvent),
{
    let mut child: Child = build_command(kind, &opts)
        .spawn()
        .map_err(|e| anyhow::anyhow!("Failed to spawn CLI: {e}"))?;
    let pid = child.id();
    // stderr を読まないとパイプが詰まり子プロセスがブロックすることがある（ログは出さず破棄）
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            loop {
                match reader.next_line().await {
                    Ok(Some(_)) => {}
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
        });
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("CLI child stdout missing"))?;
    let mut lines = BufReader::new(stdout).lines();

    let mut adapter = adapter::for_cli(kind);
    let mut total_in: Option<u64> = None;
    let mut total_out: Option<u64> = None;
    let mut stop_reason = "end_turn".to_string();

    let mut aborted = false;
    loop {
        if abort_flag.load(Ordering::Relaxed) {
            stop_reason = "stopped".to_string();
            kill_process_group(pid, libc_sigterm());
            aborted = true;
            break;
        }
        match lines.next_line().await {
            Ok(Some(line)) => {
                if line.is_empty() {
                    continue;
                }
                for ev in adapter.parse_line(&line) {
                    match ev {
                        CliEvent::Done {
                            input_tokens,
                            output_tokens,
                            stop_reason: r,
                        } => {
                            if input_tokens.is_some() {
                                total_in = input_tokens;
                            }
                            if output_tokens.is_some() {
                                total_out = output_tokens;
                            }
                            if !r.is_empty() {
                                stop_reason = r;
                            }
                        }
                        other => on_event(other),
                    }
                }
            }
            Ok(None) => break, // EOF
            Err(e) => return Err(anyhow::anyhow!("CLI stdout read error: {e}")),
        }
    }

    // プロセス終了を待つ。abort 経由で SIGTERM 送信済みでも、
    // 2 秒以内に終了しなければ SIGKILL でエスカレートして UI が固まらないようにする
    if aborted {
        match tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                kill_process_group(pid, libc_sigkill());
                let _ = child.wait().await;
            }
        }
    } else {
        let _ = child.wait().await;
    }

    on_event(CliEvent::Done {
        input_tokens: total_in,
        output_tokens: total_out,
        stop_reason,
    });

    Ok(())
}

#[cfg(unix)]
fn libc_sigterm() -> i32 {
    libc::SIGTERM
}
#[cfg(unix)]
fn libc_sigkill() -> i32 {
    libc::SIGKILL
}
#[cfg(not(unix))]
fn libc_sigterm() -> i32 {
    0
}
#[cfg(not(unix))]
fn libc_sigkill() -> i32 {
    0
}

/// 指定 PID のプロセスグループを殺す。
///
/// - **Unix**: `setsid()` 済みなので pgid == pid。-pid で同グループへ SIG* 送信。
/// - **Windows**: `taskkill /T /F` で子ツリー一括終了。`sig` は未使用。
fn kill_process_group(pid: Option<u32>, sig: i32) {
    let Some(pid) = pid else {
        return;
    };
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), sig);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Stdio;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = sig;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = (pid, sig);
    }
}
