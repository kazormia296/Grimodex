# ユーザーの回答の記録：容量超過の解き方の選択（GDV／GBR の選択の段）と、CI の perf の retry（2026-11-17）

- 経路：Claude Code の AskUserQuestion（2 回、計 4 問）
- 材料（contracts の外）：
  - `/home/grimodex/fusion-eval-data/pubg-a/05-iii-contract-draft.md`（改訂 1、SHA-256 `5d3ed477…`）
  - `05-iii-review-opus-1.md`
  - `/home/grimodex/fusion-eval-data/ci-perf-2026-11-17.md`
- 位置づけ：**選択の段の記録であり、契約の確認ではない。** 最終確認は、選んだ案だけで直した版の SHA-256 を名指して、別に行う。

## 選択の段（3 問）

1. **案の選択**：「案 B (Recommended)」
   - 案 B の中身：Verify が、coherent だが dirty な declared Graph binding を recognized unavailable（rebuildable-not-query-usable）と読み、検査の対象から外す。根拠は consumer contract :69 と POL-SC。データは消さない。緩和は 4 つ（GBR-B1〜B4）。
   - 前提の案 C も入れる：main 由来の durable な work を dispatch する前に、B の判定を通す。
   - 未確認の 2 点：
     - digest の側の失敗（V0 の (b)）を避けられるか。避けられなければ案 A に戻し、改めて伺う。
     - 全 project で Verify のやり直しが起きるか。
   - 前回の回答（`ed90f78b`、(iii) を起案する）は、独立レビューの後に比べ直した結果として、この回答で置き換える。
2. **実装の時期**：「次の S4 の PR の後 (Recommended)」
3. **案 B を契約の改訂として確認するか**：「確認する (Recommended)」
   - draftRef は GDV/1（案）。dev で試作し、SHA-256 を名指した最終確認を経てから実装する。

## CI の perf の retry（1 問）

- 質問の要旨：
  - 「Electron runtime performance」が、AWS の runner の起動時の first-frame stall で落ちる。最初のフレームだけが 5〜8 s 遅れ、直後の再測定では 1.2〜1.4 s で通る。
  - 今の retry は、GPU の command buffer の失敗の行がある場合に限られる（DR-PIS-8）。
  - master は 11/16 から赤い。11/14 にも同じ失敗が 4 回あった。
- 回答：**「条件を広げる (Recommended)」**
  - 最初のフレームだけが遅く、起動のほかの区間が正常なときは、1 回だけ再測定する。
  - 上限の値（4000 ms など）は変えない。別の PR で入れる。
