//! CLI エージェント (Claude Code / Codex CLI / OpenCode) を Chat バックエンドとして
//! 流用するためのレイヤ。
//!
//! 設計書 §CLI プロバイダ（サブスクリプション流用） に従い、目的を「サブスク
//! (Claude Pro / ChatGPT Plus 等) 流用による API コスト削減」に限定する。
//! 各 CLI の起動オプションでツールを可能な限り OFF にし、実質「テキスト応答
//! だけを返す HTTP API」相当に縛る。
//!
//! ツール無効化の到達度は CLI ごとに非対称な点に注意（過大評価しないこと）:
//! - Claude Code: `--allowed-tools ""` で R/W・shell・WebSearch を全 OFF。
//! - OpenCode: `OPENCODE_PERMISSION` deny list で read/edit/bash/webfetch 等を全 deny。
//! - Codex CLI: `exec --sandbox read-only` で **書き込み・ネットワークは遮断** されるが
//!   **ローカルファイル読み取りは残る**（Codex はコーディングエージェントで read を
//!   個別 OFF にするフラグを持たない）。read-only ゆえ silent exfil 経路は無いが、
//!   プロンプトインジェクション (悪意ある AI 応答 / 細工された .novel import) で
//!   sandbox root 内ファイルを「チャットに復唱させる」読み取りは原理上可能。
//!   さらなる封じ込め (cwd の隔離 / 追加フラグ) は Codex CLI の実バイナリ挙動の
//!   実機検証が前提のため別タスク（build_command の Codex 分岐参照）。
//!
//! Claude Code / OpenAI Codex CLI (`codex exec --json`) / OpenCode (`run --format json`)
//! の NDJSON を `CliEvent` に正規化する。

pub mod adapter;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
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
/// - **Unix（macOS / Linux 共通）**: ログイン/対話シェル経由の **`command -v`**、
///   nvm / fnm / asdf / Volta / pnpm 初期化、npm prefix、ホーム配下・`/opt/homebrew` 等の定番パス。
/// - **macOS 追加**: **`~/Library/Application Support/<ベンダー>`** の浅い探索、
///   **`/Applications` / `~/Applications` の `.app`**（`Contents/MacOS/<CLI名>`）。
/// - **Linux 追加**: **`/snap/bin`**、`~/.nix-profile/bin`。
/// - **Windows**: `where.exe` → **`%LocalAppData%` 配下の定番・ベンダー・浅い走査**
///   （PATH に無い GUI/ユーザ領域インストール向け）→ PowerShell → Scoop / npm 等。
pub async fn detect_binary(kind: CliKind) -> Option<String> {
    #[cfg(unix)]
    {
        detect_binary_unix(kind).await
    }
    #[cfg(windows)]
    {
        detect_binary_windows(kind).await
    }
    #[cfg(all(not(unix), not(windows)))]
    {
        let _ = kind;
        None
    }
}

#[cfg(unix)]
fn resolved_unix_shell_exe(shell: &str) -> String {
    match shell {
        "bash" => {
            for p in ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"] {
                if PathBuf::from(p).is_file() {
                    return p.to_string();
                }
            }
            "bash".into()
        }
        "zsh" => {
            for p in ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"] {
                if PathBuf::from(p).is_file() {
                    return p.to_string();
                }
            }
            "zsh".into()
        }
        _ => shell.to_string(),
    }
}

#[cfg(unix)]
async fn unix_shell_stdout(
    shell: &str,
    home: &str,
    dash_lc_flag: &str,
    script: &str,
) -> Option<String> {
    let exe = resolved_unix_shell_exe(shell);
    let output = Command::new(&exe)
        .env("HOME", home)
        .args([dash_lc_flag, script])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(unix)]
fn toolchain_prepend_bash() -> &'static str {
    r#"export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" 2>/dev/null
