# Grimodex 横断セキュリティ監査レビュー

対象: Grimodex master @ `c173e1e9`（Tauri v2 / React 19 / Rust）
手法: 8次元の多エージェント fan-out（read-only investigator）→ 各 finding を3名の異種 skeptic（REACHABILITY / EXPLOITABILITY / CLAIM-CORRECTNESS）で敵対的検証。入力→シンクの end-to-end トレースが ≥2/3 で成立した場合のみ CONFIRMED。確定 finding はレビュー後にメイン側でソース直接裏取り済み（`workspace.rs:40-80` / `typoFix.ts:27-67` / `schema.ts` / `toolExecutors.ts` 確認済）。
評価日: 2026-06-04
総合リスク: **Medium**（出荷ブロッカーなし。実害トレースが live exploit に至るものは1件もなく、全 finding が「攻撃者影響下のディレクトリを mount」または「先行する renderer 侵害」という前提付き。Medium 評価は唯一 RUST-DOS-01 が牽引し、その lens 判定も 2:1 で Medium/Low に割れている。既に hardening 済みのコードベースとして near-clean だが「クリーン」とは言わない）

特権シンクの定義: ①任意パスへのファイル/DB書込（Rust IPC または plugin-fs scope）、②外部 mount 内容の無制限読込（メモリ枯渇 abort）、③SSE/ZIP 等の無制限デコード、④AI出力の本文書込（bodyWrite policy）、⑤file:// 検証成果物への反射 XSS。

---

## 1. 確定（実害トレース成立 ≥2/3）

確定 finding は 7 件（PIO-2 と TAUCAP-01 は同一実体のため統合）。Critical/High はゼロ。

### Medium ×1

#### RUST-DOS-01. external-mount の `.md` ファイルを無制限 `fs::read_to_string` する（メモリ枯渇 DoS / プロセス abort）
- **重大度**: Medium（lens 判定は REACHABILITY=Medium / EXPLOITABILITY=Medium / CLAIM-CORRECTNESS=Low の 2:1。CLAIM 側は「ローカル可用性クラッシュのみ」を根拠に Low、他2名は uncatchable abort と scan の全ツリー蓄積を根拠に Medium。Medium 採用）
- **場所**: シンク `src-tauri/src/external_mount/io.rs:35-39`（`read_text_file` → `fs::read_to_string` にサイズ上限なし、直後の `raw.replace("\r\n","\n")` で2コピー目を確保）。到達経路: `external_mount/scan.rs:109`（`scan_root`→`walk`、`.md` ごとに読込し `Vec<ScannedFile>` scan.rs:112-117 に全件同時保持）、`commands/external_mount.rs:214`（`external_mount_scan`）、`commands/external_mount.rs:169-176`（`external_mount_read_file` 単一ファイル経路）、`external_mount_register`（lib.rs:216）。
- **トレース（成立）**: ユーザが攻撃者影響下のディレクトリ（同期/共有フォルダ、clone した `.md` ノートリポ等）を mount → `external_mount_scan` 等の `#[tauri::command]`（lib.rs:216-222 登録、`src/features/external-mount/api.ts` から invoke）→ `walk` が全 `.md` を `read_text_file` で読込。サイズ/metadata ガードはモジュール内に一切存在しない（`MAX_SCAN_DEPTH=64` は再帰深度のみ、サイズは非ガード）。`resolve_under_root`（io.rs:8-32）は traversal を防ぐがサイズ制限はしない。マルチGBファイルで `String` 確保が失敗すると Rust の `read_to_string` は infallible 確保のため `handle_alloc_error`→`abort()`（panic strategy 非依存・catch 不能、`watch.rs` の `catch_unwind` は async 限定で捕捉不可）。同期コマンドのため abort は全プロセスを kill。scan は全ツリー内容を同時保持するため単一ファイル以上に増幅。さらに保存 mount は起動毎に再 scan されるため、巨大 `.md` を含む保存/同期 mount は起動時クラッシュをループしうる。
- **推奨**: `read_text_file` で読込前に `fs::metadata().len()` をチェックし上限（例 16-32 MiB）超過ならその1ファイルをエラーで弾く（または `Read::take` で capped reader）。scan 経路にも同じ上限を適用し、oversized 1件で scan/プロセス全体を落とさず該当ファイルだけ skip + 診断する。
- **修正の挙動影響**: サイズ上限を入れると「正当に巨大な `.md`（数百MB級の長編1ファイル）」が読込拒否される。上限値は実運用の最大ファイルを上回るよう設定し、scan 経路では拒否を fatal でなく skip + warn に落とすこと（さもないと正当な大ファイルで mount 全体が機能停止する）。

### Low ×5

