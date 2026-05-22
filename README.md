# Grimodex

AI統合デスクトップ小説執筆エディタ / AI-integrated desktop novel-writing editor.

---

## What is Grimodex? / Grimodexとは

Grimodex is a desktop novel-writing editor with AI chat and knowledge extraction built in. It's a Novelcrafter-like follower — same shape (manuscript + AI chat + Codex), different stack (Tauri + React, local SQLite storage).

The core loop: chat with an AI, extract characters / worldbuilding / snippets from that chat, then pull them into your manuscript. Everything you insert keeps its origin (human / ai / unknown) so you can tell later what came from where.

Grimodexは、AIチャットとナレッジ抽出を組み込んだデスクトップ小説執筆エディタです。位置づけとしてはNovelcrafterライクなフォロワーで、形は同じ（本文 + AIチャット + Codex）ですがスタックが違います（Tauri + React、ローカルSQLite保存）。

コアの流れは、AIと会話し、そこから登場人物 / 世界観 / スニペットを抽出して本文に取り込むこと。挿入したテキストは出所（human / ai / unknown）が記録されるので、あとから何がどこから来たか追えます。

---

## Installation / インストール

Download the installer for your platform from the [latest release](../../releases/latest).

| Platform | File                  |
| -------- | --------------------- |
| Windows  | `.exe`                |
| macOS    | `.dmg`                |
| Linux    | `.AppImage` or `.deb` |

No runtime required — just install and launch. AI chat works with a cloud API key (OpenRouter / OpenAI / Anthropic), a local Ollama model, or an agentic CLI — see Features below.

最新リリースのページからお使いのOSに合わせたインストーラーを取得してください。ランタイム不要です。AIチャットはクラウドのAPIキー（OpenRouter / OpenAI / Anthropic）、ローカルのOllama、エージェント型CLIのいずれかで利用できます（詳細は下記の機能を参照）。

---

## Screenshots / スクリーンショット

![Write — editor, AI chat, and Codex side-by-side](docs/screenshots/screenshot-write.png)
_Write — エディタ・AIチャット・Codex を並べた執筆ビュー（日本語サンプル「朱の記憶」）_

![Plan — story grid with scene cards](docs/screenshots/screenshot-plan.png)
_Plan — シーンをカードで俯瞰するプランニングビュー_

![Chat — AI chat with conversation history](docs/screenshots/screenshot-chat.png)
_Chat — AIチャットと会話履歴を並べたビュー_

---

## Features / 機能

- **Chapter / scene editor** — Independent TipTap instance per scene, rich text with attribution tracking.
- **Japanese novel typesetting** — Ruby (furigana), emphasis dots (傍点), and a vertical-writing preview.
- **Prose linter** — Deterministic Japanese text checks backed by UniDic morphological analysis.
- **AI chat per scene** — Separate conversation history for each scene.
- **Flexible AI backends** — Bring your own cloud API key (OpenRouter / OpenAI / Anthropic), run a local model via Ollama, or drive an agentic CLI you already use (Claude Code / Codex CLI / OpenCode).
- **MCP server** — Grimodex ships an MCP server, so external agents can read and edit your project.
- **Codex** — Characters, worldbuilding, items, whatever. Extract from chat and reference in-editor.
- **Snippets** — Reusable fragments pulled from chat.
- **Source attribution** — Every inserted range is tagged human / ai / unknown.
- **Local storage** — SQLite (WAL mode) + FTS5 on disk. No account required; only AI calls hit the network.