export PATH="$HOME/.local/share/fnm:$PATH"
command -v fnm >/dev/null 2>&1 && eval "$(fnm env --shell bash 2>/dev/null)" || true
[ -f "$HOME/.asdf/asdf.sh" ] && . "$HOME/.asdf/asdf.sh" 2>/dev/null
export PATH="$HOME/.volta/bin:$PATH"
[ -d "$HOME/Library/pnpm" ] && export PATH="$HOME/Library/pnpm:$PATH"
[ -d "$HOME/.local/share/pnpm" ] && export PATH="$HOME/.local/share/pnpm:$PATH"
export PNPM_HOME="${PNPM_HOME:-$HOME/Library/pnpm}"
case ":$PATH:" in *":$PNPM_HOME:"*) ;; *) [ -d "$PNPM_HOME" ] && export PATH="$PNPM_HOME:$PATH" ;; esac
"#
}

#[cfg(unix)]
async fn detect_binary_unix(kind: CliKind) -> Option<String> {
    let bin_name = kind.default_binary_name();
    if bash_escape_singlequoted_literal(bin_name).is_empty() {
        return None;
    }

    let home = dirs::home_dir()?.to_str()?.to_string();

    // 1) login shell（/etc/profile 系）
    if let Some(p) =
        unix_shell_stdout("bash", &home, "-lc", &format!("command -v {bin_name}")).await
    {
        if let Some(n) = normalize_detected_path(p) {
            return Some(n);
        }
    }

    // 2) 対話 + ログイン: 非対話だと .bashrc 先頭で return し nvm 以降が読めないため -i を付ける
    if let Some(p) =
        unix_shell_stdout("bash", &home, "-ilc", &format!("command -v {bin_name}")).await
    {
        if let Some(n) = normalize_detected_path(p) {
            return Some(n);
        }
    }

    // 3) ツールチェーンを明示初期化してから command -v
    let boot = format!("{}command -v {bin_name}", toolchain_prepend_bash());
    if let Some(p) = unix_shell_stdout("bash", &home, "-lc", &boot).await {
        if let Some(n) = normalize_detected_path(p) {
            return Some(n);
        }
    }

    // 4) zsh が既定シェルの環境（macOS 等）
    let zsh_script = format!(
        r#"test -r "$HOME/.zprofile" && . "$HOME/.zprofile" 2>/dev/null
test -r "$HOME/.zshrc" && . "$HOME/.zshrc" 2>/dev/null
command -v {bin_name}"#
    );
    if let Some(p) = unix_shell_stdout("zsh", &home, "-ilc", &zsh_script).await {
        if let Some(n) = normalize_detected_path(p) {
            return Some(n);
        }
    }

    // 5) npm prefix（ツールチェーン初期化後に npm を解決）
    let npm_script = format!(
        r#"{}
command -v npm >/dev/null 2>&1 && npm config get prefix"#,
        toolchain_prepend_bash()
    );
    if let Some(prefix) = unix_shell_stdout("bash", &home, "-lc", &npm_script).await {
        let prefix = prefix.trim();
        if !prefix.is_empty() {
            for rel in [format!("bin/{bin_name}"), bin_name.to_string()] {
                let candidate = PathBuf::from(prefix).join(rel);
                if candidate.is_file() {
                    return candidate.to_str().map(str::to_string);
                }
            }
        }
    }

    if let Some(home_pb) = dirs::home_dir() {
        for rel in [
            "bin",
            ".local/bin",
            "npm-global/bin",
            ".volta/bin",
            "go/bin",
            ".yarn/bin",
        ] {
            let candidate = home_pb.join(rel).join(bin_name);
            if candidate.is_file() {
                return candidate.to_str().map(str::to_string);
            }
        }
        // asdf / mise 典型
        for shim in [".asdf/shims", ".local/share/mise/shims"] {
            let candidate = home_pb.join(shim).join(bin_name);
            if candidate.is_file() {
                return candidate.to_str().map(str::to_string);
            }
        }
    }

    for base in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let candidate = PathBuf::from(base).join(bin_name);
        if candidate.is_file() {
            return candidate.to_str().map(str::to_string);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(p) = macos_application_support_cli(kind, bin_name) {
            return Some(p);
        }
        if let Some(p) = macos_app_bundle_cli(kind, bin_name) {
            return Some(p);
        }
    }

    #[cfg(target_os = "linux")]
    {
        let snap = PathBuf::from("/snap/bin").join(bin_name);
        if snap.is_file() {
            return snap.to_str().map(str::to_string);
        }
        let flatpak_exports = PathBuf::from("/var/lib/flatpak/exports/bin").join(bin_name);
        if flatpak_exports.is_file() {
            return flatpak_exports.to_str().map(str::to_string);
        }
    }

    if let Some(h) = dirs::home_dir() {
        let nix = h.join(".nix-profile/bin").join(bin_name);
        if nix.is_file() {
            return nix.to_str().map(str::to_string);
        }
    }

    None
}