#### PIO-1. `open_workspace` が未検証の caller 供給パスにディレクトリと SQLite DB を作成（plugin-fs の $HOME/** scope を bypass）
- **重大度**: Low（3 lens 全て Low、trace 全成立）
- **場所**: シンク `src-tauri/src/commands/workspace.rs:47`（`create_dir_all`）/ `:57-58`（`Database::new`）。入力 `src/features/workspace/store.ts:178-180`（`invoke('open_workspace',{path})`）。lib.rs:137 で invoke_handler 登録。
- **トレース（成立）**: `path:String`（workspace.rs:44）に対し scope/allowlist/canonicalize 検証ゼロ。`PathBuf::from(&path)`（:46）→ `create_dir_all`（:47、I/O の最初の操作）→ `grimodex.db` 作成（:57-58）→ `write_global_settings` で永続化（:76）。renderer 側の `validate_workspace_path`（:34）や `trustedWorkspaces` ゲート（store.ts:231-255）は Rust シンクを守らない。Rust コマンドのため plugin-fs の `$HOME/**` capability scope（capabilities/default.json:14-15）を構造的に bypass する。通常フローでは path はフォルダピッカ/recent/seed 由来の信頼値で、IMPORT/MOUNT/web/AI のいずれの untrusted 入力も制御しない。single-instance / deep-link / CLI argv / `RunEvent::Opened` といった非 renderer トリガは src-tauri に存在せず、XSS なしでの悪用は不可。被害は固定名 `grimodex.db` + 空ディレクトリツリー作成に限定（`create_dir_all` は既存を clobber せず、任意内容を任意ファイル名で書く primitive ではない）。defense-in-depth gap であり live exploit ではない。
- **推奨**: `open_workspace` で I/O 前に `path` を canonicalize し許可ベース（app data dir / 設定済み workspace root）配下を要求、システムロケーション指定を拒否、または同一セッションで dialog plugin が返した path であることを要求。最低でも本コマンドが renderer を信頼している旨を文書化し、existence/empty チェックの背後にディレクトリ作成を gate する。
- **修正の挙動影響**: 許可ベース配下に限定すると「フォルダピッカで任意の場所に workspace を新規作成/オープンする」UX が壊れる。recent-workspace 経路や seed 経路も同一コマンドを通るため、許可リスト方式にする場合はこれら正規経路の path を allowlist に通すこと。dialog-issued path 検証方式の方が UX 影響が小さい。

#### PIO-2 / TAUCAP-01（統合）. fs write scope `$HOME/**` が save-dialog 用途より過大（defense-in-depth over-grant）
- **重大度**: Low（PIO-2・TAUCAP-01 とも 3 lens 全 Low、両 finding は同一実体 — capabilities/default.json:14-15 の同一過大付与・同一修正。2次元の fan-out が独立にヒットしたため2件として上がったが、1 issue として計上）
- **場所**: `src-tauri/capabilities/default.json:14-15`（`fs:allow-write-text-file` / `fs:allow-write-file` を `$HOME/**` scope で付与）。`gen/schemas/acl-manifests.json` 確認: `allow-write-file` は `write_file`/`open`/`write` を、`allow-write-text-file` は `write_text_file` を解放。正規 caller は save-dialog 経由の export（ExportDialog.tsx:154-159、ZipExportDialog.tsx:28-33、LinterPanel.tsx:1583-1591、exportTimelapse.ts:211-217、useMapExport ×3、MatrixPanel.tsx:338）。
- **トレース（成立）**: plugin-fs は write コマンドの `path` 引数を static scope に対して検証し、その path が `save()` 由来かどうかは関知しない（tauri-plugin-fs 2.5.1 `commands.rs` `resolve_path` 1485-1567、dialog plugin の `allow_file` は drag-drop Drop 時のみ runtime scope を追加し save() では追加しない）。よって侵害された renderer は `save()` を skip し `invoke('plugin:fs|write_text_file',{path,data})` を直接呼べ、static glob 単独が許可する。CSP は tight（default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'none'）で live XSS primitive は未発見のため、先行する renderer 侵害が前提の chained issue。
- **被害（プラットフォーム補正済）**: `require_literal_leading_dot` は Unix 既定 true（tauri 2.11.2 `scope/fs.rs:198-208`、tauri.conf.json に fs.scope override なし）のため、`~/.bashrc` / `~/.ssh/config` / `~/.zshrc` / `~/.config/autostart/*` は **Linux/macOS では `$HOME/**` にマッチせず書込不可**（finding 原文の dotfile 例は Unix では不正確）。実効ベクタは macOS `~/Library/LaunchAgents/*.plist`（dot なし・ログイン永続化）、Windows の Startup フォルダ + Windows では既定 false のため dotfile も全面マッチ、全プラットフォームで非 dot ファイル（ユーザの小説/プロジェクトデータ、`~/Documents/*` 等）の上書き・破壊。
- **推奨**: (1) export を Rust コマンド経由にし dialog 返却 path を validate/canonicalize して renderer の直接 fs-write 能力を除去（CLAUDE.md の Tauri command 方針と整合）。または (2) scope を現実的な export root（`$DOWNLOAD`/`$DOCUMENT` 等）に narrow し、機微 dotfile/dir に deny を追加。
- **修正の挙動影響**: `save()` は dialog path を fs scope に登録しないため、`$HOME/**` 付与は export 機能の動作に load-bearing で**単純削除は不可**。narrow すると「任意の場所に export 保存」UX が制約される。Rust コマンド経由化（(1)）が UX を保ったまま blast radius を縮める最善手。

