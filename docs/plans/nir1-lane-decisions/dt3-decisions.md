# DT-3 decisions（AttemptBinding v2：版 dispatcher、Scene の ABA 防止、session の分離）

- base：branch `claude/nir1-dt3`（DT-1 の commit `3688a063` の上）。DT-2 は別 worktree で並行中。書込み経路の構造（接続の取得、transaction の張り方、上限）には触れず、後で DT-2 の上に rebase する。
- 委任：U3（計画 `610-pr-c-query-nir-valiant-thunder.md` の DT-3 節、SPIKE の S4）。製品入口、N-API、IPC は追加しない（A-1）。schema／migration、schema 番号、`MAX_BINDING_JSON_BYTES`（64 KiB）は変えない。
- 行番号は記録時点（HEAD `3688a063`、未変更）のもの。`db:` は `src-tauri/crates/grimodex-db/src/`、`node:` は `electron/native/grimodex-node/src/`、`core:` は `src-tauri/crates/grimodex-core/src/` を表す。

## 0. 停止条件（HOLD）の判定

| 条件 | 判定 | 根拠 |
|---|---|---|
| 保存する識別子が receipt の tuple を超える（`[precheck]`） | 該当しない | §5 の対応表。binding に新しく入る値は、同じ attempt の参照行に既に保存される値（Scene の source token、A1 の incarnation）か、v1 で保存していた値を2つに分けたもの（chat session と caller session）か、本文ではない digest に限られる |
| schema の変更が必要 | 該当しない | Scene の incarnation には既存の列 `narrative_scene_scope_bindings.scene_incarnation_id`（db:migrate.rs:4073）を使う。chat session は既存の列 `nir1_generation_attempts.session_id`（db:migrate.rs:4109）に入れ、caller session は binding_json の中だけに置く |
| 委任外の6項目 | 該当しない | 送信先、保存範囲、閾値、製品公開、認可の削除、新しい authority のいずれも変えない。変更は claim と create の拒否条件を増やすだけ。新しく読む Scene 本文の上限には既存の確定値 Packing 2 MiB（core:narrative_nir1.rs:36）を使う |

## 1. 現状の欠陥（S4 で red にするもの）

### (a) Scene token（`v{version}@{updated_at}`）の ABA

- v1 の AttemptBinding（db:nir1_generation.rs:125-143）は Scene を持たない。Scene は入力参照 `RawSource{sourceKey: "project:scene:<id>", revisionToken: "v{version}@{updated_at}"}` として入るだけで、validate_refs は形式しか見ない（db:nir1_generation.rs:832-838）。claim（1857-1869、1911-1927）は Scene の現存、archive、同一性を見ない。
- token の各要素は、同じ Scene の別の incarnation で同じ値になりうる。
  - version：tree_node_create は version を書かず既定値 0 になる（db:domain_writes.rs:3123-3127、db:migrate.rs:8575）。trash からの復元も 0（db:trash_bin.rs:366-371）、AI tree plan は 1（db:domain_writes.rs:5374-5378）。snapshot 復元の行は version を持たないので 0 に戻る（db:project_snapshots.rs:1213-1257）。
  - updated_at：列の既定値は秒精度の `datetime('now')`（db:migrate.rs:556-557）で、trash 復元はこれを使う（db:trash_bin.rs:366-371）。AI tree plan は renderer 由来の `payload.updated_at`（db:domain_writes.rs:5386）、patch も `payload.updated_at`（db:domain_writes.rs:3618-3619）、snapshot 復元は取得時の値をそのまま書く（db:project_snapshots.rs:1255-1256）。
  - id：tree_node_create は renderer が選んだ `payload.id` を使う（db:domain_writes.rs:3123-3127）。trash 復元の id は `restored-scene:<item>`（db:trash_bin.rs:126-128）で、同じ item を再び復元すると同じ id になる。
  - 本文：snapshot 復元は取得時の本文をそのまま戻す。
  - archive：patch の `archivedAt`（db:domain_writes.rs:3559）は version を上げなくてよく（3621-3623）、updated_at も呼出し側の値なので、token を変えずに archive できる。
- 結果：削除して再作成した Scene、snapshot から戻した Scene、id を再利用した Scene に、古い attempt がそのまま一致する。archived の Scene にも一致する。

### (b) session の混同

- v1 の `session_id`（db:nir1_generation.rs:129）1つに2つの意味がある。
  - DB は chat session として検証する。`require_session`（706-716）は `chat_sessions(id, project_id)` を確かめ、validate_refs（742-748）は message version の chat session と比べる。呼出しは create（883）と claim（1862、1920）。
  - Native は Main の caller session を入れて比べる。組立ては `session_id: self.caller.session_id`（node:nir1_generation.rs:1106）、claim 前の比較は `binding.session_id == self.caller.session_id`（1219）。
  - Main の caller session は sender ごとの `randomUUID()`（electron/main/profileEgress.ts:648）で、chat_sessions の行ではない。Native も CallerIdentity の中で chat session とは別の値として持つ（node:profile_egress.rs:26-33）。
