# G-04 v2 期待値の独立導出（設計文書 §2〜§4 を読む前）

入力: v2 の corpus と setup（scenes、scope、entities、relations、revisions、pins、qualifiedIr、setupTimeline）と規則（README 表 L114-L129、contract.mjs）。

## Revision の資格（contract.mjs:367-405）
- r-lio: rv-match（order 0 < 100）、Scope は default（explicit、3 軸 exact が query identity と一致、reader／reader）→ 資格あり
- r-kit: rv-alt の material worldline exact wl-alt ≠ query wl-main → scope-mismatch
- r-ora: rv-unresolved の material worldline unresolved → scope-unresolved
- r-tam: rv-unknown の marker unknown → scope-marker-unknown
- r-sel: rv-holder の holder character（Mott）→ holder-not-reader
- foreshadow／mutation が無いので stale と secret は無い
- review Scene の本文はどの規則にも入らない → Scope 除外の理由は v1 と同じ

## graph
- 適格 Entity: bren、lio。適格 Relation: ferried-lio。seed bren は適格
- nodes [bren@0, lio@1]、edgeIds [ferried-lio]
- excludedEdges: kit/ora/tam/sel = revision-excluded。excludedEntities: kit/ora/tam/sel = revision-excluded、mott = no-revision
- 入力（revisions、scope、relations、entities、seed、foreshadows、mutations）が v1 と同一 → graph は v1 と同じ bytes であるべき

## Scene への対応付けと融合
- 到達した非 seed Entity は lio だけ。lio の pin は (lio-landing, lio) の 1 件 → frame の pin 数 1（≤8）
- control の pin（kit/ora/tam/sel）は未到達 Entity なので候補にならない
- R = [control]（control 1 件 → orderPredeclared true）
- ir-only が無い → R+IR = [control]、irSupplementSceneId null。resultKind は記録だけ（control IR の admission 次第で raw／fused）
- slotFree（1 < 8 かつ irSupplement null）→ fresh = [lio-landing]（hop 1、1 件だけ）→ addedScene = lio-landing、path bren→ferried-lio→lio hop1
- pathAttachments = []（R+IR の Scene に候補が無い）、blockedCandidates = []（lio-market に pin が無い）
- R+IR+Graph = [control, lio-landing]、appendedSceneId lio-landing、baseline rPlusIr
- scenesWithoutPath = [control]、forbiddenSceneIds = []（decoy 無し）
- excerpt: lio-landing の本文は改行なし 211 UTF-16 単位 → [0, 211) で本文全体

## evidence
- Graph が寄与（追加 1 件）→ 必須 4 種 + added-scene-body-anchor。path 付加が無いので raw-excerpt-unchanged は validator 上必須でない
- pathEvidenceValidity 1、assertions []

## metrics（gain 2^g−1、log2(i+2)）
- relevant: lio-landing(3)、lio-market(2)。IDCG = 7/1 + 3/log2 3 = 8.892789
- R [control]: recall 0、nDCG 0
- R+IR [control]: recall 0、nDCG 0
- R+IR+Graph [control, lio-landing]: recall 1/2 = 0.5、DCG = 7/log2 3 = 4.416508、nDCG = 0.4966393
- 非回帰（R+IR+Graph ≥ R+IR）成り立つ。lio-market は返らないので recall の上限は 0.5

## preconditions（contract.mjs:1633-1655）
- b-sealed-binding、maintenance-enabled、raw-membership（variant）
- ir-only が無いので ir-supplement-admission は不要
- 追加 1 件 → cb4-inputs（added-scene、sceneId lio-landing）

## 一致の確認（validator 実行、schema の fixtureId pattern だけメモリ上で /[12]$ に緩めた）
- v1 0 件、v2 0 件。computed は上の導出と一致。framePinCount v1=2 → v2=1
