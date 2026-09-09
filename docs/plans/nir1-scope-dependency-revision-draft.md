# NIR-1: 読書順変更の復旧を妨げるScope依存と変更案

2026-09-08。状態: **ユーザー承認済み / 実装・検証中**。
確認対象 ref: `nir1-scope-dependency-delta/1`。
元の `nir1-plan/1`、`nir1-product-tm/1` と承認済み検索候補2を基点とする。
この文書の作成だけでは、既存C2BのSource・Freshness判定・永続形式を変更しない。

## 確認できた問題

標準build 11、通常抽出・非秘密化・当該childの明示承認を済ませた100 current revisionのworkspaceで、
source001をS2より後へcanonical tree writerで移動した。
旧UI結果は直ちに失効したが、Index再構築後のIRは0件となった。

- current child 100件の `project:scope-authority:default-project` edgeが、
  `source-revision-changed / stale / rebuild-required` になった。
- 移動対象以外の99件も、プロジェクト全体のScope authority tokenを共有している。
- Indexはそのcanonical判定に従って全childを除外した。読書順filterだけの誤りではない。
- これは固定復旧条件「対象を除外し、残りの適格rosterを実queryで利用できる」には届かない。

証跡: `/home/grimodex/Documents/Grimodex-evidence/nir1/first-product-path/l5-recovery-reading-order-change-preflight-1/report.json`。
元DB・失敗ログ・画面を保持する。正式100回測定はまだ開始していない。

原因は `human_materialization.rs` の `resolve_live_scope_override_authority` が、
非秘密のScopeOverrideでも全projectの `project-scope-authority` Sourceをeffective materialへ固定すること。
非秘密のScopeは `scene:exact(S1)` と他軸 `any` だが、無関係なscene順序の変化もこのSourceを変える。
既存のcanonical readerは、この固定された契約を正しく拒否している。

## 承認済み変更

**新しいScopeOverrideに、当該RevisionのScope解決に必要な値を束縛するNative所有のScope projection Sourceを導入する。**
C2Bのproducer / Source登録 / effective material / D1 / canonical readerを一つの変更として扱う。
全project tokenの不一致を無視して既存childをfreshにする方式は採らない。

具体的な契約は次を満たす。

1. Sourceはproject、元Run、immutableなanchor/reveal document identity、secret状態へ厳密に束縛する。
   入力identityとSource keyはNativeで検証・構成し、rendererから任意のScope verdictを受け取らない。
2. Nativeは現在の同一snapshotのproject/tree/Scope authorityを読み、anchor/revealの所属、存在、一意性を検証する。
   非秘密では、このidentityと `scene:exact(S1)` / 他軸 `any` の確定値に必要な投影を束縛する。
   無関係なsceneの並び替えだけでは、その投影を変化させない。
3. 秘密では、reveal解決とaudience / readingOrder / storyTimeなど実際に必要なauthority値をすべて投影へ含める。
   それらの変化、欠落、曖昧化は引き続き失効させる。秘密特権や曖昧identityの自動解決は追加しない。
4. 新Sourceは別versionとして登録し、sealed effective materialとD1に記録する。
   旧revision・旧Source token・承認・履歴は書き換えない。新規則を使うには通常の新child作成とそのchild自身の明示承認が必要。
5. whole-materialの現在の資格判定は維持する。S2より後のstory材料、未承認・非current・staleなRevisionは使わない。
   query / return / Evidence clickでの再検証、二consumerのcanonical資格、runtime/owner/generationも維持する。
6. projection Sourceのwriter coverageを登録し、削除・移動・所属変更・story time変更・undo・restore等を確認する。
   旧producerのlegacy読取、失敗時のRaw fallback、原子性を回帰検証する。

## threat model差分と受入れへの影響

Trusted actorsは既存local Native backend、immutableなmaterial/Decision ledger、canonical authorityのまま。
renderer・model出力は未信頼で、Source tokenや許可verdictを発行できない。
変更する防御は「全projectを常に一つのScope入力として束縛」から
「当該Scope解決に必要なNative検証済み投影を、完全なSourceとして束縛」への細分化である。
この意味の変更は `nir1-product-tm/1` の差分 `nir1-scope-dependency-delta/1` としてユーザーが明示承認した。

100件×各100独立復元trial、自動復旧p95 2秒、固定Gold、B/D/T、floor、融合条件は維持する。
元の100件fixtureと旧候補の記録を残し、同じ固定本文・解釈・queryから通常UIで新fixtureを作る。
新候補でfocused gates、実Electron比較、正式復旧試験、Quick/verifyを実行する。
L5の全条件が揃ってからready PRを作り、merge前で停止する。

本文編集で観測した二重Index再構築は別の内部修正として進める。
旧IndexのSourceに関係する未処理Feedを先に確認し、canonical処理が済む前の一時的な再構築を避ける。
これはSource/Freshnessの意味を変えず、今回の承認待ち変更から独立して検証できる。

## 承認条件の統合（2026-09-08）

ユーザーの添付承認文を本差分の受入れ条件とする。投影は入力identity・Run・version・参照の有効性を束縛し、秘密では他sceneによるstory key曖昧化も検出する。非秘密の比較digestには全project token、全reading revision、未使用rank、project更新時刻を入れない。
新childのScope依存をeffective material・永続sourceBasis・D1・V1で整合して置換する。同じSourceにEvidenceまたは非Scopeの役割があれば保持する。旧producer/generationの読取り、projection-onlyの親契約継承、child自身の明示承認を維持する。
投影が不変でも読書順変更でquery/UI/navigation contextを失効させる。対象revisionの除外と残るrosterをidentityと新generationで追跡する。rollback・undo・restore・競合を含む。
二重再構築修正は別差分として証跡を結び付ける。固定予算を緩めずL5完了後にready PR、merge前停止。Source登録・reader・writer hook・回帰試験の個別再承認は不要。