/// macOS: GUI/インストーラが `~/Library/Application Support/<Vendor>` 配下に CLI を置くことがある。
#[cfg(all(unix, target_os = "macos"))]
fn macos_library_application_support_vendors(kind: CliKind) -> &'static [&'static str] {
    match kind {
        CliKind::Claude => &["Anthropic", "anthropic", "Claude", "claude"],
        CliKind::Codex => &["OpenAI", "openai", "Codex", "codex"],
        CliKind::Opencode => &["OpenCode", "opencode", "sst.opencode", "ai.opencode"],
    }
}

#[cfg(all(unix, target_os = "macos"))]
fn macos_app_bundle_directory_names(kind: CliKind) -> &'static [&'static str] {
    match kind {
        CliKind::Claude => &["Claude", "Claude Code"],
        CliKind::Codex => &["Codex", "OpenAI Codex"],
        CliKind::Opencode => &["OpenCode", "opencode"],
    }
}

#[cfg(all(unix, target_os = "macos"))]
fn unix_find_file_bfs_under(
    root: &std::path::Path,
    basename: &str,
    max_depth: usize,
) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for ent in read.flatten() {
            let p = ent.path();
            if p.is_file()
                && p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n == basename)
            {
                return Some(p);
            }
            if p.is_dir() && depth + 1 < max_depth {
                stack.push((p, depth + 1));
            }
        }
    }
    None
}

#[cfg(all(unix, target_os = "macos"))]
fn macos_application_support_cli(kind: CliKind, bin_name: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    let las = home.join("Library/Application Support");
    for v in macos_library_application_support_vendors(kind) {
        let root = las.join(v);
        if let Some(p) = unix_find_file_bfs_under(&root, bin_name, 12) {
            return p.to_str().map(str::to_string);
        }
    }
    None
}

#[cfg(all(unix, target_os = "macos"))]
fn macos_app_bundle_cli(kind: CliKind, bin_name: &str) -> Option<String> {
    let home = dirs::home_dir()?;
    for apps_root in [PathBuf::from("/Applications"), home.join("Applications")] {
        for app in macos_app_bundle_directory_names(kind) {
            let macos_dir = apps_root
                .join(format!("{app}.app"))
                .join("Contents")
                .join("MacOS");
            if !macos_dir.is_dir() {
                continue;
            }
            let direct = macos_dir.join(bin_name);
            if direct.is_file() {
                return direct.to_str().map(str::to_string);
            }
            if let Ok(read) = std::fs::read_dir(&macos_dir) {
                for ent in read.flatten() {
                    let p = ent.path();
                    if p.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.eq_ignore_ascii_case(bin_name))
                    {
                        return p.to_str().map(str::to_string);
                    }
                }
            }
        }
    }
    None
}

#[cfg(unix)]
/// `bin_name` は英数字と `_` `-` のみ想定（claude / codex / opencode）。それ以外は素通ししない。
fn bash_escape_singlequoted_literal(bin_name: &str) -> String {
    if bin_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        bin_name.to_string()
    } else {
        String::new()
    }
}