- Native の試験は caller session を chat session と同じ `"session-1"` にしているため（node:nir1_generation.rs:1597-1604）、この不整合が表に出ない。本番の形（caller session ≠ chat session）では create が `NIR1_GENERATION_SESSION_MISMATCH` で失敗する。逆に値を揃えると、2つの名前空間が混ざる。
- 前例：current Human capture は `caller_session_id` を chat session と分けている（db:nir1_generation.rs:385-402。コメントは「`caller_session_id` is deliberately not the chat session ID」）。

## 2. v2 の形

```rust
// db:nir1_generation.rs（v1 の 122-143 を置き換える。writer はこの版だけを書く）
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptBinding {
    pub binding_version: AttemptBindingVersion,      // "bindingVersion": 2（2 以外は deserialize で失敗）
    // DB が create と claim の同じ transaction の中で検証する
    pub project_id: String,
    pub chat_session_id: String,                     // chat_sessions.id。列 session_id にもこの値を入れる
    pub scene: AttemptSceneBinding,
    // process-local。DB は保存して一致を比べるだけで、現在値とは照合できない
    pub caller: AttemptCallerBinding,
    pub workspace_binding_digest: String,            // LiveBinding の digest（v1 と同じ）
    pub route_revision: String,
    // coordinator が渡す証明入力（v1 と同じ。typed reader を接続するまでは coordinator の責任）
    pub purpose: GenerationPurpose,
    pub scope_digest: String,
    pub material_digest: String,
    pub d1_digest: String,
    pub provider: String,
    pub model: String,
    pub api: String,
    pub endpoint_identity: String,
    // 予約 slot（常に null）
    pub history_turn_context: Option<ReservedBindingSlot>,
    pub durable_workspace_identity: Option<ReservedBindingSlot>,
}

#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptCallerBinding {        // Main が発行し Native が登録した caller（process-local）
    pub profile_id: String,
    pub caller_id: String,
    pub caller_epoch: u64,
    pub caller_session_id: String,       // profileEgress.ts:648 の sessionId。chat session ではない
}

#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttemptSceneBinding {         // D-final と同じ snapshot の値。DB が create と claim で読み直して照合する
    pub scene_id: String,
    pub scene_incarnation_id: String,    // narrative_scene_scope_bindings.scene_incarnation_id
    pub source_token: String,            // "v{version}@{updated_at}"
    pub body_digest: String,             // "sha256:" + hex(SHA-256(tree_nodes.content のバイト列))
}

pub enum ReservedBindingSlot {}          // 無人型。None（null）しか書けず、値があれば parse で失敗する
```

- JSON は今と同じく `canonical_json_string`（キー順が固定）で保存する（db:nir1_generation.rs:887）。識別子 12 個がそれぞれ最大 4 KiB（`MAX_ID_BYTES`、37）、digest が 6 個なので、64 KiB に収まる。上限の検査（887-891）と、読取側の octet_length による前検査（1086-1100）は変えない。
- `validate_binding`（671-694）を v2 用に置き換える。識別子は `identity()`、digest は `digest()`（`body_digest` を含む）で検査する。さらに `chat_session_id != caller.caller_session_id` を要求する（違反は `NIR1_GENERATION_SESSION_CONFUSION`）。2つが同じ値だと名前空間を区別できないので、組立ての取り違えとみなして拒否する。
- `StoredAttempt.binding`（354）と `NewAttempt.binding`（341）の型は v2 の `AttemptBinding` のままにする。legacy を表す型は dispatcher の内側にだけ置く（§3）。
- 列 `session_id` には `chat_session_id` を入れる（892-896）。index `idx_nir1_generation_attempts_session`（db:migrate.rs:4124-4125）の意味（chat session）は変わらない。

## 3. 版の dispatcher

```rust
enum VersionedAttemptBinding { LegacyV1(LegacyAttemptBindingV1), Current(AttemptBinding) }
fn parse_attempt_binding(json: &str) -> Result<VersionedAttemptBinding>
```

- 3か所の `serde_json::from_str::<AttemptBinding>`（db:nir1_generation.rs:1209、2965、3135）を、この関数1つに置き換える。その直後にある「列の project／session と binding の一致」の検査（1214-1217、2967-2970、3137-3140）も、同じ補助関数にまとめる。
- 判定の手順：まず `bindingVersion` だけを読む probe（他のキーは無視し、重複キーは serde が拒否する）で版を決める。次に、その版の struct で全体を parse する。どちらの struct も `deny_unknown_fields` を持つ。
  - キーがない：`LegacyAttemptBindingV1`（v1 と同じ 15 フィールド）。v1 の行は `bindingVersion` を書いたことがない。
  - `2`：`AttemptBinding`（v2）。
  - それ以外（`1`、`3`、`"2"` など）：`NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED`。`null` は probe ではキーなしと同じになるが、v1 の struct が未知のキー `bindingVersion` として拒否する。
- legacy は終端にするときだけ読める。
  - `read_attempt*`（1131-1239）は Current だけを返し、legacy なら `NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY` を返す。claim（1857、1911）、validate_refs での親の読取（765-769）、history の読取（1460-1506）はどれもこの関数を通る。そのため、legacy の claim と dispatch、legacy を親にした新しい attempt の作成、history での利用はすべて拒否される。
  - `read_terminal*`（2873-3012）は両方を受け付ける。既に書かれた終端は読めるようにする。
  - `finish_in_tx`（3114-3271）も両方を受け付けるが、legacy の `Succeeded` は拒否する（本文と message version を作らせない）。recover（3308-3314）は `DispatchFailure` による保守的な終端なので、legacy でも通る。
  - legacy は `chat_messages.model`（3205）を使う成功の経路に到達しない。
