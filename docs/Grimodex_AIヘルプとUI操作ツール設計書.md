# Grimodex AI ヘルプと UI 操作ツール 設計書（草稿）

- 状態: 草稿（2026-11-15）。PR1（コマンド registry）と PR2（read ツール）は master に merge 済み。PR3（UI の操作ツール）は 2026-11-16 に実装し、§4〜§7・§10 を実装に合わせて更新した。PR4（設定変更の提案）は未着手。
- 対象: Grimodex 本体の操作ヘルプと、アプリ内 Chat agent が UI を操作するツール。
- 基点: 本書の現状記述は `origin/master`（2026-11-15 時点）で確認した。確認していない点は §2 の「未確認」に分けた。
- 関連文書: [AIエージェント設計書](Grimodex_AIエージェント設計書.md)（Chat のツール定義・書き込み系の AiPolicy ゲート）、
  [Settingsパネル設計書](Grimodex_Settingsパネル設計書.md)（設定のカテゴリ）、[Workspace設計書](Grimodex_Workspace設計書.md)（レイアウト）。

## 1. 目的と範囲

### 1.1 目的

1. agent 向けの操作ヘルプを、手作業の保守が要る GitHub wiki ではなく、**コードと同じ PR で更新される正本**から出す。
2. アプリ内 Chat の agent が「〜するには？」に、**今の環境での事実**（実際のキー割当、OS による差、使える機能）で答える。
3. agent が説明だけでなく、パネルの表示・プリセットの適用・設定の変更を、安全な範囲で**代わりに行える**ようにする。

### 1.2 範囲外

- 外部 agent 向けの `grimodex-mcp`。MCP は各ツールの説明文で足りるとする（2026-11-15 ユーザー判断）。
  本書の目録を MCP に出すかは将来の選択肢として残す（§10）。
- 執筆内容（場面・Codex 等）の操作ツール。これらは既存の `agent-tool-manifest.json` の範囲。
- GitHub wiki の扱い。当面残す（インストールせずに機能を確かめたい需要のため。2026-11-15 ユーザー判断）。
  ヘルプ文書と wiki の同期はしない。
- 人がアプリ内でヘルプ文書を読む画面。作らない（UI の言語ごとに文書を揃える負担のため。2026-11-15 ユーザー判断）。
- 任意の UI の生成（モデルが HTML/コンポーネントを出力すること）。本書の「Generative UI 的な振る舞い」は、
  **登録済みのコマンドと設定だけを呼ぶ**ことを指す。

### 1.3 用語

- **目録**: コマンド・設定・ヘルプ項目の機械可読な一覧。ヘルプとツールの正本。
- **事実**: コマンド名、既定キー、設定のキー・型・範囲、パネル ID など、コードから導けるもの。
- **判断**: 手順、使いどころ、トラブル対処など、人が書く説明。

## 2. 現状（origin/master で確認）

