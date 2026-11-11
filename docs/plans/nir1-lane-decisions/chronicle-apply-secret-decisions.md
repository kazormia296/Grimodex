# 取り込みは年表の出来事を secret で作る — 判断の記録（DR-CAS）

この文書は、取り込みの規則の実装に入る前（mutation の前）に、技術判断と信頼境界を残す。
規則と脅威モデルの確認ではない。確認は下の「出所」のとおりユーザーが行った。

## 出所

| 項目 | 内容 |
| ---- | ---- |
| draftRef#contractId | `nir1-chronicle-apply-keeps-secret-proposal/1#chronicle-apply-secret-projection` |
| 確認された版 | 枝 `claude/unruffled-shamir-d6147f` の commit `501c4682` の `docs/plans/nir1-chronicle-apply-keeps-secret-proposal-1-draft.md`（git blob `714a77ac`、SHA-256 `031dbbc763889876cbae7fbab1b1da1ced4773088b1d3b42cf584d52205ddb5a`） |
| 脅威モデルの版 | 同じ下書きの §5。この実装では変えない |
| ユーザーの確認 | 2026-11-11、構造化質問への回答。★1「改める」（§2 の規則 A1〜A5 と §5 の脅威モデル）、★2「区別しない」（作者が個別に secret を外した版も、年表では secret で入れる）。同日、実装の時期に「今から始める」（取り込みの規則の PR から、Quick と ci.yml が通れば merge まで） |
| 基点 | `master` `adaf28b8` |
| この lane の位置 | NIR-1 の残レーンの委任の外。規則・脅威モデル・着手はユーザーが個別に確認した。下の DR は、確認済みの範囲の中の技術判断である |

## 判断

| ID | 判断 | 理由と信頼境界 |
| -- | ---- | -------------- |
| DR-CAS-1 | 規則 A1 を、画面側の組み立て（`src/features/chronicle/extraction/compiler.ts`）と Native の組み立て直し（`commit.rs` の `compile_current_chronicle_event_operation_payload`）の両方に、同じ PR で置く。どちらも `secret` を常に true にする | 取り込みは、Native が版から操作を組み立て直して digest で照合する（`ensure_proposal_approved_and_bound`）。片方だけ変えると照合で拒まれる（安全側）。reveal と Scene への結び付けは今のまま版から導く（A2） |
| DR-CAS-2 | Native の防御は、取り込みの検証（`validate_commit_plan`）の出来事の作成の腕で、操作の `secret` が true であることを要求する。現行の形式か古い形式か、提案への束縛があるかに関わらず掛ける | 提案への束縛の検査は、操作の `proposal_id` が空だと丸ごと飛ばされる。古い形式の枝は版の値をそのまま操作と比べる。枝ごとに塞ぐと、空の操作と古い形式が残る。この検証は prepare と apply の 2 つの入口の両方が通る。A4 は「同じ規則を当てる」を採る（古い形式の取り込みを拒む案は採らない。既存の経路と試験を壊さずに同じ防御になる）。信頼しないのは画面側が出す操作である |
| DR-CAS-3 | 版の `disclosure.secret` は bool であることを Native で要求する。値は取り込みに使わない | 形の崩れた版を、規則の変更で通るようにしない |
| DR-CAS-4 | 取り込みの Undo と Redo は変えない。Redo は、記録した取り込み直後の値から出来事を作り直す。この規則の前に非 secret で取り込んだ出来事の Redo は、記録どおり非 secret で戻る。既存の出来事は書き換えない（migration なし） | Redo は画面の値を受け取らない。過去の取り込みは、その時の作者の操作の結果である。A1 は新しい取り込みに当てる。A5（年表で秘密を外すのは作者が年表の画面で行う）も変えない |
| DR-CAS-5 | 規則の前に準備（prepare）された取り込みの計画に非 secret の操作が残っていた場合、apply は DR-CAS-2 の検証で拒む。作り直せることを実装で確かめ、結果をこの文書に追記する | 準備済みの計画は保存された状態で、古い画面が作ったものでありうる。fail closed にする |
| DR-CAS-6 | 範囲外：chat の agent の出来事の作成（`create_event`。別の経路で、既定は非 secret）、年表の画面での手動の作成と編集、review 画面の checkbox の文言（直後の別の PR）、「まとめて承認」の操作、場面 1 つの抽出 | 候補を小さく保つ。checkbox の意味を「関連場面に出す」に改めること（★2）は確認済みで、文言の PR をこの PR の直後に出す |
| DR-CAS-7 | 試験は、版の secret と操作の secret を別々に与える。必要な組：版 false・操作 true は通り、年表の出来事は secret／版 false・操作 false は現行の形式でも古い形式でも拒否／版の secret が bool でなければ拒否／Undo の後の Redo でも secret／承認した非 secret の版が、取り込みの後も IR の資格を持つ | 既存の補助関数は操作の secret を版に写すので、値を替えるだけでは切り離した組が試験から消える。「版は非 secret・年表は secret」の組は、製品にも評価にも今まで存在しなかった |