#### XSS-01. バンドルされる standalone chain verifier（verify.html）が attacker 制御の sequence 番号を未エスケープで innerHTML 反射
- **重大度**: Low（3 lens 全 Low、trace 全成立。innerHTML への `<img onerror>` 注入なので Info ではなく code execution、ただし file:// opaque origin / CSP なし / cookie・secret なしのため High/Critical ではない）
- **場所**: シンク `src/features/timelapse/verifyHtmlTemplate.ts:98`（`result.innerHTML = '...Chain broken at sequence ' + v.brokenAt + '...'`、`v.reason` は escapeHtml されるが `brokenAt` は未エスケープ）。source `:135`/`:153`（`brokenAt = ev.sequence`）、`:92`（dropped file の `JSON.parse`）。`escapeHtml` は :105 に既存。テンプレートは `zipExport.ts:72` で export zip に verbatim 同梱。
- **トレース（成立）**: 受信者が file:// で verify.html を開き crafted chain.json（または zip 内の chain.json）を drop → `JSON.parse`（:92、`Array.isArray` のみ検証、`sequence` の型検証なし）→ `verifyChain`。攻撃者は valid-hex だが不一致な `hash` を持つ単一 event を作り `hexToBytes`（:151）を通し `bytesEqual`（:152）で失敗させ `{ok:false, brokenAt: ev.sequence}`（:153）を返す。`ev.sequence` は数値強制されず verbatim。`:98` で未エスケープ連結 → `sequence` を `<img src=x onerror=...>` にすると innerHTML 注入で onerror が発火（`<script>` は剥がされるが img/svg の onerror/onload は実行）。テンプレートに CSP meta はなく（head :23-48）file:// は inline ハンドラを自由実行。アプリ内経路（TimelapsePlayer.tsx:139 → React 描画）はエスケープされ非脆弱、standalone テンプレートのみ。
- **推奨**: `verifyHtmlTemplate.ts:98` を `escapeHtml(String(v.brokenAt))` で包む（`escapeHtml` は :105 に既存）。`chain.length` 補間（数値）も堅牢化のため同様に。
- **修正の挙動影響**: なし。エスケープは表示文字列のみ変え、verifier の検証ロジック・正常系表示に regression なし。

#### AI-1. AI 誤字修正が bodyWrite policy gate なしでモデル生成テキストを本文へ書込
- **重大度**: Low（3 lens 全 Low、trace 全成立。policy 契約違反だが攻撃者操作性は弱く、増幅要素は全て不在）
- **場所**: シンク `src/features/post-effect/typoFix.ts:47`（`editor.chain().focus().insertContentAt({from,to}, suggestion).run()`）。ungated トリガ `CurrentSceneTypoView.tsx:356-363` / `390-402`、`ProjectTypoView.tsx:312-319`。
- **トレース（成立）**: プロジェクト policy = assist-off（preset.ts:7 → `{chat:true, bodyWrite:false, analysis:true}`）。typo 解析は `blockIfPolicyOff("analysis")` のみで gate（CurrentSceneTypoView.tsx:79 / ProjectTypoView.tsx:108）され assist-off で許可 → モデルが suggestion 文字列付き annotation を返す（bodyWrite off でも AI 著作の suggestion が存在）→ Quick Fix wrench は `canFix`（suggestion/foundText/editor/status のみ確認、bodyWrite 非確認）が true で表示 → human クリック → `applyTypoFixAndResolve` → `insertContentAt`（:47）で AI テキストが本文置換・autosave 永続化。比較対象の本文書込 sink は両方 bodyWrite gate を持つ（useBeatGeneration.ts:170、useInlineAiDiff.ts:75、inlineAiCommands.ts:59）が、typo-fix 経路のみ欠落。root cause は決定論的 `ローカル検出` applyFix（rule-based、正しく ungated）を AI suggestion 経路にそのまま流用したオーバーサイト（typoFix.ts:18-19 のコメントが裏付け）。被害上限は previewed（ボタン title `:393`/`:357`）・単一スパン・undo 可能・自分の doc への plain text 挿入（schema 制約された ProseMirror 挿入なので XSS なし）。
- **推奨**: `applyTypoFixAndResolve` 先頭に `if (blockIfPolicyOff('bodyWrite')) return;` を追加、かつ/または bodyWrite useAiGate で `canFix` を gate し assist-off 時 wrench を非表示に。
- **修正の挙動影響**: assist-off 時に AI typo Quick Fix の wrench が消える（これが意図した修正）。**決定論的 `ローカル検出` の `applyFix`（CurrentSceneTypoView.tsx:217-228）は AI 出力でないため絶対に gate しないこと** — 誤って gate すると非 AI 機能を壊す。