- 版を増やすとき（v3 以降）は、この関数に枝を足す。DT-3 の reader は v3 を `NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED` で拒否する。

## 4. Scene の incarnation：使う列の組とその根拠

### 選んだ組（すべて既存の列。schema の変更なし）

| 要素 | 列 | 検証 |
|---|---|---|
| 同一性 | `tree_nodes.id`、`tree_nodes.project_id`、`tree_nodes.node_type='scene'` | 行があること（なければ `NIR1_GENERATION_SCENE_UNAVAILABLE`） |
| incarnation | `narrative_scene_scope_bindings.scene_incarnation_id`（db:migrate.rs:4073。PK は `(project_id, scene_id)`。`scene_id` は `tree_nodes(id) ON DELETE CASCADE`。4068-4094） | 束縛値と完全に一致すること（`..._SCENE_INCARNATION_MISMATCH`）。行がなければ `..._SCENE_UNAVAILABLE` |
| source token | `tree_nodes.version` と `tree_nodes.updated_at` を `v{version}@{updated_at}` に整形する（既存の形：db:narrative_extraction/source_revision.rs:630-643、retrieval_admission/scene_source.rs:225） | 完全に一致すること（`..._SCENE_SOURCE_STALE`） |
| body digest | `tree_nodes.content` のバイト列の SHA-256（既存の `storage_digest` と同じ：retrieval_admission.rs:30-32、scene_source.rs:215） | 完全に一致すること（`..._SCENE_BODY_MISMATCH`） |
| live かつ未 archive | `tree_nodes` の行があり、`archived_at IS NULL`（db:migrate.rs:1622） | archived なら `..._SCENE_ARCHIVED` |

あわせて、chat session がその Scene に付いていることを確かめる。`chat_sessions.id = chat_session_id AND project_id = project_id` を満たす行がなければ、既存の `NIR1_GENERATION_SESSION_MISMATCH` にする。`node_id = scene.scene_id` でなければ `NIR1_GENERATION_SESSION_SCENE_MISMATCH` にする。`node_id` は Scene を削除すると NULL になる（db:migrate.rs:771）。current Human capture も、session の Scene と capture の Scene の一致を確かめている（db:nir1_generation.rs:2488-2492）。

### incarnation にこの列を選んだ理由

- Native だけが生成する不透明な UUID で、Scene の id、title、本文からは導出しない（db:narrative_extraction/scene_scope.rs:473-476 のコメント）。
- Scene の行を作る writer はすべて `ensure_scene_scope_binding_in_tx`（scene_scope.rs:423-464）を呼ぶ。この関数は、binding の行がなければ新しい UUID で作り（452）、行が残っていれば何もしない（436-447）。
- Scene の行が消えると binding の行も消える。FK の CASCADE（db:migrate.rs:4070-4071。`foreign_keys=ON` は db:lib.rs:334）と、tree_node_delete による明示的な削除（db:domain_writes.rs:3362-3366）の2経路がある。
- したがって、次のどの経路でも incarnation は新しい値になる：削除後の再作成（tree_node_create：3151-3158、AI tree plan：5390-5397）、snapshot 復元（tree_nodes を全部消してから挿入する：project_snapshots.rs:2795、2946-2961）、trash 復元（trash_bin.rs:408-413）、id の再利用。
- 値を更新する経路は現在の値を引き継ぐだけで、呼出し側から値を受け取らない（scene_scope.rs:1208）。
- `tree_nodes` と `narrative_scene_scope_bindings` は protected writer の table 保護が active で（policies/narrative/protected-writers.json:134、471。仕組みは db:protected_writers.rs:1-5）、renderer の汎用 SQL からは書けない。incarnation を書けるのは Native の writer だけ。
- binding の行がない Scene（どこかの writer が `ensure_scene_scope_binding_in_tx` を呼ばなかった場合を含む）は `..._SCENE_UNAVAILABLE` で拒否する（fail-closed）。
- NIR-1 の既存の読み手も、この列を Scene の incarnation として扱っている。Graph（nir1_graph/scenes.rs:519-521）、D-final の disclosure（nir1_entity_relation.rs:2505-2506）、qualification 参照（nir1_packing.rs:1088-1097。`scene-source:<id>` に token、`scene-incarnation:<id>` に incarnation を入れる）。

### incarnation のほかに3要素が要る理由

- token：同じ incarnation の中での編集（version や updated_at の変化）を検出する。
- body digest：patch は token を変えずに本文を変えられる。`bump_version` は任意で、updated_at は呼出し側の値になる（db:domain_writes.rs:3618-3623）。
- live かつ未 archive：archive は、incarnation、token、本文のどれも変えずに行える（§1(a)）。
- 「live」の範囲は D-final（nir1_packing.rs:540）と Graph（nir1_graph/scenes.rs:153-173、360-367、401-405）に合わせ、Scene 自身の `archived_at` だけを見る。祖先の folder が archive されているか（domain_writes.rs:2672-2702 の `ancestor_live`）は見ない（§12 の未決事項 2）。