## 影響の表（経路ごと）

| 経路 | 変わるか | 根拠 |
| ---- | -------- | ---- |
| 現行の形式の抽出の取り込み（prepare、apply） | 変わる。年表の出来事は常に secret | DR-CAS-1、2 |
| 古い形式の抽出の取り込み | 変わる。非 secret の操作を拒む | DR-CAS-2 |
| 取り込みの Undo | 変わらない。比べる相手は取り込み直後の値（`undo.rs` の `preflight_undo_entity`） | DR-CAS-4 |
| 取り込みの Redo | 変わらない。記録した値から作り直す | DR-CAS-4 |
| IR の資格と索引 | 変わらない。読むのは版の secret、提案の状態、最新の承認で、年表の出来事と取り込みの記録は読まない（`retrieval_admission/current.rs`、`disclosure.rs`）。取り込みは提案の状態を変えない | DR-CAS-7 の試験で固定する |
| 年表から AI への秘密（chat の tool、年表の snapshot、MCP） | 判定は変わらない。取り込んだ出来事が secret になるので、今の既定の取り込みと同じに隠れる | 下書き §2 |
| Graph の本文の開示の拒否 | 判定は変わらない。作者が個別に secret を外した版から取り込んだ出来事にも、拒否が掛かるようになる（★2 で確認済みの代償） | 下書き §4 |
| chat の agent の出来事の作成、手動の作成 | 変わらない（別の経路） | DR-CAS-6 |
| 評価の harness（CP-4、IR の評価） | 変わらない。取り込みを呼ばない（`scripts/quality/nir1-graph-eval/`） | 2026-11-11 に確認 |

外部への送信、subprocess、背景の処理、非同期の lifecycle は変えない。新しい保存先と IPC は足さない。

## 実装後の追記（2026-11-11）

上の判断と影響の表は、mutation の前の記録としてそのまま残す。実装、独立の受入れレビュー（候補に触らない read-only）、追加の調査で分かったことを、ここに足す。