#### RUST-DOS-02. SSE ストリーム蓄積バッファに最大サイズ上限がない（separator なしストリームでのメモリ増大）
- **重大度**: Low（3 lens 全 Low、trace 全成立）
- **場所**: `src-tauri/src/ai.rs:2309-2326`（`send_chat_stream` Anthropic 分岐）/ `:2434-2451`（OpenAI 互換分岐）。両 match arm とも `buf.push_str(&String::from_utf8_lossy(&bytes))` で全チャンク追記し、`find_sse_frame_separator(&buf)`（:2213-2221、`\n\n`/`\r\n\r\n` のみ Some）が Some の時だけ `buf.drain`。
- **トレース（成立）**: `send_chat_stream` は `send_chat_message_stream`（commands/ai.rs:179、`#[tauri::command]`）から呼ばれ renderer 到達可能。`OpenaiCompatible`/`Ollama` は base_url がユーザ設定（ai.rs:79-81,95）で、悪意/バグありの custom endpoint が SSE separator を含まないボディを stream すると `buf` が応答と共に無制限増大（上限・truncate・clear なし、rg 確認済）。`reqwest::Client::new()`（:2235）は read/total timeout なしのため slow stream も時間的に bounded されない。
- **緩和**: endpoint はユーザ自身の BYOK/設定済みプロバイダ（semi-trusted）。OpenAI/Anthropic/OpenRouter は hardcoded HTTPS で免疫。per-chunk `abort_flag` チェック（:2316/:2441）でユーザがキャンセル可能。被害は自プロセスの heap（self-DoS、メモリ安全違反なし・権限昇格なし・exfil なし）。
- **推奨**: chat（:2309）/ inline（:2435）両ループで `buf` 長を上限化（数 MiB 超で separator なしならエラー abort）。あわせて reqwest に stream/read timeout を設定。
- **修正の挙動影響**: separator なしで巨大な正当フレームを送る非標準 endpoint があれば拒否されうるが、SSE 仕様準拠 endpoint は影響なし。上限は実 SSE フレーム最大を十分上回る値に。

### Info ×1

#### PIO-3. `parseMarkdownZip` がユーザ供給 ZIP をサイズ無制限で全展開（ローカル DoS / zip-bomb）
- **重大度**: Info（REACHABILITY=Info / CLAIM-CORRECTNESS=Info / EXPLOITABILITY=false-positive の 2:1。EXPLOITABILITY は「攻撃者==被害者・transient self-crash・永続性なし」を理由に harm 不成立とするが、機構トレース自体は3名とも成立を認めており、Info として確定計上）
- **場所**: シンク `src/features/import/markdownParser.ts:150`（`unzipSync(zipBytes)`）。入力 `src/features/import/flows/MarkdownImportFlow.tsx:110-126`（`handleMultiZip`、`.zip` 拡張子チェックのみ）。
- **トレース（成立）**: ユーザが `.zip` を手動選択 → `file.arrayBuffer()`（:118）→ `parseMarkdownZip(new Uint8Array(buffer))`（:119）→ fflate `unzipSync`（同期・eager、全 entry を materialize してから `.md` フィルタ、:153-160）→ `strFromU8` で各 entry を文字列化。`file.size` 上限も per-entry/total 上限もなし。高圧縮率 entry でレンダラのメモリ枯渇 → タブクラッシュ。入力は自分で選んだファイル・自分のレンダラ処理で、cross-origin / 権限昇格 / 永続性なし。DB commit（runImport :172-220）は parse 済 in-memory tree のみ扱い raw zip を再展開しないため再起動 replay もなし。
- **推奨**（任意の堅牢化）: 展開前/中に total 展開サイズ・entry 数を上限化し、超過時はレンダラ OOM でなくエラートーストを出す。脅威モデル（手動操作・ローカル影響のみ）から優先度低。
- **修正の挙動影響**: 上限を入れると「正当に巨大な project zip」の import が拒否されうる。上限は現実的な最大 export サイズを上回る値に。

---

## 2. 降格 / 誤報（verify gate 未通過 — 再蒸し返し防止）