### 読取の上限と検証の場所

- 本文は2段階で読む。先に `octet_length(content)` などのスカラーだけを読み、本文が `MAX_PACKING_INPUT_BYTES`（2 MiB、core:narrative_nir1.rs:36）を超えていれば本文を読まずに拒否する（`..._SCENE_BODY_LIMIT`）。この値は、D-final が同じ Scene を読むときの上限と同じ（nir1_packing.rs:514-521）。`updated_at` と incarnation の長さは `MAX_ID_BYTES` で抑える。新しい数値は作らない。
- 検証は create（883 の位置）と claim（1862、1920 の位置）で、それぞれの IMMEDIATE transaction の中で行う。claim は同じ transaction のまま CAS を commit する（1823-1835）ので、検証してから commit するまでの間に Scene が変わることはない。
- 読取関数 `read_attempt_scene_binding_in_tx(conn, project_id, scene_id) -> AttemptSceneBinding` を crate の公開関数として足す（N-API ではない）。検証は「現在値を読んで束縛値と比べる」ことなので、同じ関数を使う。試験のほか、将来の coordinator（DI-1c）が D-final と同じ read transaction の中で束縛値を作るのにも使う。Raw だけの request には Revision の Scope binding がなく incarnation を得られないので、この経路が必要になる。

## 5. 保存する識別子と receipt の tuple の対応

tuple の出典は2つある。receipt の handle（docs/plans/nir1-l6-l9-execution-plan.md:218 の「`projectId`／profile／caller epoch、request／revision／material／Scope／D1 generation binding、opaque handle、creation／expiry」）と、handle で確かめる項目（docs/plans/nir1-post-b-execution-plan.md:255 の「profile/caller epoch、workspace 実体 binding、project/session、message version、purpose/Scope、material/D1 binding、route 設定版、provider/model/API/endpoint、payload、期限」）。

| v2 の値 | 保存先 | v1 との関係 | tuple の項目 |
|---|---|---|---|
| projectId | binding_json、列 project_id | 同じ | projectId（l6-l9:218） |
| chatSessionId | binding_json、列 session_id | v1 の sessionId を DB が chat session として検証していた意味を引き継ぐ | project/session（post-b:255） |
| caller.profileId | binding_json | 同じ | profile（l6-l9:218） |
| caller.callerId | binding_json | 同じ | main の実 IPC sender 由来の caller（post-b:255） |
| caller.callerEpoch | binding_json | 同じ | caller epoch（l6-l9:218） |
| caller.callerSessionId | binding_json | v1 で Native が sessionId に入れていた値（node:nir1_generation.rs:1106）。新しい値ではない | project/session の session（Main が発行） |
| workspaceBindingDigest | binding_json | 同じ | workspace 実体 binding（post-b:255） |
| scene.sceneId | binding_json | binding には新しく入る。同じ値は入力参照 `project:scene:<id>` と qualification 参照 `scene:<id>` に既に保存されている | Scope binding（l6-l9:218。history の Scene 軸：l6-l9:229） |
| scene.sceneIncarnationId | binding_json | binding には新しく入る。同じ値は qualification 参照 `scene-incarnation:<id>`（nir1_packing.rs:1095-1096）に既に保存されている | Scope binding |
| scene.sourceToken | binding_json | binding には新しく入る。同じ値は RawSource 参照と `scene-source:<id>`（nir1_packing.rs:1090-1091）に既に保存されている | revision binding |
| scene.bodyDigest | binding_json | binding には新しく入る。本文ではなく digest で、D-final の `storage_digest` と同じ値 | material binding（request／revision／material digest） |
| purpose、scopeDigest、materialDigest、d1Digest | binding_json | 同じ | purpose/Scope、material/D1（post-b:255） |
| routeRevision | binding_json | 同じ | route 設定版 |
| provider、model、api、endpointIdentity | binding_json | 同じ（endpoint は credential を含まない digest） | provider/model/API/endpoint |
| historyTurnContext、durableWorkspaceIdentity | binding_json（常に null） | 新しい予約 slot。値は保存しない | 予約（D2b-2 の history。別の workspace copy への旧 handle の流用の防止：post-b:93） |
| bindingVersion | binding_json | 新しい形式の情報（識別子ではない） | — |
| payload_digest、input_digest、参照行、created_at_ms／expires_at_ms、id | 既存の列と表 | 変更なし | request digest、参照、creation／expiry、opaque handle |

判定：tuple を超える識別子はない。本文、thinking、credential、raw URL は保存しない。したがって `[precheck]` には当たらない。ただし、この判定は §12 の 1 で integrator に確認を求める。

## 6. legacy（v1）の扱い

- 既存の v1 の行は書き換えない（migration はなく、schema 番号も変えない）。
- dispatcher が legacy と判定した行は、recover と、成功以外の finish による終端だけを許す（§3）。read_attempt、claim、成功の finish、新しい attempt の親としての利用、history での読取は拒否する。
- 利用者の DB には attempt の行がない。製品の入口がないからである（node:nir1_generation.rs:1-5、34-35）。legacy の行は試験用と開発用の DB にしかないので、拒否しても利用者には影響しない。
- legacy の parse でも `deny_unknown_fields` を維持する。