#[cfg(unix)]
fn normalize_detected_path(raw: String) -> Option<String> {
    let first = raw.lines().next()?.trim();
    if first.is_empty() {
        return None;
    }
    let p = PathBuf::from(first);
    if p.is_file() {
        return p.to_str().map(str::to_string);
    }
    None
}

#[cfg(windows)]
fn windows_cli_exe_leaf(bin_name: &str) -> String {
    format!("{bin_name}.exe")
}

/// `%LocalAppData%\Programs\<name>\<name>.exe` 等（Electron / ユーザ単位インストールでよくある）
#[cfg(windows)]
fn find_exe_under_local_programs(local: &std::path::Path, bin_name: &str) -> Option<PathBuf> {
    let programs = local.join("Programs");
    if !programs.is_dir() {
        return None;
    }
    let exe = windows_cli_exe_leaf(bin_name);
    let direct = programs.join(bin_name).join(&exe);
    if direct.is_file() {
        return Some(direct);
    }
    let read = std::fs::read_dir(&programs).ok()?;
    for ent in read.flatten() {
        let d = ent.path();
        if !d.is_dir() {
            continue;
        }
        if !dir_entry_name_eq_ignore_case(&d, bin_name) {
            continue;
        }
        let cand = d.join(&exe);
        if cand.is_file() {
            return Some(cand);
        }
        let cand_bin = d.join("bin").join(&exe);
        if cand_bin.is_file() {
            return Some(cand_bin);
        }
    }
    None
}

#[cfg(windows)]
fn dir_entry_name_eq_ignore_case(path: &std::path::Path, expected: &str) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(expected))
}

/// アプリ実行エイリアス等（0 バイトシムのこともあるが、まず候補として返す）
#[cfg(windows)]
fn find_exe_windows_apps_aliases(local: &std::path::Path, bin_name: &str) -> Option<PathBuf> {
    let exe = windows_cli_exe_leaf(bin_name);
    let p = local.join("Microsoft").join("WindowsApps").join(&exe);
    if p.exists() {
        return Some(p);
    }
    None
}

#[cfg(windows)]
fn local_appdata_vendor_roots(kind: CliKind) -> &'static [&'static str] {
    match kind {
        CliKind::Claude => &["Anthropic", "anthropic", "Claude", "claude"],
        CliKind::Codex => &["OpenAI", "openai"],
        CliKind::Opencode => &["opencode", "OpenCode", "sst", "anomalyco"],
    }
}

#[cfg(windows)]
fn find_exe_bfs_under_root(
    root: &std::path::Path,
    exe_leaf: &str,
    max_depth: usize,
) -> Option<PathBuf> {
    if !root.is_dir() {
        return None;
    }
    let mut stack: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let read = std::fs::read_dir(&dir).ok()?;
        for ent in read.flatten() {
            let p = ent.path();
            if p.is_file() && dir_entry_name_eq_ignore_case(&p, exe_leaf) {
                return Some(p);
            }
            if p.is_dir() && depth + 1 < max_depth {
                stack.push((p, depth + 1));
            }
        }
    }
    None
}

/// `LocalAppData` 直下の各ベンダーフォルダだけを浅く BFS（全体走査はしない）
#[cfg(windows)]
fn find_exe_under_vendor_roots(
    local: &std::path::Path,
    roots: &[&str],
    exe_leaf: &str,
) -> Option<PathBuf> {
    for r in roots {
        let sub = local.join(r);
        if let Some(p) = find_exe_bfs_under_root(&sub, exe_leaf, 12) {
            return Some(p);
        }
    }
    None
}