#### TAUCAP-02. Markdown フォルダ import が未付与の fs read コマンドを呼ぶ（機能非動作 / read-all 付与で「修正」すると scope-creep する latent リスク）
- **claimed**: Info
- **降格理由（3 lens 全て traceHolds=false）**: 特権シンク（plugin-fs `read_dir`/`read_text_file`）は**runtime で capability layer に拒否される**。`capabilities/default.json:14-15`（および解決済 `gen/schemas/capabilities.json`）は `fs:allow-write-text-file` / `fs:allow-write-file`（$HOME/** scope）のみ付与し、`fs:allow-read-dir` / `fs:allow-read-text-file` / `fs:read-all` / `fs:default` は一切なし。`acl-manifests.json` で `read_dir`/`read_text_file` はこれら read permission に bind され、`fs:default`（不在）も user-picked フォルダではなく app-specific dir のみ。fs plugin は登録済（lib.rs:70）でコマンド自体は expose され call graph も実在する（MarkdownImportFlow.tsx:133 → readDirRecursive:48-49 → collectMarkdownFromDir markdownFolderReader.ts:45,60）が、特権 read は filesystem アクセス前に拒否され MarkdownImportFlow.tsx:140 で catch → benign `folderError` トーストに degrade。dialog plugin は暗黙の fs read scope を付与せず、`tauri_plugin_fs::init()` は programmatic な `fs_scope().allow_directory()` 拡張なし。**今日 untrusted 内容は1バイトも読まれず、harm を伴う live な入力→シンク経路は存在しない。** 機能が単に動かないだけで、セキュリティ finding ではない（ただし将来 read-all 付与で「修正」すると新たな read scope-creep を持ち込む点はメモとして残す価値あり）。

---

## 3. 検証で「防御が効いている」と確認した主要面（assurance 成果物）

セキュリティのサインオフでは "no-bug" claim こそ成果物のため、load-bearing な無害判定を次元別に記録する。

- **Tauri command 入力検証（~85 handler）**: external_mount の path traversal は `resolve_under_root`（io.rs:8-32）が `..`/絶対/Prefix component を join 前に拒否 → root と leaf を両方 canonicalize → `canonical.starts_with(canonical_root)` を強制（symlink-escape も防御、canonicalize-at-use で TOCTOU 耐性、`rejects_parent_dir_traversal` で unit-test）。foreshadow/post_effect の `format!` SQL は hardcoded カラム名と `?` placeholder のみ補間し値は全て bound param。db_execute/db_execute_batch は意図された Drizzle sqlite-proxy 境界で `params_from_iter` bind・single-statement prepare。CLI 実行（cli_provider/mod.rs build_command:902-981）は discrete argv・shell 非経由でメタ文字注入不可、tools は hard-disable。BYOK key は OS keyring 保存・エラーに key 値は載らない。`semantic_search` limit は scoring 後 truncate で事前確保なし。

- **Path & file I/O**: `scan.rs` walk は symlink skip（:78）・`MAX_SCAN_DEPTH=64`（:66）・(dev,ino)/canonical 重複排除でディレクトリサイクル防止。`collectMarkdownFromDir`（markdownFolderReader.ts）も `MAX_FOLDER_DEPTH=64` + symlink skip でミラー。ZIP import（markdownParser.ts:149-237）は悪意ある entry path を in-memory タイトル/pathKey にするだけで fs write に使わず**zip-slip なし**。ZIP export（buildArchive.ts）は `Record<path,bytes>` を単一 blob 化、per-entry の fs write なしで zip-slip 不能。`seed_sample_workspace`（onboarding.rs:147-168）は固定 AppData path のみ対象。

- **BYOK API-key ライフサイクル**: key は OS keyring のみ（per-provider service 名）保存、`AiSettings` struct（ai.rs:196-219）に `api_key` field なしのため漏洩した `ai-settings.json` に資格情報は含まれない。egress host は key の provider に正しく bind（`resolve_api_key` commands/ai.rs:13-22 ↔ 各 request builder の同一 `params.provider` 由来 URL）。`AiSettingsPath` は固定グローバル path（lib.rs:84-85）で project import/mount/backup/migration から書込不能 → 悪意あるプロジェクトが egress host を操作不可。AI ファイル群に key logging 文（println!/tracing! 等）ゼロ。`AppError` は to_string シリアライズで、auth は常に header（URL ではない）のため reqwest エラーに key が載らない。CLI 経路は key を一切受け取らない。`get_api_key` は設計上 raw key を renderer に返すが正規 consumer は即座に hasApiKey boolean に縮約・破棄し、これは tight CSP で閉じた XSS/IPC 境界。browser-mode の localStorage key は dev-only（`__TAURI_INTERNALS__` 不在時のみ）。

- **SQL / Drizzle / FTS injection**: `execute.rs:75-94` は全 proxy param を rusqlite `ToSql` bind し値の文字列補間ゼロ・single statement（stacked query 不能）。FTS5 MATCH は全箇所 bound param（fts.rs:63/111/158、toolExecutors.ts、chatHistoryApi.ts:215）で、最悪でも malformed-FTS5 エラーが catch される（toolExecutors.ts:987）。`buildLikeOrClause`/`ftsPhraseOrQuery` は hardcoded カラム名 + `?` のみ補間、AI トークンは bound param、phrase の埋込引用符は `"`→`""` escape。動的 UPDATE SET（foreshadow.rs:211/726）は `column = ?` リテラルのみ、IN(...) は `.len()` 由来の `?` 数のみ。`add_column_if_missing` の `format!` は全25 call site が compile-time リテラル。ATTACH DATABASE は皆無。migration の `format!`（1627/1730/1807）は FK-check のエラー文字列で SQL ではない。**注: AI agent 検索ツールの project スコープについては §5 の未 gate 項目を参照。**

- **Webview XSS / CSP / IPC**: 本番 HTML sink は3つ（VerticalPreview.tsx:72 `getHTML()`、StickyNode.tsx:120 `generateHTML(JSON.parse)`、verifyHtmlTemplate.ts ※ §1 XSS-01 で確定）。前2者は ProseMirror DOMSerializer が境界 — `setAttribute` で属性値を必ずエスケープし schema 宣言済の属性名のみ emit するため crafted JSON で `onerror` 属性名を導入不能。`Node/Mark.fromJSON` は未知 type で RangeError → StickyNode で `''`。StarterKit v3 の Link mark は許可外スキームで `href:''` 強制。tiptap-markdown の `html:true` は inert な DOMParser を経由し ProseMirror schema が `<script>`/event-handler を drop。CSP は tight（script-src `'self' 'wasm-unsafe-eval'`、no unsafe-inline、connect-src `'self' ipc: http://ipc.localhost`、object-src `'none'`）。`withGlobalTauri` 不在、assetProtocol/deep-link/custom-protocol ハンドラ皆無、`dragDropEnabled:false`。AI/web-search 由来 URL は explicit click 時のみ opener plugin（http(s)/mailto/tel 限定、`allow-open-path` 非付与）へ渡る。`exportReport.ts` は全補間値を escapeHtml。

- **AI agent / prompt-injection sink**: `EXECUTORS`（toolExecutors.ts:947-964）は read-only DB query 14個のみ・`Object.freeze` 済・allowlist テストで membership 固定。`agentLoop.ts` の declaredToolNames gate（:133,222-242）が未宣言 tool_use を error tool_result で拒否。`guardedExecuteTool`（chatStore.ts:2647-2694）は ask_user のみ特別扱いし他は frozen read-only executor へ。inline AI / Beat は `blockIfPolicyOff('bodyWrite')` で hard-gate（useInlineAiDiff.ts:75 / useBeatGeneration.ts:170）。`applyAnnotationsToEditor` は peAnnotation mark の追加/除去のみで本文挿入なし。chat→codex 抽出は human-initiated・Drizzle parameterized insert。summarization 出力は chat context 管理用で本文/DB に書かない。

- **Rust panic / DoS / unsafe**: request-path の untrusted 入力に到達する `unwrap`/`expect`/`panic!` は皆無（全て `#[cfg(test)]` 内、post_effect.rs の12散在 test module・foreshadow.rs の cfg(test)@1185 後30件まで cross-check 済）。AI レスポンスパースは `serde_json::Value` Index（欠落で `Null`、非 panic）。byte-range slice は全て char-boundary offset（preview.rs、`floor/ceil_char_boundary`、`find_sse_frame_separator`）。`semantic/search.rs` は BLOB→f32 で `len == dim*4` を index read 前に検証。codex_matching.rs は boundary cache で bounds-check。external_mount は §1 RUST-DOS-01 の read サイズ以外は DoS-hardened。`unsafe` 2箇所は self-spawned child PID への libc FFI のみ。untrusted な count/size が unbounded 確保を駆動する箇所なし。

- **Tauri capabilities & plugin scope**: capability ファイルは default.json 1つのみ。CSP は tight（上述）。`withGlobalTauri` 不在、`dragDropEnabled:false`、assetProtocol 不在、`dangerousRemoteDomainIpcAccess` 不在。fs plugin は write permission のみ付与・read permission ゼロ（renderer は fs plugin で任意ファイルを読めない）。opener は http(s)/mailto/tel 限定で `allow-open-path` 非付与。dialog は open/save/message のみ。window-state/core:window は minimize/maximize/close/drag/zoom のみで window 生成/always-on-top なし。shell/process plugin は未登録（renderer 到達の shell/process 実行能力なし）。

---

## 4. 出荷判断

- **ブロッカー**: なし。確定 finding はいずれも live exploit に至らず、全て「攻撃者影響下ディレクトリの mount」または「先行する renderer 侵害（CSP tight で現状 XSS primitive 不在）」を前提とする。総合 Medium は RUST-DOS-01 単独が牽引。

- **優先修正順（根拠付き）**:
  1. **RUST-DOS-01**（Medium）— 唯一の Medium かつ唯一「ユーザ自身の侵害」を要さず攻撃者影響下の mount 内容だけで成立する経路。uncatchable abort + 保存 mount の起動時クラッシュループという可用性影響が他より重い。`read_text_file` のサイズ上限が最小・最効の修正。
  2. **AI-1**（Low）— bodyWrite=off というユーザ向け保証を AI 出力に対して静かに破る policy-enforcement gap。sibling 機能（Beat/inline AI）が正しい gate を持つため修正は機械的（`blockIfPolicyOff('bodyWrite')` 追加）。**`ローカル検出` applyFix は gate しない**点だけ要注意。
  3. **PIO-2 / TAUCAP-01**（Low、統合）+ **PIO-1**（Low）— renderer 侵害時の blast radius 縮小。$HOME/** narrow（または export の Rust コマンド化）と `open_workspace` の path 検証。どちらも UX 影響があるため Rust コマンド経由化が推奨。
  4. **XSS-01**（Low）— 修正が1行・regression ゼロのため安価。配布される検証成果物の信頼性に直結。
  5. **RUST-DOS-02 / PIO-3**（Low / Info）— 任意の堅牢化。脅威モデル（semi-trusted endpoint / 手動 zip 選択）から優先度低。

- **本監査で発見・後追い検証で CONFIRMED に昇格した項目（XPROJ-1）**:
  - **XPROJ-1【Medium】AI agent 検索ツールの project_id スコープ欠落（cross-project 情報漏洩）**: `searchCodex`（toolExecutors.ts:126-147）/ `searchScenes`（549-570）/ `searchSnippets`（613-635）の SQL（FTS・LIKE 両分岐）に `project_id` 述語が**ない**。一方 `grimodex.db` は単一ファイルに複数プロジェクトを保持（projects テーブル schema.ts:13、tree_nodes/codex_entries/snippets に project_id FK）し、Rust `search_fts`（fts.rs:40,63,89,111,136,158）および sibling `getOpenForeshadows`（toolExecutors.ts:706 `useTreeStore.getState().projectId`）・`getSceneTimelineNeighbors`（:868 `eq(treeNodes.projectId, target.projectId)`）は project でスコープしている。よって agent 検索ツールはアクティブでない**別プロジェクトの本文/設定資料/スニペットを返しうる**（agent 利用＋複数プロジェクトという軽い前提のみで成立する confidentiality バグ。既知の agent+RAG exfil チャネルと組むと越境内容が exfil されうるが、exfil なしでも「プロジェクトAについての回答にプロジェクトBの内容が混入する」正当性バグ）。plain query でも越境するため meta-character とは独立。**当初は EXPLOITABILITY lens 1名のみが提起し ≥2/3 gate を通過していなかった**が、これは「元 finding（SQL-INFO-1=meta-character 注入なし、3 lens 一致で正しい）とは別の新規観測のため独立した 3-lens を受けていない」という methodology アーティファクトであり実在性とは独立。**2026-06-04 にメイン側で 3 ツールの SQL・データモデル・sibling のスコープ実装を直接ソース確認し CONFIRMED に昇格**。優先修正順では RUST-DOS-01 と同格（むしろ precondition が軽い分だけ実効性が高い）。修正: 3ツールの SQL に `useTreeStore.getState().projectId` を bind した `AND project_id = ?`（tree_nodes は `tn.project_id`、codex は `ce.project_id`、snippets は `s.project_id`）を FTS・LIKE 両分岐へ追加し、Rust `search_fts` 契約とミラーする。**§3 の SQL assurance は「no cross-project leak」を保証しない**（本項で別途確定）。修正の挙動影響: 検索結果がアクティブプロジェクトに限定される（これが意図した修正）。projectId が未設定のセッション（プロジェクト未選択）では 0 件を返すよう fail-closed にする。

  - **追記（2026-06-04 修正時に判明）: 漏洩は 3 検索ツールに留まらず agent read ツール全般に系統的**。`toolExecutors.ts` の project データ読取ツールを全数点検した結果、`project_id` 述語を欠くのは次の 11 ツール: ① set 返却の実漏洩 9 件 = `searchCodex`(102) / `listCodexByType`(166) / `listCodexTags`(277) / `searchCodexByTags`(316) / `findRelatedEntries`(361) / `listChapters`(452) / `searchScenes`(526) / `searchSnippets`(591) / `getChapterSummaries`(659)、② id 鍵で実害は限定的だが fail-closed 防御を入れるべき 2 件 = `getCodexEntry`(195) / `getScene`(484)。スコープ済みは `listOpenForeshadows`(705) と `getSceneTimelineNeighbors`(815) の 2 件のみだった。agent はシステムプロンプト（chatStore.ts:997「このプロジェクト『…』」）上アクティブ 1 プロジェクトに限定されるため全ツールが project スコープであるべき。**修正は 3 ツールではなく 11 ツール全てに `useTreeStore.getState().projectId` を bind した project 述語を追加し、未選択時 fail-closed**（同一バグ class の完全閉鎖）。

---

## 6. 修正実装（2026-06-04）

ユーザー承認のもと、確定 finding（+ XPROJ-1 + PIO-3）を全て修正。Group C（PIO-1 / PIO-2）は「中庸」方針を選択。検証: `tsc` clean / `eslint` clean / JS 全 4275 tests pass（新規 16 含む）/ Rust 全 415 tests pass（新規 4 含む）/ `cargo check` + `cargo clippy --all-targets` clean。

| ID | 状態 | 変更点 | テスト |
|----|------|--------|--------|
| **XPROJ-1**（Medium） | ✅ 修正 | `toolExecutors.ts` の read ツール 11 件に `useTreeStore.getState().projectId` を bind した project 述語を追加（raw SQL=`project_id = ?` / Drizzle=`and(eq(table.projectId, projectId), …)`）、未選択時 fail-closed | `toolExecutors.test.ts` に project スコープ不変条件（raw SQL 5 件の `project_id` バインド + 全 11 件の fail-closed）を追加、差分検証可 |
| **RUST-DOS-01**（Medium） | ✅ 修正 | `external_mount/io.rs read_text_file` に 32 MiB サイズ上限（metadata 事前検証で abort 回避）、`scan.rs` は oversize/読込失敗を `?` 伝播でなく skip+warn 化 | cargo check/clippy/全 Rust test pass |
| **AI-1**（Low） | ✅ 修正 | `typoFix.ts applyTypoFixAndResolve` 先頭に `if (blockIfPolicyOff("bodyWrite")) return`。決定論ローカル applyFix は非 gate（不変） | `typoFix.test.ts` 回帰なし |
| **XSS-01**（Low） | ✅ 修正 | `verifyHtmlTemplate.ts:98` の `brokenAt` を `escapeHtml(String(...))` で包む（`chain.length` も堅牢化） | — |
| **RUST-DOS-02**（Low） | ✅ 部分修正 | `ai.rs` の SSE 蓄積ループ 2 箇所に `MAX_SSE_BUFFER_BYTES`(8 MiB) 上限（separator なしで肥大化したら中断）。**reqwest read/total timeout は defer**（buf 上限でメモリ枯渇 DoS は閉じる／total timeout は長時間の正当ストリームを切るため不採用、connect_timeout のみでは本件に無効） | cargo test pass |
| **PIO-3**（Info） | ✅ 修正 | `markdownParser.ts parseMarkdownZip` を `unzipSync` filter で .md のみ展開＋宣言サイズ 256 MiB / entry 数 50,000 上限（超過で throw、呼び出し側が toast） | `markdownParser.test.ts` 回帰なし |
| **PIO-1**（Low） | ✅ 修正（中庸） | `workspace.rs open_workspace` に `reject_unsafe_workspace_path`（絶対パス必須・`..`拒否・システムディレクトリ祖先拒否、外部ドライブ等は許容） | `workspace.rs` に 4 unit test 追加 |
| **PIO-2/TAUCAP-01**（Low） | ✅ 修正（**徹底**） | export を Rust 主導の save-dialog 経由化し、renderer の `fs:write` capability を**完全撤廃**。新コマンド `export_save_text`/`export_save_bytes`（`commands/export.rs`）が保存ダイアログを Rust 側で開いて書き込む（renderer はパスを渡さない）。renderer 8 経路を共通ヘルパ `src/lib/exportFile.ts` 経由に置換。`capabilities/default.json` から `fs:allow-write-text-file`/`fs:allow-write-file`/`dialog:allow-save` を削除 | `exportFile.test.ts`（base64 round-trip）+ export 系既存テスト pass |

**PIO-2 の最終状態（徹底案）**: 当初は中庸（fs scope を `$HOME/**` → `$DOWNLOAD`/`$DOCUMENT`/`$DESKTOP` に縮小）で着地したが、その後**徹底案に置き換え**。設計の肝: 単に「renderer がパスを渡す Rust write コマンド」を作ると無制限の任意書き込みプリミティブになり中庸より退行するため、**保存ダイアログを Rust 側で開いて user-chosen path にその場で書く**。結果: ① renderer に `fs:write` capability が一切無い（侵害されても任意パスへの silent write 不可、出せるのは可視・キャンセル可能な保存ダイアログのみ）② ダイアログで任意の場所を選べるので save-anywhere の UX 制約も解消。Tauri invoke 分岐は GUI 依存で自動テスト対象外 → `pnpm tauri dev` で各 export（md/txt・zip・map json/svg/png・csv・lint report・timelapse webm）の保存とキャンセルを手動確認すること。残注記: 大きい WebM の base64 IPC コスト（§Risks）。