## 7. downgrade 時の挙動

- DT-3 より前の reader は、v1 の struct を `deny_unknown_fields` で parse する。v2 の JSON には v1 が知らないキー（`bindingVersion`、`chatSessionId`、`caller`、`scene`、予約 slot）があり、v1 に必須の `sessionId` などがないので、parse は必ず失敗する。
- そのため、古い binary は v2 の attempt を read、claim、finish、recover のどれもできない。claim と dispatch は起きない（fail-closed）。
- 古い binary の recovery sweep は v2 の行で失敗する。DT-1 の barrier では、sweep が失敗すると gate は Closed のまま（Incomplete）で、generation は開かない。workspace 自体は開く。新しい版に戻せば recover できる。
- 予約 slot に値が入った将来の行を DT-3 の reader が読むと、無人型の parse で失敗する（fail-closed）。`bindingVersion` が 3 以上の行も `NIR1_GENERATION_BINDING_VERSION_UNSUPPORTED` で拒否する。
- 試験で確かめること：v2 の canonical JSON を、v1 だけを知る struct（現行の v1 型と同じ定義）で parse すると失敗する。現行の dispatcher は、未知の版、予約 slot の値、未知のキーを拒否する。

## 8. 信頼境界

| 区分 | 値 | 誰がいつ確かめるか |
|---|---|---|
| DB で検証する | projectId、chatSessionId、scene（incarnation、token、body digest、live かつ未 archive）、session がその Scene に付いていること、入力参照と qualification 参照、期限 | grimodex-db が create と claim の IMMEDIATE transaction の中で確かめる（§4）。claim の検証と CAS の commit は同じ transaction の中で行う |
| process-local | caller（profileId、callerId、callerEpoch、callerSessionId）、workspaceBindingDigest、routeRevision | Native の owner が claim の前に、生きている CallerIdentity、LiveBinding、route と比べる（node:nir1_generation.rs:1213-1223）。caller の正本は profile egress の process 内の登録で、永続化されず、restart で無効になる（node:profile_egress.rs:251-269、702-724）。DB にできるのは、保存された値と claim のときに渡された値の一致の確認だけ（db:nir1_generation.rs:1858-1861、1912-1915） |
| coordinator の証明入力 | purpose、scope／material／d1 の digest、provider、model、api、endpointIdentity | DT-3 では検証しない（v1 と同じ。node:nir1_generation.rs:57-64）。typed reader の接続は DI-1 以降で行う |
| 予約 | historyTurnContext、durableWorkspaceIdentity | 常に null。値があれば parse で拒否する |
| 信頼しない | renderer と IPC の値 | FinalDispatchRequest は wire 型ではない。N-API も追加しない（A-1） |

- DB の claim は CAS であり、送信の認可ではない（db:nir1_generation.rs:3-6、1793-1794）。認可は Native の owner が profile と core の guard の中で行う（node:nir1_generation.rs:1231-1250）。この関係は変えない。
- finish と recover は観測の記録なので、Scene の現在性は確かめない（同一性の整合だけを確かめる）。成功した結果を history に使えるかどうかは、後段の history の再認可が決める。

## 9. 代替案（採らなかったもの）

### v2 の形

1. `session_id` を1つ残して chat session として扱い、caller session は保存しない。process-local な caller の束縛が弱くなり、task の指定（caller binding に Main の caller session を含める）にも合わない。
2. caller session を新しい列に、Scene の束縛を別の表に置く。schema の変更が必要になる。
3. Scene を qualification 参照だけで表し、claim で参照を検証する。参照は型のない文字列の組で、どれが query Scene かを型で表せない。参照全体の現在性の検証は DI-1 の範囲。
4. `StoredAttempt.binding` を legacy と v2 の enum にする。history と Native のすべての利用者が legacy を扱うことになる。legacy は終端にしか使わないので、dispatcher の内側に閉じ込める。
5. 版の表し方として、外側に `{"v2": {...}}` とタグを付ける案と、`#[serde(untagged)]` の案。前者は入れ子が増えるだけで利点がない。後者は試す順番で結果が変わり、誤った版のまま通る余地がある。明示の `bindingVersion` で分岐する（既存の DTO の `schemaVersion` と同じやり方）。
6. 予約 slot を `Option<serde_json::Value>` にする。任意の値を書けてしまう。無人型なら null 以外を型で拒否できる。

### Scene の incarnation（tree_nodes の列だけで作る案）

1. `(id, created_at, version, updated_at, archived_at, 本文の digest)`。§1(a) のとおり、どの要素も別の incarnation で同じ値になりうる。snapshot 復元は id、created_at、updated_at、本文をそのまま戻し、version を 0 に戻す（project_snapshots.rs:1213-1257）。編集していない Scene を復元すると、全要素が元と一致する。秒精度の `datetime('now')` を使う trash 復元では、同じ秒の中の再作成を区別できない。
2. SQLite の rowid。tree_nodes は TEXT の主キーなので、rowid は暗黙の列になる。最大の行を消すと同じ rowid が再利用され、バックアップの `VACUUM INTO`（backup_restore.rs:474）で番号が変わることもある。Graph も rowid は要求ごとの cursor にしか使わない（nir1_graph/scenes.rs:79-80）。
3. 変更履歴（change_events）から作る。すべての writer が記録する保証がなく、読取の大きさも抑えられない。
4. tree_nodes に incarnation の列を足す。schema の変更になり、A1 の列とも重複する。

