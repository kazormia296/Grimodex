# 判断の記録：AWA/1（アプリ内の AI と MCP が、作者の年表の出来事を更新・削除するときの承認）

確認済みの行は、台帳 `docs/plans/nir1-l6-l9-execution-plan.md` の `nir1-agent-event-write-approval-proposal/1#agent-event-write-approval`（確認 141）と `nir1-agent-event-write-approval-proposal/1#mcp-author-event-write`（確認 142。どちらも 2026-11-23、blockedReason none）。着手の時期は、2026-11-27 にユーザーが「今から並行で」と決めた（推奨は「RA7・RD6 の後」で、推奨と違う選択）。PR の分け方の下書きは `fusion-eval-data/handoff/awa1-pr-plan-20261127.md`（設計 §5 の順の 8 本）。

## この PR（§5 の 1、文書だけ）の範囲

設計 §2.7 が名指す契約の文の改め：ADR 004・005・006・007・008、`policies/narrative/mutation-authority-routes.json` とその schema、`scripts/quality/validate-semantic-core-boundary.mjs` の `EXPECTED_CONDITIONAL_CONTROLS` とその試験、AI エージェントの設計書、MCP サーバーの設計書、roadmap の Current snapshot、Mastra の移行計画の MP-6 の条件（台帳 505 行の範囲が名指す「Mastra の計画の MP-6 の条件への試験の追加」）。GDX-TOOL-001（`policies/quality/iron-laws.md`）と `agent-tool-manifest.json` は触らない（確認 86。manifest は PR 4）。設計の脅威モデルと Mastra の脅威モデル（D13・T11・W 表）は変えない。

## DR-AWA-1　MCP の免除を、どの control で受けるか（§2.7 の (i)／(ii)）

設計 §2.7 は、ADR 006 :84 の「Interactive Agent Command は Field Authority admission を常に要する」と、routes JSON の `requiredControls` の `field-authority` のままでは、MCP の免除（作者の持ち主の拒みを外す）を扱えないとし、(i) MCP を `interactive-agent-command` の例外にする、(ii) 承認つきと MCP の免除の両方を受ける別の条件つき control を置く、のどちらかを技術判断で選ぶとした。

**(ii) を選ぶ。** `field-authority` は全部の呼び出しで必須のまま残し、作者の欄に触れる出来事の更新・削除（削除に伴って因果で結ばれた出来事の作者の欄に触れる場合を含む）に、条件つきの `author-field-override` を足す。アプリ内では main が 1 回ずつ承認した `ApprovalRequest` を一回限りの capability に替え、MCP では書き込みの許された 1 つの作品に固定した接続で、起動時にサーバーが作る `McpNoApproval { project_id }` を同じ control の別の根拠にする。Native は作品の一致を確かめ、作者の持ち主の拒みだけを外す。ロック・ほかの書き手・全作品の接続は外さない。payload の `surface` から免除は得られない。

理由：(i) は MCP を route の例外にするので、`field-authority` の検査そのものが MCP に掛からない形になり、免除の範囲（作者の持ち主の拒みだけ）より広く外れる。(ii) は必須の control を全部の呼び出しに残したまま、外せる拒みを 1 種類に絞れる。名前は、validator が「required と conditional に同じ control を置けない」と拒むので、`field-authority` と別にする（§2.7）。

## DR-AWA-2　承認待ちの記録（2026-11-27 の問 22〜23 による改訂）

ユーザーが、Gate A で承認が要る書き換え系の tool の承認待ちを DB に記録し、AWA/1 の作者の出来事の更新・削除の承認にも同じ記録を及ぼすと決めた（問 22「記録する」・問 23「及ぼす」。記録は contracts `2bb2083ee` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-26-integrator-s11-leftovers.md`。A3 の担当〔grimodex-59〕のセッションの問いで、統合者が写した）。設計 AWA/1 の「承認の要求は main のメモリだけ、却下・時間切れは DB の行を足さない」と、ADR 007・008 の 11-23 の追補の同じ読みは、この範囲で改める。この PR では、ADR 007・008 の該当の項目の直後に 11-27 の改訂を足した（11-23 の文は残す）。設計の下書きの本文は、確認の SHA に結ばれているので書き換えず、この記録と ADR の改訂を正とする。

- 記録の実体は A3 の `agent_run_interactions`（`kind=approval`、Run は `waiting_approval`）。再起動の後も、承認待ちのカードを起点の会話に出し直して続けられる。
- 保存した承認はそのまま認可に使わない。一回限りの capability に交換する時点で、main が確かめ直す。
- 記録の中身は対象の要約と作者の判断。Run の終端で、承認・却下・期限切れの記録の中身（要求と判断）を消す。行そのものは、Run の行と一緒に、会話・作品の削除まで残る（A3 の DR-A3-14 と同じ言い方）。
- 承認待ちの期限（A16 の 5 分。既存の `AGENT_AUTHORITY_CAPABILITY_TTL_MS` を共有）が切れたときは、A3 と同じく、記録を承認待ちのまま残し、Run を中断（`approval_timeout`）にして、後から「続ける」で承認できる形にする（問 23「両方を同じ記録に揃える」「年表の承認待ちも再起動の後に続けられる」の読み。起案者の読み）。**変えないもの**：承認してから使えなくなるまでの 60 秒（A7）、1 回の応答で 5 件・1 つの窓で同時に 16 件（A14）。どちらも確認 133 (3) でユーザーが選んだ値で、この改訂では動かさない。
- 帰結：AWA/1 の main の PR（PR 4）と画面の PR（PR 5）は、A3 の記録（`agent_run_interactions`）が master に入ることに依存する。A3 の担当は、AWA/1 の実装に触る前にこちらへ連絡すると言っている。

## 信頼境界

この PR は文書と方針の JSON だけで、製品の挙動を変えない。承認の仕組みの実装（Native の probe、main の承認の状態、renderer のカード）は PR 2〜6、AI の削除を開ける旗（O1）は PR 7（SRD/1 の X の後）。