| 項目 | 現状 | 本書での扱い |
|---|---|---|
| キー操作 | `src/features/settings/keybindings.ts` の `getCommands()` に 25 件の `CommandDef`（id、i18n ラベル、`defaultBinding`、`panel`、`macUnavailable`）。実行関数は持たない | 実行関数と説明を持つコマンド registry に拡張する（§4.1） |
| キーの実行 | `matchesBinding` で照合する処理が `editor/GlobalCommandHost.tsx`（227 行）、`editor/tabSwitchKeybinding.ts`、`editor/useEditorKeyboard.ts`、`editor/LinearEditorView.tsx`、`tree/useScenesKeyboard.ts` に分かれて直書き | 全体に効くもの（GlobalCommandHost、タブ切替）を registry の `run` に移す。エディタやツリーの中でだけ効くものは対象外とし、目録には説明だけ載せる |
| Command Center | `src/features/commandCenter/` は本文の lexical／semantic 検索。コマンドパレットではない | 変更しない。将来コマンド検索の provider を足せる |
| パネル | `src/features/layout/panelIds.ts` の `PanelId`（18 種） | 表示ツールの引数に使う |
| レイアウトのプリセット | `layoutPresets.ts` の `BUILTIN_PRESET_IDS`（default／plan／chat-main／review／codex-main）とユーザー定義のプリセット | プリセット適用ツールの引数に使う |
| 設定 | `settingsStore` は文字列の key／value。`settings/types.ts` に `SETTINGS_CATEGORIES`（カテゴリ定義）、`KEY_SCOPE`（global／project）、`DEFAULT_SETTINGS`（既定値、文字列）、`LANGUAGE_DEFAULT_OVERRIDES` がある。型・範囲・説明は無い。参照されるキーは概数で 190 前後 | 目録はキー・既定値・カテゴリを `types.ts` から引き、型・範囲・説明だけを足す。agent に許可するキーに限る（§4.2） |
| 設定画面 | `settings/categories/*.tsx` に部品を直接配置。カテゴリは `SETTINGS_CATEGORIES` | カテゴリ ID を「設定を開く」リンクの行き先にする |
| Chat のツール | `agent-tool-manifest.json` が正本（`capability`＝read／write／destructive、`requiredPolicy`＝null／knowledgeWrite／bodyWrite／structureWrite（PR3 で `chat` を追加）、`allowedChannels`＝agent／hermes／native、`requiresUserConfirmation`）。`src-tauri/crates/grimodex-ai/build.rs` が Rust の AI parser に取り込む。`scripts/ci-change-scope.test.mjs`、`scripts/quality/eval-fixtures.mjs` も参照。定義は `chat/agent/toolDefinitions.ts`、実行は `toolExecutors.ts` | 新しいツールは manifest への追加を伴うので、**read のツールでも Rust の build に触れる**（§5） |
| 確認の UI | `requiresUserConfirmation: true` は `apply_ai_tree_plan`、`propose_scene_body`、`delete_event`、`remove_event_relation`。提案のカードと review が `chronicle/ChronicleProposalCard.tsx`、`codex/CodexEntityProposalCard.tsx` 等にある | 設定変更のカードは新設せず、既存の提案カードの型に合わせる（§6） |
| UI 文言 | `src/locales/{ja,en}.json` | 目録の説明もここに置く |

未確認の点:

- provider ごとのツール呼び出しの可否の差。Hermes／native の low-trust parser は read のツールだけを通す（`HERMES_ALLOWED_TOOL_NAMES`）。この parser で UI 操作のツールが使えないことは仕様として受け入れる見込み。
- 設定のうち、Main 側で再検証されるもの・されないものの区別。
- 既存の提案カードの共通部品があるか（機能ごとの実装か）。

## 3. 方針

1. **事実は registry から読み、判断は人が短く書く。** アプリ内の Chat は renderer で動くので、事実は**実行中の registry を直接読む**。
   ビルド時の生成は要らない。これで「リリース時点のコードがそのまま正本」になる。
2. **実行時に AI にソースを読ませない。** 配布物は minify された bundle で、GitHub から取れば新しい外部送信先になる。
   ソースには利用者の語彙や手順も書かれていない。
3. **説明はコードの隣に置く。** 各コマンド・設定の説明は i18n の key として定義の中で参照し、機能を変えた同じ PR で直る形にする。
4. **ツールは「索引 → 詳細」の 2 段。** system prompt には常時入れない（Chat は執筆が主目的で、文脈と token を守る）。
5. **書いていないことは「無い」と答える。** 存在しない機能・ボタン・設定を作らない。答えには出典の項目 ID を付ける。
6. **操作は登録済みのものだけ。** agent は registry と設定の目録の中から、許可された項目だけを呼べる。
7. **危険度で確認の強さを変える。** 毎回の確認は反射の承認を招く。表示は確認なし、設定は前後の表示と元に戻す操作、外部や秘密に関わるものは agent に出さない（§6）。

## 4. 構成