### body digest

- 正規化した本文の digest（`canonical_text_digest`）。TipTap の正規化が必要で、見た目だけの変更を同一とみなしてしまう。束縛は保存されたバイト列の完全一致にする。D-final の `storage_digest` と同じ値なので、coordinator はそのまま渡せる。

### その他

- chat session と Scene の対応を見ない。別の Scene に移した session や、Scene の削除で切れた session でも claim できてしまう。
- `chat_session_id == caller_session_id` を許す。v1 のような取り違えを検出できない。
- legacy の成功した attempt を新しい attempt の親として許す。Scene の束縛を持たない系譜から送信が生まれてしまう。

## 10. S4 の試験（red）

現行の API で書き、実行時に失敗させる。green にするときは試験の本体を変えず、helper（binding の組立て）だけを v2 に合わせる。

- DB（db:nir1_generation/tests.rs）
  - `s4_old_attempt_cannot_claim_after_scene_delete_recreate_restore_or_id_reuse`：Scene（v0@T、本文 B、A1 binding、session を付ける）に束縛した attempt を作る。次の3通りの操作をしたあと、token が元と同じであることを確かめ、古い attempt の claim が拒否されることを要求する。
    1. 削除して、同じ行で再作成する。
    2. 編集したあと、snapshot 復元と同じ手順で元に戻す。
    3. 同じ id と token で、本文の違う Scene を作る。

    v1 では Scene を RawSource 参照でしか表せず、claim が通ってしまうので red になる。
  - `s4_old_attempt_cannot_claim_archived_scene`：version と updated_at を変えずに `archived_at` を入れたあと、claim が拒否されることを要求する。v1 では通ってしまうので red になる。
  - `s4_main_issued_caller_session_is_not_the_db_chat_session`：Native と同じく、binding の session に Main の caller session（UUID）を入れて create する。v2 では caller session と chat session が分かれるので create が通り、列 session_id が chat session になることを要求する。v1 では `NIR1_GENERATION_SESSION_MISMATCH` で create が失敗するので red になる。
- Native（node:nir1_generation.rs の tests）
  - `s4_production_caller_session_binds_chat_session_separately`：caller session を Main と同じ形の UUID にした owner で persist_final_request を呼ぶ。v2 ではこれが通り、列 session_id が `"session-1"` になり、同じ owner の claim が通ることを要求する。v1 では create が失敗するので red になる。

## 11. 変更箇所（実装の予定）と DT-2 との衝突面

- db:nir1_generation.rs
  - 型：122-143 を置き換え、新しい型を足す。
  - 検証：validate_binding（671-694）。require_session（706-716）を chat session と Scene の検証に置き換える。validate_refs の session の比較（743-748）。
  - create（883、892-896）と claim（1862、1920 の検証の呼出し）。
  - dispatcher（1209-1217、2965-2970、3134-3140）と、finish での legacy の成功の拒否。
  - 書込み経路の構造（接続の取得、transaction の張り方、上限）は変えない。
- db:nir1_generation_history.rs：`binding.session_id` を `binding.chat_session_id` にする（1022、1152）。試験の fixture（1522-1569）を v2 に合わせる。
- node:nir1_generation.rs
  - FinalDispatchRequest（65-83）に `chat_session_id` と `scene` を足す。
  - binding の組立て（1104-1120）と owner の比較（1214-1223）。
  - 試験の fixture（1536-1625、2284-2394）。
  - nir1_prepared_request.rs は binding を組み立てないので、変更しない見込み。
- DT-2 は create、claim、finish、recover と、persist_final_request、consume_claim を書き換える。rebase では、「検証の呼出し1行」と「binding の組立て」を DT-2 の新しい関数に移す。

## 12. 未決事項（integrator に確認したいこと）

1. §5 の判定（tuple を超えない）。特に、caller session を binding に残すことと、Scene の body digest を binding に入れること。
2. 「live」に祖先の folder の archive を含めるか。D-final と Graph は Scene 自身の archived_at しか見ないので、DT-3 もそれに合わせた。含めるなら D-final と同時に変える必要がある。
3. chat session がその Scene に付いていること（node_id = scene_id）を create と claim の条件にしたこと。
4. 未知の版（v3 以降）の行を recover でも拒否すること。task の「未知の版は拒否する」に従った。その結果、downgrade した古い binary では generation の gate が閉じたままになる。

## 13. 受入れとの対応（実装の段階で green にする試験）

