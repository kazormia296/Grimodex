# NoveLoom セットアップ手順（Windows）

## 前提条件の確認

以下がインストール済みであること:
- Node.js 20+
- Rust (rustup) + Visual Studio Build Tools
- Git
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)

## Step 1: グローバルCLAUDE.md を配置

```powershell
# ~/.claude/ ディレクトリを作成
mkdir "$env:USERPROFILE\.claude" -Force

# GLOBAL_CLAUDE.md を配置（ファイル名を CLAUDE.md に変更）
copy GLOBAL_CLAUDE.md "$env:USERPROFILE\.claude\CLAUDE.md"
```

## Step 2: プロジェクトディレクトリを作成

```powershell
mkdir noveloom
cd noveloom
git init
```

## Step 3: スターターキットのファイルを配置

```powershell
# プロジェクトルートにコピー
copy ..\starter-kit\CLAUDE.md .
copy ..\starter-kit\.claudeignore .

# .claude/ ディレクトリごとコピー
xcopy ..\starter-kit\.claude .claude\ /E /I

# docs ディレクトリを作成
mkdir docs\phases
# active ディレクトリを作成（Document & Clear用）
mkdir active
```

## Step 4: .gitignore を作成

```powershell
@"
node_modules/
dist/
src-tauri/target/
coverage/
.env
.env.*
CLAUDE.local.md
.claude/settings.local.json
active/
"@ | Out-File -Encoding utf8 .gitignore
```

## Step 5: Claude Code を起動して仕様書を作成

```powershell
claude
```

Claude Code が起動したら、以下のプロンプトを入力:

```
Novelcrafterライクな小説執筆エディタを作りたい。
技術スタックは Tauri v2 + React 19 + TypeScript + TipTap + SQLite + Drizzle ORM。

AskUserQuestionツールを使って詳細にインタビューして。
技術的な実装、UI/UX、エッジケース、トレードオフについて質問して。
当たり前の質問はせず、見落としがちな難しい部分を掘り下げて。

すべてカバーしたら、完全な仕様書を docs/SPEC.md に書いて。
```

## Step 6: /clear → Phase 0 開始

仕様書が完成したら:

```
/clear
```

そして Phase 0 を開始:

```
Tauri v2 + React 19 + TypeScript + Vite のプロジェクトを作成して。
TipTap、shadcn/ui、Zustand、Jotai もインストール。
npm run tauri dev で空のウィンドウが表示されることを確認して。
```