```
┌───────────── renderer ─────────────────────────────────────┐
│ CommandRegistry ──┬─ GlobalCommandHost（キー）              │
│  (id, label, desc,│                                          │
│   args, run, risk,├─ （将来）コマンドパレット                │
│   agent)          └─ Chat ツール run_app_command             │
│                                                              │
│ AgentSettingCatalog ─── Chat ツール propose_setting_change  │
│  (key, type, range, category, desc)                          │
│                                                              │
│ help/*.md（判断）──┐                                          │
│ locales（説明）────┼─ HelpIndex ── Chat ツール get_app_help* │
│ registry／catalog ─┘                                          │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 コマンド registry

`CommandDef` を次のように拡張する（名前は仮）。

```ts
interface AppCommand {
  id: string;                    // 既存の id を維持（ユーザーのキー割当の保存と互換）
  labelKey: string;              // i18n
  descriptionKey: string;        // i18n。1〜2 文。利用者の語彙で書く
  aliasesKey?: string;           // 「〜とも呼ぶ」
  defaultBinding?: string;       // キーが無いコマンドも登録できる
  macUnavailable?: boolean;
  args?: JsonSchema;             // agent が渡す引数
  run: (ctx: CommandContext, args?: unknown) => Promise<CommandResult>;
  risk: "view" | "personal" | "blocked";
  agent: boolean;                // agent に出すか
  helpTopics?: string[];         // 関連するヘルプ項目
}
```

- `GlobalCommandHost` は「キーを照合して `registry.run(id)` を呼ぶ」だけにする。挙動は変えない。
- `run` は既存の store の操作（`layoutStore`、`settingsStore` 等）を呼ぶ。新しい IPC は作らない見込み。
- 既存の 25 件に加え、キーの無い操作（プリセットの適用、設定のカテゴリを開く、特定のパネルを表示）も登録する。
  本書に出てくる `applyLayoutPreset` などのコマンド ID は仮の名前で、今は存在しない。
  （PR3 の実装では、プリセットの適用はコマンドではなく専用のツール `apply_layout_preset` にした。§5）

実装（`src/features/commands/appCommandRegistry.ts`、PR1・PR3）が上の案と違う点:

- `run` は同期で、`CommandResult`（`{ ok: true }` か `{ ok: false, reason }`）を返す（キー処理のタイミングを変えないため）。文脈は `run(ctx)` に明示して渡す。
- ラベルと説明は `AppCommand` に持たず、`getCommands()` の label と locales の `help.commands.<id>` を使う。`args` は PR3 の時点でどのコマンドにも無く、`run_app_command` の入力は command id だけ。
- `fixedKey`（再割当不可のキー。`searchWorkspace`、`toggleExport`）、`panel`、`isAvailable`（今 `run` できるか）を足した。
- agent が実行してよいかは `isAgentRunnable`（`agent: true` かつ `risk: "view"`）で決め、registry の一覧（`listAgentRunnableCommandIds`）がツールの許可の正本になる。`agent: true` は、利用者のデータを変えない画面の表示だけの操作に限る。
  layout が変わるものは layout の退避で元に戻せる。例外は `openSettings`（Settings を開くだけで、利用者が閉じれば戻る。退避には含まれず、結果は `undoable: false`）。
  `agent: true` の一部のパネルは、mount したときに派生データや初期データを書く（Matrix の mention 索引の backfill、Map の "Main" board の作成、Codex の `ensureBuiltinTypes`）。
  どれも利用者の既存のデータを消したり変えたりはしないので「データを変えない」の範囲として受け入れる（索引・初期の board・組み込みの型を補うだけで、本文・Codex の項目・board の内容には触れない）。
  これと区別して、利用者のデータを消すものは出さない（次の TrashBin）。
  agent に出さないもの: `toggleExport`（blocked）、`splitVertical`／`splitHorizontal`／`nextTab`／`prevTab`（tab の model と開いている場面を変え、layout の退避では戻せない。active scene の切替が chat の scope に与える影響は未確認）、
  `focusChat`／`focusChatHistory`（agent が今動いているパネル。既定の配置では同じ slot で、片方を出すともう片方が隠れ、「元に戻す」の表示ごと見えなくなる）、
  `focusTrashBin`（`TrashBinPanel` が mount 時と 1 時間ごとに `pruneTrashItems` で保持期間を過ぎた項目を DB から永久に削除するので、agent が開くと確認なしの削除が起きる。2026-11-16 に独立レビューの指摘で `agent: false` にした。利用者のキー操作は従来どおり）。
- キー以外の呼び出し元は、host が `commandContext` に登録した文脈を使う（`runRegisteredAppCommand`）。登録は後勝ちの 1 枠で、host は 1 つだけの前提（§7）。

### 4.2 agent に許可する設定の目録

全設定の schema 化はしない。**agent に変えさせてよいキーだけ**を登録する。

```ts
interface AgentSettingEntry {
  key: string;                   // settingsStore のキー
  type: "boolean" | "number" | "enum" | "string";
  range?: { min: number; max: number; step?: number };
  options?: string[];            // enum
  categoryId: string;            // 設定画面のカテゴリ
  labelKey: string;
  descriptionKey: string;
  scope: "global" | "project";   // KEY_SCOPE と一致することを試験で確かめる
}
```

- キー・既定値・カテゴリは `types.ts` の `DEFAULT_SETTINGS`・`KEY_SCOPE`・`SETTINGS_CATEGORIES` から引き、二重に持たない。
- 目録に無いキーは、agent からは読めるが変えられない。設定画面へのリンクで案内する。
- 秘密の値（API key、endpoint の URL 等）は、目録に載せず、値も返さない（§7）。

### 4.3 ヘルプ文書（判断の部分）

- 置き場所: `src/help/*.md`（案。言語は §10.2 の 3）。`import.meta.glob` で bundle に入れる。
- 1 見出しに 1 つの質問を書く。見出しは利用者の語彙にする（「Codex の別名を付けるには」など）。
- frontmatter に関連する事実の ID を書く。

```md
---
id: layout.presets
commands: [applyLayoutPreset, openLayoutPresetDropdown]
settings: []
panels: []
---
```

- 本文には、キーやラベルを直接書かずに `{{command:focusScenes}}` のような参照で書く。表示時と agent への返却時に、実際のキー割当と UI 言語のラベルに展開する。
  これでキーの変更が文書に波及しない。

### 4.4 ヘルプの索引（HelpIndex）

実行時に次の 3 つを合わせて作る。

1. コマンド registry（`agent` の有無にかかわらず全件。説明と実際のキー割当）
2. 設定のカテゴリ一覧と、agent に許可された設定
3. ヘルプ文書の見出し

## 5. Chat ツール（案）

| ツール | capability | 内容 |
|---|---|---|
| `get_app_help_index` | read | 項目の一覧（ID、題、種類）を返す。`query` を受け取って絞り込める |
| `get_app_help` | read | 1 項目の詳細を返す。コマンドは実際のキー割当・OS での可否、設定は現在値と範囲、文書は本文（参照を展開した後） |
| `get_ui_state` | read | 開いているパネル、フォーカス、適用中のプリセット、設定画面の開閉、現在の場面の ID と題（`activeScene: { id, title }`。題は既存の `get_scene` 等と同じ開示範囲）。本文は返さない |
| `run_app_command` | write（§10.1。`ui` は新設しない） | registry の `agent: true` かつ `risk: view` のコマンドだけ実行する。入力は command id（enum は registry と試験で一致を固定） |
| `apply_layout_preset` | write（同上） | 組み込み・利用者の保存済みのプリセットの既存 id だけ適用する。ロック中・phone 幅・パネルの別ウィンドウでは拒否 |
| `propose_setting_change` | write | 目録の設定を変える提案。Chat に前後の値を示すカードを出し、利用者が適用する（§6） |

- 返却は短くする（索引は 1 項目 1 行）。
- 実行系のツールは、結果とともに更新後の UI 状態を返す（`ui`。`get_ui_state` と同じ組み立て）。利用者の操作で状態がずれた場合に気づけるようにするため。
  あわせて `layoutChanged`、`undoable`（元に戻せるか）を返す。layout が変わらなかった操作と、layout の退避に含まれない操作（Settings を開く等）は `undoable: false` で、元に戻せるとは言わない。
- 元に戻す: 実行の直前の表示状態（layout store の配置・プリセット・非表示の Stripe・最大化・オーバーレイと、phone 幅の画面切替）をメモリ上に退避し、chat の tool 結果（`ToolCallBlock`）に「元に戻す」ボタンを出す（確認は求めない）。
  message metadata（DB）に保存するのは `undoId` だけで、配置の写しは保存しない。再読込・再起動後は退避が無いのでボタンは出ない。戻せるのは 1 回で、先の操作を戻すと、それより後の操作の退避は無効になる。
  退避には、操作の直前の写しのほかに、操作の直後の写し（`after`。比較の範囲は退避と同じ）と、登録のときの phone 幅かどうかも持たせる。「元に戻す」を押した時点で次のどれかなら、何も変えずに戻さず、カードに理由を出す（`failed`）:
  - 画面の幅の profile（phone か否か）が登録のときと違う →「画面の幅が変わったため戻せません」
  - 今の状態が操作の直後と違う（利用者や別の操作が後で配置を変えた）→「その後に配置が変わったため戻せません」
  - 写しの配置を今の画面で復元できない（store が棄却する）。
  このため、複数の操作を戻すときは後の操作から順に戻す（後の操作を戻して状態が先の操作の直後と同じになれば、先の操作も戻せる）。
  inline AI の未確定の結果があるときも戻さない（本文を守る。`blocked`）。
  `openSettings` は退避に含まれず `undoable: false`（Settings は利用者が閉じれば戻る）。
- 1 応答（agent loop 1 回）で UI 操作ツールを実行できる回数は 10 回まで（`MAX_UI_OPERATIONS_PER_TURN`。失敗も数える）。一般の tool 呼び出し上限は 1 バッチの中の呼び出しを数えず全ツールの合計なので、別に設けた。「続行」で始まる新しい応答は新しい枠。
- 新しいツールは `agent-tool-manifest.json` に足すので、どれも `grimodex-ai` の build.rs（Rust の parser）に取り込まれる。
  read だけの PR でも Rust の build と試験を通す。`ui` の capability は新設しない（§10.1）ので Rust 側の型は変わらない。ただし write のツールは `HERMES_BLOCKED_TOOL_NAMES`（build.rs が manifest から生成）に入るため、Rust の試験 `hermes_blocked_tool_names_are_frozen` の一覧に足す。
- manifest の各項目（`requiredPolicy` と `allowedChannels` は §10.1 で決定。PR3 の 2 本は実装済み）:

| ツール | capability | requiredPolicy | allowedChannels | requiresUserConfirmation |
|---|---|---|---|---|
| `get_app_help_index`／`get_app_help`／`get_ui_state` | read | null | agent／hermes／native | false |
| `run_app_command`／`apply_layout_preset` | write | `chat`（PR3 で実装済み） | agent／native（hermes は入れない） | false（元に戻すで補う） |
| `propose_setting_change` | write | PR4 で決める（AiPolicy の新しい区分は作らない方針で、`chat` が基本） | agent／native（hermes は入れない） | PR4 で決める（提案だけで、適用は利用者が押す） |

## 6. 危険度と確認

| 段 | 例 | 扱い |
|---|---|---|
| view | パネルの表示・フォーカス、オーバーレイの開閉、検索パネルを開く、Settings を開く、プリセットの適用（PR3 で実装済み）。設定画面の特定カテゴリを開く（未実装） | 確認なしで実行。layout が変わるものは Chat のツール表示に「元に戻す」を出す。tab の分割・切替と場面への移動は、layout の退避で戻せず開いている場面が替わるので、agent には出さない |
| personal | フォント、表示、エディタの挙動など、目録に載った個人の設定 | `propose_setting_change` で前後の値のカードを出し、利用者が「適用」を押す。適用後も 1 回元に戻せる |
| blocked | API key・endpoint、provider の選択、ライセンス、MCP／IME の連携、バックアップの復元・削除、送信先や保存範囲に関わる設定、データの削除 | ツールに出さない。設定画面へのリンクだけを返す |

- personal を「確認なし」に変える選択（利用者がツールごとに許可）は、初版では作らない。
- 「適用」のボタンはモデルの出力から作らず、ツールの結果（目録で検証済みの提案）から renderer が描く。
- personal のカードは新設せず、既存の提案カード（`ChronicleProposalCard`、`CodexEntityProposalCard` 等）と同じ見た目・操作に揃える。

## 7. 信頼境界と脅威

脅威モデルは 2026-11-16 にユーザーが確定した（§10.1）。

### 7.1 想定する相手

- Chat は場面の本文、Codex、Web 検索の結果、取り込んだファイルを読む。そこに仕込まれた指示（間接 prompt injection）で agent が誘導されることを想定する。
  利用者本人は信頼する。誘導で起こしたい結果は、画面を勝手に動かす・隠す、設定を黙って変える、外へ送らせる、データを消させる、の 4 種類として扱う。

### 7.2 範囲内と範囲外

- 範囲内: PR3 の UI 操作ツール（view の表示操作）、PR4 の設定変更の提案。
- 範囲外（受け入れ済みの制限）:
  - Hermes の経路。OpenAI 互換の HTTP provider でモデル名に `hermes` を含む、またはツールの呼び出し方式を Hermes に設定した場合に使われる（`grimodex-ai` の `resolve_tool_protocol`）。
    本文の `<tool_call>` を拾うので、Web 検索の結果や本文に紛れた疑似の呼び出しと本物を見分けられない。
    write のツールは `HERMES_BLOCKED_TOOL_NAMES` に入り、低信頼の native provider（Ollama、OpenAI 互換、AiNovelist）でも塞がれる。ヘルプの read だけが使える。
  - 外部 agent 向けの `grimodex-mcp`（§1.2）と、renderer 自体の侵害。

### 7.3 必須の防御

1. 権限（manifest）: `capability: "write"`、`requiredPolicy: "chat"`、`allowedChannels` は agent と native（hermes を入れない）。`requiresUserConfirmation` は PR3 が false（元に戻すで補う）。PR4 は提案だけで、適用は利用者が押す。
2. AI ポリシー: 実行の前に `blockIfPolicyOff("chat")` で、chat が off なら拒否する（ターンの途中で policy が変わった場合の防御）。
3. 許可の範囲: 実行できるのは registry の `agent: true` かつ `risk: "view"` のコマンドと、既存のプリセットの id だけ。
   未知の id、agent に出さないもの、blocked、今は使えない状態は、副作用なしで error を返す。モデルが作った id は実行しない。ツールの inputSchema の enum も registry と一致させる（試験で固定）。
4. agent に出さないもの: export、ファイル書出し、外部送信、AI 設定（provider・key・endpoint）の変更。registry では export が blocked、設定は PR4 の目録に載せない。
5. 連打の抑止: 1 応答で UI 操作ツールは 10 回まで。
6. 取り返せること: 実行前に表示状態を退避し、chat の tool 結果から 1 回で元に戻せる。操作の後に配置が変わった場合と画面の幅が変わった場合は戻さない（後の手作業を巻き戻さない）。戻せない操作は、戻せるとは言わない（`undoable: false`。Settings は利用者が閉じれば戻る）か、agent に出さない（tab の分割・切替）。
7. 実行できない場所: host が無い（no-host）とパネルの別ウィンドウ（host は別ウィンドウでも mount されるので、`isPanelWindow()` で拒否する）は、両ツールを拒否する。phone 幅とレイアウトのロック中は `apply_layout_preset` を拒否する。
8. host は 1 つの前提: `commandContext` の登録は後勝ちの 1 枠で、host が 2 つ以上同時に mount されると、後の host が外れた時点で登録が空になる。その場合は no-host の error として扱い、推測で実行しない。
9. 研究サブエージェントは read だけ（`executeReadOnlyTool` が write のツールを拒否する）。宣言していないツールは agent loop が拒否する。
10. 秘密: `get_app_help`／`get_ui_state`／UI 操作の結果は、秘密の値（API key 等）と endpoint の URL を返さない。返すのは「設定済みかどうか」の真偽だけ。
11. PR4（設定変更）: 提案だけで、適用は利用者が押す。適用できるのは承認済みの 15 キー（§10.1）で、global のみ。renderer と main の両方で検証する。

### 7.4 受け入れること

- 本文などの指示で、パネルの開閉・プリセットの切替・Settings の表示が確認なしで起こりうる。表示だけで、データ・外部送信・設定は変わらず、10 回の上限と「元に戻す」で収まる範囲として受け入れる。
- 元に戻すは layout の表示状態だけで、メモリ上にある。再読込後は出ない。操作の後に配置が変わった場合（利用者の手作業を含む）や画面の幅が変わった場合は戻さず、カードに理由を出す。後の変更を巻き戻さないための判断で、複数の操作は後のものから順に戻す。
- `agent: true` のパネルの一部は mount 時に派生データや初期データを書く（§4.1）。利用者の既存のデータを消したり変えたりはしないので受け入れる。データを消す TrashBin は agent に出さない。
- `openSettings` は退避に含まれない（`undoable: false`）。利用者が Settings を閉じれば戻る。
- Chat が見えなくなる操作は、`focusChat`／`focusChatHistory` を外しても残る（利用者が Chat と同じ slot に置いた別のパネル、Chat を含まないプリセット）。
  その場合も「元に戻す」は会話の履歴のカードに残るので、Chat を開き直せば押せる。拒否はしない（プリセットは利用者が頼んだ配置のため）。
- Hermes と低信頼の native provider では UI 操作が使えない（§7.2）。
- host が複数 mount された場合は、UI 操作が no-host で使えなくなる。

### 7.5 境界

- ツールの実行は renderer 内で完結し、新しい IPC・外部送信先・保存範囲は作らない。ただし manifest は Rust の parser と共有なので、ツールの定義は renderer の外にも届く（§5）。
- 設定の変更（PR4）は既存の `settingsStore.set` の経路を通す。Main 側の再検証は PR4 で足す（§10.1）。

## 8. 検証

1. **ずれの検出（CI、unit）**
   - ヘルプ文書の frontmatter と本文の参照が、registry・目録・パネル ID に実在すること。
   - `agent: true` のコマンドと目録の設定に、ja／en の説明があること。
   - 目録の `scope` が `KEY_SCOPE` と一致すること。
   - registry に無いキー処理が `GlobalCommandHost` に残っていないこと。
2. **挙動の同一性**: registry への移行（§9 の 1）で、既存のキー操作の試験が全部通ること。
3. **AI の振る舞い**: ツールの定義と system prompt の変更は AI behavior asset。`grimodex-author` と `grimodex-impact-gate` を適用し、
   `evals/quality-manifest.yaml` に次の小さな eval を足す（PR3 の時点で light corpus は上限の 35 件でちょうど満杯のため、PR3 では eval case を足さず、
   拒否・権限・上限・元に戻すを vitest（`appUiTools.test.ts` 等）で固定した。eval の追加は上限の扱いを決めてから）。
   - 「〜するには？」に、実際のキー割当と出典 ID で答える。
   - 存在しない機能を聞かれたら「無い」と答える。
   - 本文中に埋め込まれた「設定を変えて」という指示では、設定を変えない。
   - blocked の設定を頼まれたら、リンクで案内する。
4. **UI**: 変更前後のカードと「元に戻す」は、通常の component 試験。配置の寸法に関わる変更をする場合だけ `pnpm test:browser`。

## 9. 段階的な導入（別々の PR）

1. **コマンド registry への移行**: `GlobalCommandHost` と `tabSwitchKeybinding` の処理を registry の `run` に移す。挙動は変えない。説明の i18n の key を足す。
2. **ヘルプの read ツール**: ヘルプ文書の置き場所、HelpIndex、`get_app_help_index`、`get_app_help`、`get_ui_state`、ずれの検出、eval。
   wiki から使える内容はヘルプ文書へ写してよいが、wiki はそのまま残す（§1.2）。
3. **view の UI 操作**: `run_app_command`、`apply_layout_preset`、元に戻す操作。
4. **personal の設定変更**: 設定の目録、`propose_setting_change`、前後のカード。
   agent に新しい権限を与えるので、**許可するキーの一覧を着手の時点でユーザーに確認する**。

3 と 4 は agent に新しい操作の権限を与える。着手の前に GDX-PRECHECK-001（`policies/quality/iron-laws.md`）の対象かを確かめる。
（PR3 は 2026-11-16 に実装。脅威モデルと権限は §7・§10.1。）

## 10. 決定事項と未決事項

### 10.1 決定（ユーザー）

2026-11-15:

- GitHub wiki は当面残す（§1.2）。
- 人がアプリ内でヘルプ文書を読む画面は作らない（§1.2）。ヘルプ文書は agent 向けだけとする。
- MCP（`grimodex-mcp`）は各ツールの説明で足りるとし、本書の範囲外とする（§1.2）。
- Hermes の経路ではヘルプの read だけを使え、UI 操作と設定変更は使えない。これを制限として受け入れる（§7）。

2026-11-16:

- 脅威モデル（§7）を確定した。本文・Codex・Web 検索の結果・取り込んだファイルに仕込まれた指示で agent が誘導されることを想定する。
- PR3／PR4 のツールの権限: manifest の capability は `write`（`ui` は新設しない）、`requiredPolicy` は `chat`（AiPolicy の新しい区分は作らない）、
  `allowedChannels` は agent と native（hermes は入れない）。Hermes の経路には出さない（受入れ済みの制限）。実行の前に AI ポリシーで chat が off なら拒否する。
- PR3（UI 操作）は確認なし＋元に戻す（`requiresUserConfirmation: false`）。
- PR4（設定変更）は提案だけで、適用は利用者が押す。対象のキーは **15 件**、global のみ、renderer と main の両方で検証する。
  ユーザーは 2026-11-16 に推奨の 16 件を承認し、そのうえで統合者が、読み手がコードに無く適用しても効かない `display.showWordCount` を 1 件外した（承認した範囲を狭めただけで、広げていない）:
  `editor.fontSize`、`editor.lineHeight`、`editor.maxContentWidth`、`editor.paragraphSpacing`、`editor.fontFamily`（選択肢のみ）、`editor.typewriterMode`、`editor.focusMode`、
  `editor.showInvisibles`、`editor.showStickies`、`editor.bubbleMenu`、`editor.autoPairBrackets`、`editor.smartQuotes`、
  `display.reduceMotion`、`display.codexHighlight`、`display.codexHighlightOpacity`。
- export、ファイル書出し、外部送信、AI 設定の変更は、agent に出さない。

### 10.2 未決（着手時に決める）

1.・2. は 2026-11-16 に決定し、§10.1 に移した（personal の設定キーは承認済みの 15 キー（推奨 16 件から効かない 1 件を外した。§10.1）。`ui` の capability は新設せず `write`、requiredPolicy は `chat`、native は許可し hermes は入れない）。
3. （決定済み・2026-11-16）ヘルプ文書の言語は **ja だけ**。人が読む画面を作らないので、ja だけで書き、agent が利用者の言語で答える。
   コマンド・パネル・設定カテゴリの UI の名前とキーは文書に直書きせず、`{{command:<id>}}`・`{{panel:<id>}}`・`{{settings:<id>}}` などの参照で書き、
   返すときに UI 言語のラベルと実際のキー割当に展開する（ja だけで書いても en の UI と食い違わない）。存在しない ID への参照は試験で落とす。
   コマンドの説明文は文書ではなく locales の `help.commands.<id>`（ja／en の両方）に置き、`getCommands()` の全件に付ける。
4. 将来、同じ索引を `grimodex-mcp` に出すか。MCP は renderer の実行時状態が見えないため、出せるのは静的な部分だけになる。

## 11. 参考（2026-11-15 に Exa で調査）

確立した標準ではなく、複数の実例に共通する型として参照した。

- VS Code の `@vscode`（設定とコマンドの索引をツールで引き、Settings を開くボタンを返す）: https://code.visualstudio.com/blogs/2023/11/13/vscode-copilot-smarter
- 事実は生成し判断は人が書く、正準の答え: https://github.com/dagaza/Qube/blob/main/docs/in_app_help_knowledge_base.md
- 文書のずれを CI で落とす: https://github.com/getmaat/maat 、https://dev.to/github_7727/docs-rot-when-facts-change-not-when-drafts-are-wrong-a-fact-fingerprint-drift-gate-3n7k
- 索引 → 詳細の 2 段の取得: https://docs.pmnd.rs/agents/introduction
- 根拠の無いときに答えない、出典を示す: https://www.zealoop.com/blog/documentation-chatbot-guide 、https://docsascode.co/posts/in-product-ai-assistance-powered-by-documentation
- Generative UI の型と失敗例（登録済みの部品だけ、UI 状態を毎回渡す、取り返せない操作は人が確定）: https://vikasgoyal.github.io/agentic/patterns/generative-ui/
- 確認・元に戻す・権限の点検項目（OWASP LLM06、Microsoft HAX、Apple HIG を引用）: https://uxpickle.com/templates/agentic-ai-ux-checklist/