| 受入れ | 試験（予定） |
|---|---|
| S4 の2試験が red から green になる | §10 の4試験。本体は変えず、helper だけを v2 の組立てにする |
| dispatcher が legacy と v2 を読み分け、未知の版を拒否する | v1 の canonical JSON の行：read_attempt と claim は `..._LEGACY_TERMINAL_ONLY`、recover は終端になる、成功以外の finish は通る、成功の finish は拒否。v2 の行：通常どおり。`bindingVersion` が `1`、`3`、`"2"` の行、v1 と v2 それぞれに未知のキーを足した行、予約 slot に値がある行はすべて拒否 |
| session の混同を拒否する | `chat_session_id == caller.caller_session_id` は `..._SESSION_CONFUSION`。`chat_session_id` に Main の caller session を入れると `..._SESSION_MISMATCH`。Scene に付いていない session は `..._SESSION_SCENE_MISMATCH`。Native では、Main の caller session だけが違う別の owner は claim できない（`..._OWNER_BINDING_MISMATCH`） |
| ABA（削除して再作成、restore、id の再利用）と archived を拒否する | §10 の試験に加えて、token を変えない本文の変更（`..._SCENE_BODY_MISMATCH`）、同じ incarnation の中の編集（`..._SCENE_SOURCE_STALE`）、A1 の行がない Scene（`..._SCENE_UNAVAILABLE`）、2 MiB を超える本文を読む前に拒否すること（`..._SCENE_BODY_LIMIT`） |
| 64 KiB を超える binding を拒否する | 既存の `imported_oversized_binding_is_rejected_before_json_materialization` を維持し、v2 の形でも同じく parse 前に拒否されることを確かめる |
| downgrade が fail-closed になる | v2 の canonical JSON を、v1 だけを知る struct（`deny_unknown_fields` の 15 フィールド）で parse すると失敗する |
| 全件の試験と clippy | `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib nir1_generation`、`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib`、両 crate の `cargo clippy --all-targets -- -D warnings` |
| A-1 | `#[napi]` と IPC の差分がないこと（`git diff` で `#[napi]`、`electron/shared`、`electron/main`、preload に変更がないことを確かめる） |

## 14. S4 の red の記録（実装の前）

- 候補：HEAD `3688a063`（未 commit の差分は試験だけ。`git diff | sha256sum` = `9939d8217d443210f033d7bc422ab65dc09b7f4f8969267fd0c9e8d8e1221eaa`。変更ファイルは db:nir1_generation/tests.rs（追加のみ）と node:nir1_generation.rs（試験の fixture に caller session の引数を足し、S4 の試験を1つ追加））。環境：Linux、cargo／rustc 1.96.1、`CARGO_BUILD_JOBS=4`。
- DB：`cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib nir1_generation` は 59 passed、3 failed（失敗は S4 の3つだけ）。
  - `s4_old_attempt_cannot_claim_after_scene_delete_recreate_restore_or_id_reuse`：3通りすべてで token は元と同じ、incarnation は新しい値になり、古い attempt の claim が通った（`won=true`）。
  - `s4_old_attempt_cannot_claim_archived_scene`：archived の Scene に対して claim が通った（`won=true`）。
  - `s4_main_issued_caller_session_is_not_the_db_chat_session`：create が `NIR1_GENERATION_SESSION_MISMATCH` で失敗した。
- Native：`cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib nir1_generation` は 42 passed、1 failed（失敗は S4 の1つだけ）。
  - `s4_production_caller_session_binds_chat_session_separately`：fixture の persist_final_request が `NIR1_GENERATION_SESSION_MISMATCH` で失敗した（`durable attempt before claim`）。
- log：`/tmp/claude-1000/-home-grimodex-Grimodex/3754f9a7-620d-4e21-ad37-3096691a96be/scratchpad/dt3/` の `s4-db-red.log`、`s4-native-red.log`、`db-nir1-generation-suite.log`、`native-nir1-generation-suite.log`。
- この記録の時点では、実装（green にする変更）はまだしていなかった。実装と green の記録は §15。

## 15. 実装と green の記録

- 候補：HEAD `3688a063` と未 commit の差分（`git diff | sha256sum` = `946e420834ca23bf22851a649df6ee564eebe306587579303f1aa3748be53e44`）。変更ファイルは db:nir1_generation.rs、db:nir1_generation/tests.rs、db:nir1_generation_history.rs、node:nir1_generation.rs の4つ（`4 files changed, 1544 insertions(+), 86 deletions(-)`）。node:nir1_prepared_request.rs は binding を組み立てないので変更していない。環境：Linux、cargo／rustc 1.96.1、`CARGO_BUILD_JOBS=4`。
- 実装は前回の担当が途中まで進め、中断の時点で db の1試験が失敗していた（`db-nir1-generation-green-1.log`）。原因は試験の書き方で、`json!(2.0)` を canonical JSON に通すと `2` になり、v2 として正しく読めてしまっていた。試験だけを、保存された JSON の文字列を直接書き換える形（`2.0`、`2e0` など）に直した。実装は変えていない。
- 再開後の変更：node:nir1_generation.rs で、DT-3 の hunk のうち rustfmt に合っていなかった1か所（試験の `other_owner` の行）と、100 桁を超えた doc comment を直した。このファイルは HEAD の時点で rustfmt に合っていない（rustfmt を通すと 384 行の差分が出る）ので、ファイル全体の整形はしていない。db の3ファイルは HEAD でも現在も rustfmt に合っている。

### S4：red から green へ（試験の本体は変えず、helper だけを v2 に合わせた）

