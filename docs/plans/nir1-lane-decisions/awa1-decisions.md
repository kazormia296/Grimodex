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

## DR-AWA-3　起案の後に確定した A2・A3 との関係（2026-11-29）

AWA/1 の起案（確認 141・142）の後に、次が確定した。起案の本文は書き換えない。問 29・36・43 の記録は contracts の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-26-integrator-s11-leftovers.md`。

- A2 の判断記録 [gate-a2-approval-decisions.md](../gate-a2-approval-decisions.md)（利用者の回答、contracts の問 36）。
- 提案した時点の対象の版を承認の要求と一緒に保存する（利用者の回答、問 29。「対象の種類・ID・版（版が無ければ内容の照合値）だけ」「本文は保存しません」「出し直すときに提案の後の変更があれば、承認画面を出さず AI に知らせて提案し直させます」）。
- 出来事の削除の承認では、参加者・場面との結び付き・関係の変化も照らす（利用者の回答、問 43。A2 の delete_event）。

### 記録の形（技術判断）

- A3 の記録の `target_basis` には、対象の出来事を `sourceKind=event`（A2 の DR-A2-11 の語）、`sourceId`＝出来事の id、`version`＝出来事の版で載せる。本文は載せない。port の型は 1 件につき版か内容の照合値のどちらか一方なので（`electron/shared/agentRunTypes.ts` の `AnalysisReadBasisEntryV1`）、A4 の指紋は `target_basis` の版と別の束縛として扱う。
- A7 の「承認してから 60 秒」は、A2 の DR-A2-9 と同じ。
- A2 の交換の service（#1232、`electron/main/agentApprovalExchange.ts`）と A3 の port が master にある。AWA/1 の main の PR は、二つ目の承認の仕組みを作らず、これに合わせる。

### 経路の限定

「再起動の後も承認待ちのカードを出し直して続けられる」（DR-AWA-2）は、経路を限っていなかった。Mastra の経路の Run は当面 `resumable=false` で、再起動の後の出し直しは legacy の経路だけである（A2 の判断記録の第 4 節、問 22・23 への注）。

### 未決（AWA/1 の PR 4 の前に決める）

1. **Stop・切り替えの扱い。** AWA/1（A16）は、Stop を `reject`、作品・workspace の切り替えを `superseded` にする。A2（DR-A2-7）は、Stop で pending を `cancelled` にし、切り替え・quit・時間切れは Run を `interrupted` にして pending を残す。
2. **承認待ちの期限。** AWA/1 は応答から 5 分（A16。DR-AWA-2 は、切れた後も pending を残すと定めた）。A2 は 30 分。
   - 1・2 をどちらに寄せるかは、利用者に伺う（寄せるなら、確認済みの起案の改訂になる）。伺う役は年表（統合の割り当て、2026-11-29）。回答まで、AWA/1 の記録はこのままにする。
3. **版が上がらない変化の扱い。** 出し直しのときの「提案の後の変更」（問 29）を、A4 の指紋が覆う参加者・場面との結び付き・関係についてどう見つけるか。削除で `/relations` が変わる他の出来事を `target_basis` に載せるか。A2・A3 に合わせる PR で決める。
4. 「AWA/1 を A2 の交換と A3 の記録に合わせる PR」は、年表の持ち分（統合の割り当て、2026-11-29）。着手は 1・2 の回答の後。A2 の交換や port の型を変える前に、統合に知らせる。

## 信頼境界

この PR は文書と方針の JSON だけで、製品の挙動を変えない。承認の仕組みの実装（Native の probe、main の承認の状態、renderer のカード）は PR 2〜6、AI の削除を開ける旗（O1）は PR 7（SRD/1 の X の後）。