| ID | 追記 |
| -- | ---- |
| DR-CAS-2 | 理由のうち「提案への束縛の検査は、操作の `proposal_id` が空だと丸ごと飛ばされる」は不正確だった。操作のループの中では飛ぶが、同じ検証の末尾が、`proposal_id` が空の操作を `NEX_COMMIT_APPLICATIONS_MISMATCH` で必ず拒む。新しい検査を出来事の作成の腕の先頭に置く判断は変えない（形式の枝や束縛の有無より前に、操作そのものへ掛かる）。古い形式の枝の実際の挙動は次のとおり。保存済みの版が非 secret なら、操作が非 secret のときは新しい検査（`NEX_CHRONICLE_APPLY_SECRET_REQUIRED`）、操作が secret のときは版との照合（`NEX_PROPOSAL_PAYLOAD_MISMATCH`）で拒まれ、どちらも取り込めない。保存済みの版が secret なら、今までどおり取り込める |
| DR-CAS-3 | 足した bool の検査には処理が届かない。手前の版の検証（`validate_chronicle_scene_event_proposal_payload`）が、bool でない `disclosure.secret` を先に拒む。承認のときにも同じ検証が拒む。足した検査は予備として残す。試験は「既存の検証が、規則の変更の後も bool でない版を通さない」ことの固定である |
| DR-CAS-4 | 脅威モデルの受入れ「取り消しとやり直しの後も secret である」は、この規則の後の取り込みについての文として読む。規則の前に非 secret で取り込んだ出来事を取り消してやり直すと、記録どおり非 secret で戻る |
| DR-CAS-5 | 結果：規則の前に準備した計画（操作が非 secret）を apply すると `NEX_CHRONICLE_APPLY_SECRET_REQUIRED` で拒まれ、年表の出来事は作られない。同じ提案の組を新しい request で準備し直すと、secret で取り込める（試験 `current_chronicle_prepared_before_the_rule_is_refused_and_can_be_prepared_again`）。古い準備済みの行は残る。製品の画面は、取り込みのたびに新しい request で準備から apply までを続けて呼び、古い準備済みの計画を使い回さない（受入れレビューの報告） |
| DR-CAS-7 | 「承認した非 secret の版が、取り込みの後も IR の資格を持つ」は、資格の判定そのもの（`read_revision_retrieval_eligibility`）で固定した（`tests/narrative_nir1_retrieval_admission.rs`）。ただし、本物の取り込みではなく、取り込みが書く行（secret の出来事、場面への結び付け、取り込みの記録）を書いた後に判定する形である。理由は DR-CAS-8。書いた直後も、Freshness の周期を回した後も、資格は変わらなかった |
| DR-CAS-8 | **今の製品では、作者が review で編集した版（secret を外した版を含む）は年表に取り込めない。** 取り込みは、版の Envelope の `revisionBasis.kind` が `interpretation` でなければ `NEX_V2_APPLY_BASIS_UNSUPPORTED` で拒む（`v2_apply_sources.rs` の `ensure_supported_intent`。prepare と apply の両方で、取り込む全件に掛かる。#566 で入った試行の制限）。取り込みは承認済みの全部が対象なので、編集して承認した提案が 1 件でもあると、その組の取り込みは全体が通らない。このため、「版は非 secret・年表の出来事は secret」の組は、今の経路ではまだ生じない。今の経路で取り込めるのは AI が出したままの版で、その secret は常に true である。**この PR は、今の製品の挙動を変えない。** 入るのは、画面側が非 secret の操作を出しても Native が拒む防御と、編集した版の取り込みを許すときの前提である。現状の制限は試験で固定した（`tests/narrative_nir1_retrieval_admission.rs`）。ユーザーは 2026-11-11 に、編集した版を「取り込めるようにする」と答えた（別の設計案と脅威モデルを書き、文面の確認の後に実装する） |

**確認された下書きの記述の誤り。** `nir1-chronicle-apply-keeps-secret-proposal-1-draft.md` の §4 の「今は、review 画面の checkbox で secret を外して取り込むと、年表でも秘密でなくなる」と、★2 の質問の同じ説明は、事実と違った。今は、外した版は取り込めない（DR-CAS-8）。★2 の回答（区別しない）が効くのは、編集した版の取り込みを許した後である。ユーザーには 2026-11-11 に報告した。上の影響の表の「Graph の本文の開示の拒否」の行の代償（作者が個別に secret を外した版から取り込んだ出来事にも拒否が掛かる）も、同じく、その後に生じる。

**受入れレビューの結果。** 漏れ（P0）と仕様違反・回帰（P1）は無かった。P2 の 3 件（DR-CAS-3 の検査に届かないことと試験の目的、DR-CAS-5 の結果の追記、IR の資格の判定そのものでの固定）は、この追記と試験の修正で解消した。確かめられた主な点：prepare と apply の両方が同じ検証を通る／apply は封じた計画を 1 回だけ読み、同じ値に検証と実行を掛ける／抽出の取り込みで年表の出来事を作るのは出来事の作成の操作だけで、rekey、cutover、restore、保守は出来事を書かない／Redo は取り込み直後の値を戻す／画面側と Native は同じ版から同じ操作を組み立てる／片方だけが元に戻っても、照合か新しい検査で拒まれる／人物、伏線、プロットの取り込みには影響しない。

**未確認のまま。** 古い形式の年表の抽出が、今の製品で取り込みまで届くか。年表から AI への秘密の判定（chat の tool、年表の snapshot、MCP）のコードそのものは、この PR では読み直していない（判定のコードに差分は無い）。