/// 直下 1〜2 階層だけ見る汎用スキャン。`Packages` など巨大木は子を辿らない。
#[cfg(windows)]
fn find_exe_shallow_under_local_appdata(
    local: &std::path::Path,
    exe_leaf: &str,
) -> Option<PathBuf> {
    const SKIP_NESTED_SCAN: &[&str] = &[
        "Packages",
        "npm-cache",
        "pip",
        "NuGet",
        "Yarn",
        "Temp",
        "D3DSCache",
    ];
    let top_iter = std::fs::read_dir(local).ok()?;
    for top_ent in top_iter.flatten() {
        let top = top_ent.path();
        if !top.is_dir() {
            continue;
        }
        let Some(tn) = top.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let top_name = tn.to_string();
        for cand in [top.join(exe_leaf), top.join("bin").join(exe_leaf)] {
            if cand.is_file() {
                return Some(cand);
            }
        }
        if SKIP_NESTED_SCAN
            .iter()
            .any(|s| top_name.eq_ignore_ascii_case(s))
        {
            continue;
        }
        let sub_iter = std::fs::read_dir(&top).ok()?;
        for sub_ent in sub_iter.flatten() {
            let sub = sub_ent.path();
            if !sub.is_dir() {
                continue;
            }
            for cand in [sub.join(exe_leaf), sub.join("bin").join(exe_leaf)] {
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[cfg(windows)]
fn decode_ps_path_output(stdout: &[u8]) -> Option<String> {
    if stdout.is_empty() {
        return None;
    }
    let utf8 = String::from_utf8_lossy(stdout).trim().to_string();
    if !utf8.is_empty() && PathBuf::from(&utf8).is_file() {
        return Some(utf8);
    }
    // Windows PowerShell 5.1 がパイプへ UTF-16 LE を出すことがある
    if stdout.len() >= 4 && stdout.len().is_multiple_of(2) {
        let u16s: Vec<u16> = stdout
            .chunks_exact(2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let mut s = String::from_utf16_lossy(&u16s).trim().to_string();
        s = s.trim_start_matches('\u{feff}').to_string();
        if !s.is_empty() && PathBuf::from(&s).is_file() {
            return Some(s);
        }
    }
    None
}

#[cfg(windows)]
async fn detect_binary_windows(kind: CliKind) -> Option<String> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let bin_name = kind.default_binary_name();
    let exe_leaf = windows_cli_exe_leaf(bin_name);

    if let Some(p) = where_exe_first(bin_name, CREATE_NO_WINDOW).await {
        return Some(p);
    }

    let local = dirs::data_local_dir()?;

    if let Some(p) = find_exe_under_local_programs(&local, bin_name) {
        return p.to_str().map(str::to_string);
    }

    let vendors = local_appdata_vendor_roots(kind);
    if let Some(p) = find_exe_under_vendor_roots(&local, vendors, &exe_leaf) {
        return p.to_str().map(str::to_string);
    }

    if let Some(p) = find_exe_shallow_under_local_appdata(&local, &exe_leaf) {
        return p.to_str().map(str::to_string);
    }

    if let Some(p) = find_exe_windows_apps_aliases(&local, bin_name) {
        return p.to_str().map(str::to_string);
    }

    if let Some(p) = powershell_resolve_exe(bin_name, CREATE_NO_WINDOW).await {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(p);
        }
    }

    if let Some(home) = dirs::home_dir() {
        let scoop = home
            .join("scoop")
            .join("shims")
            .join(format!("{bin_name}.exe"));
        if scoop.is_file() {
            return scoop.to_str().map(str::to_string);
        }
    }

    for dir in [dirs::data_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
    {
        let npm_dir = dir.join("npm");
        if let Some(p) = first_matching_npm_shim(bin_name, &npm_dir) {
            return Some(p);
        }
    }

    if let Some(prefix) = npm_prefix_windows(CREATE_NO_WINDOW).await {
        let prefix = prefix.trim();
        if !prefix.is_empty() {
            let root = PathBuf::from(prefix);
            for candidate in [
                root.join(format!("{bin_name}.cmd")),
                root.join(format!("{bin_name}.exe")),
                root.join(bin_name),
                root.join("bin").join(bin_name),
            ] {
                if candidate.is_file() {
                    return candidate.to_str().map(str::to_string);
                }
            }
        }
    }

    None
}

#[cfg(windows)]
fn first_matching_npm_shim(bin_name: &str, npm_dir: &std::path::Path) -> Option<String> {
    for ext in ["cmd", "exe", ""] {
        let name = if ext.is_empty() {
            bin_name.to_string()
        } else {
            format!("{bin_name}.{ext}")
        };
        let candidate = npm_dir.join(name);
        if candidate.is_file() {
            return candidate.to_str().map(str::to_string);
        }
    }
    None
}

#[cfg(windows)]
async fn powershell_resolve_exe(bin_name: &str, create_no_window: u32) -> Option<String> {
    if !bin_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    let ps = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
         $s = (Get-Command '{}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source); \
         if (-not $s) {{ exit 1 }}; [Console]::Out.Write($s)",
        bin_name
    );
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &ps,
        ])
        .creation_flags(create_no_window)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    decode_ps_path_output(&output.stdout)
}

#[cfg(windows)]
async fn where_exe_first(bin_name: &str, create_no_window: u32) -> Option<String> {
    let output = Command::new("where.exe")
        .arg(bin_name)
        .creation_flags(create_no_window)
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
        None
    } else {
        Some(path)
    }
}

#[cfg(windows)]
async fn npm_prefix_windows(create_no_window: u32) -> Option<String> {
    let mut cmd = Command::new("npm");
    cmd.args(["config", "get", "prefix"])
        .creation_flags(create_no_window);
    let output = cmd.output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// CLI が利用可能なモデル一覧を返す。
///
/// - **Codex**: `codex debug models --bundled` の JSON をパース
/// - **OpenCode**: `opencode models` の stdout (`provider/model` 1 行 1 件)
/// - **Claude Code**: 一覧コマンドが無いため既知エイリアス/モデル ID の静的リスト
pub async fn list_models(
    kind: CliKind,
    binary_path: Option<&str>,
) -> anyhow::Result<Vec<crate::ai::AiModel>> {
    match kind {
        CliKind::Claude => Ok(known_claude_models()),
        CliKind::Codex => {
            let bin = resolve_binary_for_list(kind, binary_path);
            let raw = run_cli_for_stdout(&bin, &["debug", "models", "--bundled"]).await?;
            parse_codex_models_json(&raw)
        }
        CliKind::Opencode => {
            let bin = resolve_binary_for_list(kind, binary_path);
            let raw = run_cli_for_stdout(&bin, &["models"]).await?;
            Ok(parse_opencode_models_stdout(&raw))
        }
    }
}

fn resolve_binary_for_list(kind: CliKind, binary_path: Option<&str>) -> String {
    binary_path
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| kind.default_binary_name().to_string())
}

async fn run_cli_for_stdout(binary: &str, args: &[&str]) -> anyhow::Result<String> {
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to spawn `{binary} {}`: {e}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!(
            "`{binary} {}` exited with {}: {stderr}",
            args.join(" "),
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn known_claude_models() -> Vec<crate::ai::AiModel> {
    [
        ("opus", "Opus (latest alias)"),
        ("sonnet", "Sonnet (latest alias)"),
        ("haiku", "Haiku (latest alias)"),
        ("claude-opus-4-7", "Claude Opus 4.7"),
        ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
        ("claude-sonnet-4-5-20250929", "Claude Sonnet 4.5"),
        ("claude-3-5-haiku-20241022", "Claude Haiku 3.5"),
    ]
    .into_iter()
    .map(|(id, name)| crate::ai::AiModel {
        id: id.to_string(),
        name: name.to_string(),
        api_variant: None,
        context_length: None,
        max_completion_tokens: None,
        supported_parameters: None,
        pricing_prompt: None,
        pricing_completion: None,
    })
    .collect()
}

#[derive(Debug, Deserialize)]
struct CodexModelsResponse {
    models: Vec<CodexModelEntry>,
}

#[derive(Debug, Deserialize)]
struct CodexModelEntry {
    slug: String,
    display_name: Option<String>,
    visibility: Option<String>,
}

fn parse_codex_models_json(raw: &str) -> anyhow::Result<Vec<crate::ai::AiModel>> {
    let parsed: CodexModelsResponse = serde_json::from_str(raw.trim())
        .map_err(|e| anyhow::anyhow!("Failed to parse Codex models JSON: {e}"))?;
    Ok(parsed
        .models
        .into_iter()
        .filter(|m| m.visibility.as_deref().unwrap_or("list") == "list")
        .map(|m| crate::ai::AiModel {
            id: m.slug.clone(),
            name: m.display_name.unwrap_or(m.slug),
            api_variant: None,
            context_length: None,
            max_completion_tokens: None,
            supported_parameters: None,
            pricing_prompt: None,
            pricing_completion: None,
        })
        .collect())
}

fn parse_opencode_models_stdout(raw: &str) -> Vec<crate::ai::AiModel> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter(|line| line.contains('/'))
        .map(|line| {
            let id = line.to_string();
            let name = line.rsplit('/').next().unwrap_or(line).to_string();
            crate::ai::AiModel {
                id,
                name,
                api_variant: None,
                context_length: None,
                max_completion_tokens: None,
                supported_parameters: None,
                pricing_prompt: None,
                pricing_completion: None,
            }
        })
        .collect()
}

/// バイナリパスの存在確認 (`<bin> --version` を叩いて 0 終了するか)。
/// 認証状態までは確認しない (CLI 側でログインプロンプトが出る or stderr を読む)。
pub async fn test_binary(binary_path: &str) -> anyhow::Result<String> {
    let mut cmd = Command::new(binary_path);
    cmd.arg("--version");
    #[cfg(windows)]
    {
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
            // read-only sandbox: 書き込み・ネットワークは遮断されるが、ローカル
            // ファイル読み取りは残る（Claude の --allowed-tools "" / OpenCode の
            // deny list と非対称）。read を個別 OFF にする Codex フラグは無いため、
            // ここはモジュール docstring の「残存能力」注記が正本。cwd 隔離等の
            // 追加封じ込めは Codex CLI 実機検証後に別途。
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
            // 公式 CLI: stdout は JSONL (`--format json`)、ログは stderr (`--print-logs`)。
            // ツールは OPENCODE_PERMISSION で一律 deny（チャット用途ではテキストのみ）。
            cmd.arg("--print-logs")
                .env(
                    "OPENCODE_PERMISSION",
                    r#"{"permission":{"read":"deny","edit":"deny","glob":"deny","grep":"deny","bash":"deny","task":"deny","skill":"deny","lsp":"deny","question":"deny","webfetch":"deny","websearch":"deny","external_directory":"deny"}}"#,
                )
                .arg("run")
                .arg("--format")
                .arg("json");
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

#[cfg(test)]
mod list_models_tests {
    use super::*;

    #[test]
    fn parse_codex_models_json_extracts_visible_models() {
        let raw = r#"{
            "models": [
                {"slug": "gpt-5.5", "display_name": "GPT-5.5", "visibility": "list"},
                {"slug": "hidden", "display_name": "Hidden", "visibility": "hidden"}
            ]
        }"#;
        let models = parse_codex_models_json(raw).expect("parse");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.5");
        assert_eq!(models[0].name, "GPT-5.5");
    }

    #[test]
    fn parse_opencode_models_stdout_splits_provider_model() {
        let raw = "anthropic/claude-sonnet-4-6\nopenai/gpt-4o\n";
        let models = parse_opencode_models_stdout(raw);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "anthropic/claude-sonnet-4-6");
        assert_eq!(models[0].name, "claude-sonnet-4-6");
    }

    #[test]
    fn known_claude_models_is_non_empty() {
        assert!(!known_claude_models().is_empty());
    }
}
