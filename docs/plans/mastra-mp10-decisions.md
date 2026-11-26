# Mastra 移行 MP-10 判断記録（草稿）

- 状態：草稿。コード・確定脅威モデルは未変更。旗 M は閉じたまま。
- 前提：[移行計画 MP-10](mastra-migration-plan.md#mp-10-背景-llmembeddingom-の構成)、[脅威モデル](mastra-migration-threat-model.md)。指定の `.codex-jobs/mp10-survey.out.md` は checkout 内に見つからず、以下は計画・脅威モデルと現行ファイルで確認した範囲。

## 1. 範囲

背景 LLM の4 route（`memory_observer`、`memory_reflector`、`memory_title`、`memory_embedding`）を登録し、main の audit begin と Native の拒否条件を結ぶ。ローカル ONNX embedding の N-API を追加し、OM・memory の構成値を明示する。新しい送信先は作らず、LLM 宛先は利用者が選んだ provider のみ。旗 M は閉じ、製品経路から実行しない（計画 §10、§13）。

## 2. 確かめた事実

- MP-10 は4 route、object 型の model／embedder、明示構成、attachment 除外、受入れ確認を要求する（`docs/plans/mastra-migration-plan.md:501-524`）。
- registry の main callsite は現在 `chat_agent_main` だけ（`src/features/ai-verification/aiPathRegistry.ts:178-186`）。agent audit は begin → dispatched → terminal の順に main が書く（`electron/main/mastra/agentAuditSink.ts:15-20`）。
- N-API の既存 semantic command は保存済み message の索引等で、任意 text の embedding command は宣言されていない（`electron/native/grimodex-node/index.d.ts:840-848`）。共有 `Embedder::embed_document` はローカル ONNX の文書 embedding を行う（`src-tauri/crates/grimodex-semantic/src/embedding.rs:86-100,158-162`）。
- 送信先は利用者の provider を Rust adapter 経由に限定し、Mastra の既定 provider／router は使わない（`docs/plans/mastra-migration-threat-model.md:35-38`）。
- `bufferTokens:false` 等は計画にあるが、`bufferOnIdle` を止める設定と `agentManaged:false`／PDF の `observeAttachments:false` は未確認（`docs/plans/mastra-migration-plan.md:509-523`、`docs/plans/mastra-migration-threat-model.md:377-389`）。
- tool 本文は同 turn の step 間 observer と題名 prompt に入る場合がある。開示・consent・保持期間・同梱 prompt は未決（`docs/plans/mastra-migration-plan.md:522,659-660`、`docs/plans/mastra-migration-threat-model.md:74-75,100,480`）。
- 実 provider の遅延は未測定。既存の 613 ms は fake の `settled()`（`docs/plans/mastra-migration-plan.md:696-701`）。

## 3. 判断案（DR）

- **DR-MP10-1 route と audit。** 4 route を `aiPathRegistry` と `AI_AUDIT_MAIN_CALLSITES` に登録し、各 provider 呼出し前に対応する route ID の audit begin を必須にする。begin 欠落は Native で拒否。executable contract test を加える（`docs/plans/mastra-migration-plan.md:503-505,517-519`；`docs/plans/mastra-migration-threat-model.md:288`）。
- **DR-MP10-2 model 解決。** `memoryModel` が空なら主 model を使う。Mastra へは model／embedder object のみ渡し、文字列 ID は型・実行時とも拒否（`docs/plans/mastra-migration-plan.md:505`；`docs/plans/mastra-migration-threat-model.md:285`）。
- **DR-MP10-3 embedding。** 新 N-API command は Rust の既存 ONNX `Embedder::embed_document` に接続する。言語別 model／次元を明示し、未取得時は計画済みの縮退、次元不一致は保存失敗とする（`docs/plans/mastra-migration-plan.md:506-508`）。通信先を増やさない。
- **DR-MP10-4 OM／memory 構成。** `bufferTokens:false`、`retrieval:false`、`observeAttachments:false`、`workingMemory.agentManaged:false` を明示。`bufferOnIdle` は実装前に止め方を確認し、既定値には依存しない。recall／OM は thread、WM は resource、template は嗜好・文体だけ（`docs/plans/mastra-migration-plan.md:509-514`；`docs/plans/mastra-migration-threat-model.md:290,377-389`）。
- **DR-MP10-5 lifecycle と閾値。** observer／reflector は turn owner が待つ同期処理、buffering は memory task、embedding は memory task と adapter が所有する。closure で新規開始を止め、audit terminal と inflight／commit を終了根拠とする。`blockAfter`、`T_settle`、`T_embed` は明示値を提案し、値は回答前に確定しない（`docs/plans/mastra-migration-threat-model.md:365-401`）。
- **DR-MP10-6 旗と測定。** 実 provider 測定は M を閉じたまま SessionTasks の試験専用入口から行い、製品の agent loop から呼べない形にする。U-14 の回答後に限り、利用者 key・費用を伴う測定を行う。

## 4. owner／lifecycle（GDX-PRECHECK-001）

| 処理                    | owner／開始                     | 停止・完了の根拠                                                                                                          |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| observer／reflector     | turn loop。閾値到達時に同期開始 | turn abort と連動。audit terminal、flag 解除。待ちは turn 上限（脅威モデル:365-375）                                      |
| idle buffer／reflection | Mastra memory の背景 task       | closure 後は新規開始しない。`settled()` は補助にとどめ、audit terminal・inflight 0・flag 解除を確認（脅威モデル:377-389） |
| embedding／upsert       | memory task と Rust adapter     | embedder の abort 不可。closure で新規開始を拒み、terminal audit と vector commit を照合（脅威モデル:391-401）            |
| provider audit          | Electron main。send 前に begin  | dispatched 後、complete／fail／ambiguous の terminal（`agentAuditSink.ts:15-38`）                                         |

## 5. 影響と PR の分け方

1. registry／4 route と audit begin／Native fail-closed、契約試験。
2. ONNX embedding の N-API 配線、model・次元・未取得時の処理。
3. OM／memory 構成、idle buffer 停止、attachment・tool 本文の挙動試験。
4. SessionTasks の測定入口と測定。U-14 の許可までは provider に接続しない。

各 PR で旗 M は閉じたまま。U-15 の決定前に開示・consent・保持の製品仕様や prompt を確定しない。

## 6. 脅威モデルへの影響

D5 に4 route と route ごとの begin 強制・契約試験を反映する。W5〜W7 に上表の owner／lifecycle と明示した期限を反映する。既存の信頼境界（利用者選択 provider、renderer と第三者コードは不信頼）は維持。ローカル embedding は端末内。新しい authority は持たせない。tool 本文を observer／題名へ含めることは U-15 まで既知の残余リスクとして扱う（脅威モデル:28-38,288,365-401）。

## 7. ユーザーに確認する点

回答（2026-11-26）：U-14＝**合成データで**実 provider に送ってよい（費用の上限は測定の前に伺う）。U-15＝計画の範囲で保存してよい（開示・consent・保持期間は MP-12 で改めて伺う）。U-16（4 route の登録、audit の begin、任意の text の embedding の N-API）は P7・P8 の決定の範囲の実装として進める。U-17（blockAfter など）は技術判断で値を決めて記録する（閾値の緩和に当たるなら止めて伺う）。題名（memory_title）は旗 M の間は止め、今の session_title と二重に送らない（タイトルの生成の置き換えは MP-10 の後の候補）。

- **U-14（provider／費用）**：M を閉じ、SessionTasks の試験専用入口だけから実 provider の遅延を測ってよいか。利用者の key と費用が発生する。試験入力は合成データでよいか、実データを使う必要があるか。測定対象・上限は回答後に固定する（`docs/plans/mastra-migration-plan.md:696-701`）。
- **U-15（開示・データ）**：OM／WM／vector を計画の scope で保存してよいか。保持期間と開示・consent をどうするか。tool 本文を observer と題名へ送る範囲を許容するか、絞る条件を要件にするか。Mastra 同梱 prompt を採るか、独自 prompt にするか（`docs/plans/mastra-migration-plan.md:659-660`）。
- **U-16（新規契約）**：4 route の registry 登録、audit begin 強制と executable contract test、および任意 text 用 N-API command を新設してよいか（`docs/plans/mastra-migration-plan.md:503-507,517-519`）。
- **U-17（閾値）**：`blockAfter`、`T_settle`、`T_embed` の明示値を何にするか。値を決めるまで既定値で進めない（`docs/plans/mastra-migration-threat-model.md:371,385,398`）。

## 8. 採らなかった案

- Mastra の provider／model router：新しい宛先や第三者通信を生みうる（脅威モデル:35-38）。
- embedding の外部 API：ローカル ONNX があり、送信先を増やす必要がない（`docs/plans/mastra-migration-plan.md:506-507`；`src-tauri/crates/grimodex-semantic/src/embedding.rs:86-100`）。
- M を開いて通常経路で先行測定：U-14 の key・費用と、U-15 のデータ許可が未決。
- Mastra の OM 既定値に委ねる：版更新で構成が変わり得る（`docs/plans/mastra-migration-plan.md:513`）。

未確認：指定 survey 出力の内容、`bufferOnIdle` の停止方法、`agentManaged:false`、PDF 添付除外、tool 本文の実際の prompt 経路、実 provider の遅延と費用。
