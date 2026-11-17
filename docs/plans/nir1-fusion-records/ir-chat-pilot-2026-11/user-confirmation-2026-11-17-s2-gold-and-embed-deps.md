# ユーザーの回答の記録：chat IR の S2 の Gold の確認（Q7）と埋め込みの依存の install（Q10）（2026-11-17）

- 経路：Claude Code の AskUserQuestion（4 問のうち 2 問）。統合者（grimodex-ed）が伺った。資料は `/home/grimodex/fusion-eval-data/pubg-a/pending-questions-2026-11-17.md` の A-2・A-3（点検済み）。
- 位置づけ：chat IR（NIR-1 の残レーンの外）の S2 の前に伺う 3 件のうち 2 件。Q1（回答 model の effort）は費用の見積り直しの後に別に伺う。D4 は S3 の前に D1〜D3・★4 と束ねて伺う。

## Q7：Gold の確認

- 事実：独立の照合（subagent、Opus）は v1 が全 40 問、v2 が 7 問。凍結した v3（`questions.v3.json` SHA-256 `064c9ae4…44fb4`）そのものは未照合。既知の不整合 2 点（p100-M1 の i8 の引用と原稿の食い違い、p050-R2 の v3 の直し方は v2 の勧めと違い未照合）。抽出は未開始。
- 回答：**「範囲を正確に書いて進む (Recommended)」**。限界 L8 に「v1 は全 40 問、v2 は 7 問、v3 は未照合、残りは作成者の確認、ユーザーの抜き取りなし」と既知の不整合 2 点を書いて進む。pilot の「2/30 以上で止める」規則は当てはめない。Gold は直さない。

## Q10：埋め込みの依存の install

- 事実：harness の tool の arm に `onnxruntime-node` と `@huggingface/transformers` が要る。model（ruri-v3-30m）は取得済みで、`allowRemoteModels=false`・`local_files_only` なので model の取得は起きない。原稿・質問・鍵は送らない。install script が registry 以外へ接続するかは未確認。
- 回答：**「版を固定し、script を読んでから (Recommended)」**。npm の registry に接続し、repo の外の固定の場所（/tmp 以外）に install してよい。`--ignore-scripts` で入れ、package の scripts の接続先を読んでから走らせる。接続先は registry と名指しした host だけ。版と integrity を記録する。統合者が直接実行する。GDX-PRECHECK-001 の external-egress の行として記録する。
