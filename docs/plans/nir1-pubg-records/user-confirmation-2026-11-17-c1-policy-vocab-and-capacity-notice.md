# ユーザーの回答の記録：PUB-G の C-1 の前倒しの 2 問（policy の語彙、容量の通知）（2026-11-17）

- 経路：Claude Code の AskUserQuestion（4 問のうち 2 問）。統合者（grimodex-ed）が伺った。資料は `/home/grimodex/fusion-eval-data/pubg-a/pending-questions-2026-11-17.md` の B-1（質問 2、B-1b）と B-10（質問 1）。点検済み。
- C-1 の本体（公開の承認）は、最終候補と最後の正式 run の後に伺う。この記録は公開を承認しない。

## B-1b：policy の語彙は「新しい契約」に当たるか

- 事実：B の production registry への登録で、policy の行に新しい語彙（`durableRun`、`writes` の `declared-index-binding`）が入り、schema の件数・enum・validator・parity 試験が変わる（`05-precheck.md` §2.4、`broute-decisions.md` DR-PUBG-5-12）。
- 回答：**「C-1 で差分を名指して確認 (Recommended)」**。語彙と schema の差分の一覧を C-1 の提示に添えて、そこで承認を得る（新しい契約として扱う安全側）。

## B-10 質問 1：容量の通知（GDV/1 の後の前提での再確認）

- 事実：容量を超えた project では Graph を作れず、Related Scenes は Graph を使わない。GDV/1（#932、master `07cea661`）の後は、その理由は画面に出ず、容量の超過による Verify 失敗の Finding も出ない（記録は process 内とデバッグ用のログだけ）。その Finding が Inbox で利用者に見えていたかは未確認。
- 回答：**「画面では知らせず開示だけ (Recommended)」**。前の回答どおり。開示に「理由は画面に出ない」と書き、Finding も残らないことを事実として併記する。