- **チャプター / シーンエディタ** — シーンごとに独立したTipTapインスタンス、帰属追跡つきリッチテキスト。
- **日本語小説向け組版** — ルビ（ふりがな）、傍点、縦書きプレビュー。
- **文章リンター** — UniDic形態素解析ベースの決定論的な日本語文章チェック。
- **シーン単位のAIチャット** — シーンごとに独立した会話履歴。
- **柔軟なAIバックエンド** — クラウドのAPIキー持ち込み（OpenRouter / OpenAI / Anthropic）、Ollamaによるローカルモデル、または手持ちのエージェント型CLI（Claude Code / Codex CLI / OpenCode）。
- **MCPサーバー** — GrimodexはMCPサーバーを同梱。外部エージェントからプロジェクトを読み書きできます。
- **Codex** — 登場人物・世界観・アイテムなど。チャットから抽出してエディタ内で参照。
- **スニペット** — チャットから拾った再利用可能な断片。
- **出所追跡** — 挿入されたテキストは human / ai / unknown でタグづけ。
- **ローカル保存** — SQLite（WALモード）+ FTS5。アカウント不要、ネットに出るのはAI呼び出しだけ。

---

## Stack / 技術スタック

- **Desktop shell:** Tauri v2 (Rust)
- **Frontend:** React 19 + TypeScript (strict)
- **Editor:** TipTap / ProseMirror
- **State:** Zustand (global) + Jotai (local)
- **DB:** SQLite via Drizzle ORM, WAL mode, FTS5 enabled
- **Semantic search:** Ruri v3 embeddings (ONNX Runtime) + UniDic morphology (lindera)
- **Test:** Vitest

---

## Development / 開発

Prerequisites: Node.js, pnpm, a Rust toolchain, Python 3 (only for generating the embedding model), and the platform dependencies required by Tauri.

```sh
pnpm install
pnpm tauri dev          # full app in dev
pnpm dev                # frontend only
pnpm tauri build        # production build
pnpm test               # frontend tests (Vitest)
pnpm lint:fix
npx tsc --noEmit        # type check

cd src-tauri
cargo check
cargo clippy --all-targets
cargo test
```

### First-build setup / 初回ビルドの準備

- **ONNX Runtime & UniDic** — The first Rust build downloads the ONNX Runtime binaries (`ort`) and the UniDic dictionary (`lindera`, embedded for the Japanese prose linter). Network access is required, so the first build is slow.
- **Embedding model** — The semantic-search model (`model.onnx` / `model_int8.onnx`, ~150 MB) is **not** committed to the repo. Generate it from the upstream `cl-nagoya/ruri-v3-30m` weights:

  ```sh
  pip install "optimum[onnxruntime]" sentencepiece protobuf
  python3 scripts/export-ruri-onnx.py
  ```

  The files are written to `src-tauri/resources/semantic/ruri-v3-30m/`. Without them the app still builds and runs, but semantic search stays disabled. Passing `--no-default-features` to `cargo` skips the embedding path entirely.

初回のRustビルドでは ONNX Runtime バイナリ（`ort`）と UniDic 辞書（`lindera`、日本語リンター用に同梱）がダウンロードされます（ネットワーク必須・初回は時間がかかります）。セマンティック検索用の埋め込みモデル（`model.onnx` / `model_int8.onnx`、約150MB）はリポジトリに含まれていないため、`pip install "optimum[onnxruntime]" sentencepiece protobuf` のうえ `python3 scripts/export-ruri-onnx.py` を実行し `cl-nagoya/ruri-v3-30m` から `src-tauri/resources/semantic/ruri-v3-30m/` へ再生成してください。生成しなくてもアプリのビルド・起動はできますが、セマンティック検索は無効になります。`cargo` に `--no-default-features` を渡すと埋め込み経路ごとスキップできます。

---

## Contributing / コントリビューション

This is a personal project and I'm not familiar with OSS workflows. I may not be able to review or merge pull requests in a timely manner — or at all. If you want to add features or make changes, forking is probably the way to go.

Bug reports and feedback via issues are welcome, though response time isn't guaranteed.

個人プロジェクトとして公開しているだけなので、PRのレビューやマージは基本的にできないと思ってください。機能を追加したい場合はフォークして自由に使ってもらえると助かります。バグ報告や感想などはイシューで気軽にどうぞ（返信が遅れる場合があります）。

---

## License / ライセンス

[Elastic License 2.0](./LICENSE).
