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