| 試験 | red（§14） | green |
|---|---|---|
| db `s4_old_attempt_cannot_claim_after_scene_delete_recreate_restore_or_id_reuse` | 3通りすべてで claim が通った（`won=true`） | 3通りすべて `NIR1_GENERATION_SCENE_INCARNATION_MISMATCH` |
| db `s4_old_attempt_cannot_claim_archived_scene` | claim が通った（`won=true`） | `NIR1_GENERATION_SCENE_ARCHIVED` |
| db `s4_main_issued_caller_session_is_not_the_db_chat_session` | create が `NIR1_GENERATION_SESSION_MISMATCH` | create が通り、列 session_id が `generation-session`、claim が通る |
| Native `s4_production_caller_session_binds_chat_session_separately` | persist_final_request が `NIR1_GENERATION_SESSION_MISMATCH` | 通る。列 session_id が `session-1`、同じ owner の claim が通る |

### 受入れの検証（すべて上記の候補で実行）

| command | 結果 |
|---|---|
| `cargo test --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --lib nir1_generation` | 72 passed、0 failed（S4 の3試験と DT-3 の10試験を含む） |
| `cargo test --manifest-path electron/native/grimodex-node/Cargo.toml --lib` | 287 passed、0 failed（S4 の1試験、`dt3_other_main_caller_session_cannot_claim`、PR #630 の対象の試験を含む） |
| `cargo clippy --manifest-path src-tauri/crates/grimodex-db/Cargo.toml --all-targets -- -D warnings` | 警告なし |
| `cargo clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets -- -D warnings` | 警告なし |
| `node scripts/quality/validate-native-writer-ownership.mjs` | ok（active=78、scanned=264） |
| `node scripts/quality/validate-change-feed-writers.mjs` | ok |
| A-1：`git diff` の `#[napi]`、electron/shared、electron/main、preload、migrate.rs、policies、docs、evals、lock 類、package.json | どれも差分なし |

- log：`/tmp/claude-1000/-home-grimodex-Grimodex/3754f9a7-620d-4e21-ad37-3096691a96be/scratchpad/dt3/` の `db-nir1-generation-green-2.log`、`native-lib-green-2.log`、`db-clippy.log`、`native-clippy.log`、`native-ownership.log`、`change-feed-writers.log`。
- 実行していないもの：grimodex-db の全件（`--lib` の filter なし）、`pnpm` の品質 gate（Quick／Full）。差分は nir1_generation の3ファイルと Native の1ファイルだけで、`AttemptBinding` の利用者はこの4ファイルに限られる（grep で確かめた）。TypeScript を使う validator（validate-narrative-writers など）は `.rs` を走査しないので実行していない。

### 設計（§2〜§4）への補足と、設計に書かなかった細部

1. エラーコードの追加：`NIR1_GENERATION_BINDING_INVALID`（probe または版ごとの struct の parse の失敗）、`NIR1_GENERATION_BINDING_RESERVED_SLOT_SET`（予約 slot に値がある）、`NIR1_GENERATION_SCENE_METADATA_LIMIT`（`updated_at` か incarnation が `MAX_ID_BYTES` を超える）、`NIR1_GENERATION_SCENE_CHANGED`（スカラーで確かめた長さと読んだ値の長さが違う。同じ transaction の中では起きないはずの防御）。読取関数は transaction の外では既存の `NIR1_GENERATION_TRANSACTION_REQUIRED` を返す。
2. `require_bound_session_and_scene` の検査順：chat session の行（`SESSION_MISMATCH`）→ Scene の読取（`SCENE_UNAVAILABLE`、`SCENE_ARCHIVED`、上限）→ incarnation → source token → body digest → session がその Scene に付いていること（`SESSION_SCENE_MISMATCH`）。
3. §2 の「64 KiB に収まる」は、エスケープのない識別子に限った見積り（12 × 4 KiB と digest 6 個で約 49 KiB）。JSON のエスケープで 64 KiB を超えることはあり、create が INSERT の前に `NIR1_GENERATION_BINDING_LIMIT` で拒否する（`dt3_v2_binding_over_64_kib_is_rejected_at_create_and_before_parse`）。上限の値と検査の位置は変えていない。
4. legacy の行に対する `Succeeded` の finish は、同じ終端をもう一度送る再試行でも `NIR1_GENERATION_BINDING_LEGACY_TERMINAL_ONLY` で拒否する（既存の終端を返す処理より前に版を確かめるため）。§3 の「legacy の Succeeded は拒否する」のとおり。既に書かれた終端は `read_terminal` で読める。
5. history が legacy の attempt に行き当たると、その候補を除くのではなく snapshot の読取全体が失敗する（エラーをそのまま返す）。fail-closed で、§3 の「history での利用はすべて拒否される」に合う。legacy の行は製品の入口がないので試験用と開発用の DB にしかない（§6）。
6. Native の試験の fixture：`Fixture::new()` は、Main と同じく毎回ランダムな UUID を caller session にする。Scene は Native の tree writer（`tree_node_create`）で作り、A1 の incarnation もその writer が作る。`final_request` は Scene の束縛値を `read_attempt_scene_binding_in_tx` で読み取りの transaction の中から得る。
