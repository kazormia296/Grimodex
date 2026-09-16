---
name: debug-issue
description: >
  バグを調査・修正する。再現→原因特定→修正→検証の順で進める。
  Use when: 「デバッグして」「修正して」「エラーが出る」「動かない」
  と言われたとき。一般のPR／master CI、ランタイムエラー、型エラーの修正に使う。
  Electron release workflow、tag build、署名、公証、publishの失敗はdebug-release-ciへ渡す。
allowed-tools: Read, Write, Edit, Grep, Glob, Bash, MultiEdit
---

「$1」を修正してください。

0. Electron release workflow、tag build、署名、公証、installer migration、artifact publishの失敗なら、versionを変更せず`/debug-release-ci`へ渡す
1. エラーメッセージ・再現手順を確認する
2. 関連コードを探索し、根本原因を特定する
   - Electron IPC関連なら renderer / preload / main / N-API の各境界を確認
3. 依頼済みの範囲内の修正は再承認を求めず継続する。範囲を広げる、不可逆操作を含める、または
   既存の明示確認要件に触れる場合だけ、その確認を得てから実装する
4. 修正を実装する
5. 既存テストが通過することを確認する
6. 再発防止のためのテストを追加する
7. `pnpm test` + `pnpm test:electron --run` + 対象 Rust crate の `cargo test` で確認
8. focused検証後、commitが依頼範囲に含まれる場合はCI許可の有無にかかわらずcleanな候補commitを作る。
   PR／releaseの証跡が依頼範囲に含まれ、CIが許可されている場合だけ、候補commit後に
   `candidate_base`／`candidate_head`を一度だけ解決し、同じ値でQuickと直後のverifyを実行する。
   commit-onlyまたはCI明示除外の作業ではQuickを開始せず候補commitを保持し、merge／release readinessを主張しない。
   失敗、blocked、partial、dry-runを成功扱いせず、原因を解消してcompleteな証跡になるまでPRへ進まない。
   commitが依頼されていない場合はQuickのためだけにcommitを作らず、CIも開始せず、working-treeの評価は診断専用とする。

   ```bash
   candidate_base="$(git rev-parse 'origin/master^{commit}')"
   candidate_head="$(git rev-parse 'HEAD^{commit}')"
   pnpm ci:local:quick -- --base "$candidate_base" --head "$candidate_head"
   pnpm ci:local:verify -- quick --base "$candidate_base" --head "$candidate_head"
   ```

9. commitが依頼されている場合だけ、検証済みの候補commitを最終commitとして保持する

**推測で修正しない。原因を特定してから修正すること。**
