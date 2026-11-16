# ユーザーの回答の記録：PUB-G #5 の precheck（2026-11-16）

- 経路：Claude Code の AskUserQuestion（3 問、1 回）
- 材料（contracts の外）：`/home/grimodex/fusion-eval-data/pubg-a/05-precheck.md`（基点は master `cea3988b`）
- 位置づけ：GDX-PRECHECK-001 に当たる（長期・高リスク、background／async-lifecycle、委任の内の threat model の改訂）。そのため、編集の前に伺った。

## 回答

1. **merge の時期（Q2a）**：「判断の docs は今、実装は S4 の merge の後 (Recommended)」
   - 判断を残す docs の PR は、すぐ merge する。
   - Rust、Native、main の実装は別の枝で進め、merge は次の S4（9 回目）の PR の merge の後にする。正式 run の候補には入れない。
2. **製品の wake の下での B の挙動（Q2b）**：「開示に回す (Recommended)」
   - 製品の起こし方（需要からの wake）での B の挙動は、CP-4 の評価の経路（別の seam）では測らない。このことを、PUB-G の開示の候補に載せる。
   - S2 と harness は変えない。
3. **容量の拒否の知らせ（Q3）**：「画面では知らせず、開示だけ (Recommended)」
   - 画面は変えない。process-local の記録と、code だけの log にする。
   - 開示の候補に載せる。

## まだ伺っていないこと

- **Q1**：容量を超えた project で、stale な binding の再構築が拒否されたときの扱い。
  - 先に V0 の調査をし、その結果を添えて伺う。選択肢は、(i) 開示、(ii) 新しい契約、(iii) 読みの変更。

## 範囲

この回答に含まれないもの：

- registry への登録の実体
- policy の行の実体
- 定数の切替
- 開示の文案
- 製品の公開

これらは PUB-G の PR（C-1）で扱う。
