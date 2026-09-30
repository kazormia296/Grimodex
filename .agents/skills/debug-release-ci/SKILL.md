---
name: debug-release-ci
description: >
  Grimodex の Electron release workflow、tag build、署名、公証、installer migration、
  artifact publish の失敗を、version と tag を増やさず診断・修正する。
---

# Debug Release CI

Releaseをデバッグ用テストハーネスとして使わない。失敗runと修正HEADを固定し、最小再現、対象stageだけのhosted gate、修正のmergeを先に完了する。正式なversion bumpとtagは最後に一度だけ行う。

## 責務境界

- Electron release workflow、tag build、署名、公証、Windows installer migration、artifact集約、Tauri bridge、GitHub Release publishの失敗だけを扱う。
- 一般のPR／master CI、型エラー、製品コードの単体テスト失敗は `/debug-issue` へ渡す。
- `package.json`、release notes、version、既存tagは変更しない。診断のためだけに新しいpatch versionやtagを作成しない。
- 既存tagを移動、削除、上書きしない。失敗したtagから次のpatch bumpへ再帰しない。
- 修正済みclean branchのPR／mergeは `/ship-branch`、focused gateとmerge完了後のDraft Release準備だけを `/bump-version` へ渡す。

## 1. 失敗状態を固定する

変更や再実行の前に、次を記録する。

- workflow run ID、run attempt、tag／ref
- head SHA
- 失敗jobとstep、最初の有効なエラー
- 成功済みjob、platform、artifact名
- artifactの期限と、source runが同じworkflow path／tag／head SHA／versionに属する証拠
- queue／runner／外部API／secret／workflow／コードのどこで失敗したか

`gh run view <run-id> --json ...` と失敗jobのlogを使い、推測で分類しない。同じrunの途中結果を、別SHAの結果と混ぜない。

## 2. 再実行か修正かを分類する

- runner切断、外部サービスの一時障害、artifact伝播遅延など、コード変更不要で同一SHAの再実行に意味がある場合だけ `gh run rerun <run-id> --failed` を使う。
- workflow、script、package、署名前提、secret契約の修正が必要ならfailed-only rerunでは直らない。修正branchで原因に最も近いcontract testを先にredにし、修正後greenにする。
- 既に成功したplatformは再実行しない。shared native code、lockfile、共通packaging設定を変えた場合だけ、影響範囲を明示して対象を広げる。
- full Release workflowを最初の再現手段にしない。

## 3. Targeted Release CIを使う

`.github/workflows/release.yml` の手動実行はdebug専用で、`publish=false`以外を拒否する。workflow自体は常にtrusted default branchからdispatchし、`candidate_ref`を別に渡す。未mergeのWindows／Linux修正は、originに存在する40桁commit SHAだけを`candidate_ref`に指定する。gateは指定SHAとcheckout結果の一致を検証し、そのSHAだけをbuild jobがcheckoutする。

| target    | 実行場所                                         | 用途                                                                        |
| --------- | ------------------------------------------------ | --------------------------------------------------------------------------- |
| `windows` | workflow=`master`、candidate=修正commitの40桁SHA | Windows package、未署名契約、実installer migration                          |
| `linux`   | workflow=`master`、candidate=修正commitの40桁SHA | Linux package、ABI、deb／rpm契約                                            |
| `mac`     | workflow／candidateともtrusted default branch    | production Apple secretsを使う署名・公証付きmacOS build                     |
| `publish` | workflow／candidateともtrusted default branch    | `source_run_id`の成功済みhost artifactを再利用したread-only publish dry-run |
| `all`     | workflow／candidateともtrusted default branch    | 全3 hostと早期bridge signing preflight。releaseは作成しない                 |

Windows／Linuxは修正commitをoriginへpushし、その40桁SHAを固定して`candidate_ref`に渡す。branch名や短縮SHAは渡さない。dispatchで返るrun URL／IDを記録し、gate logのresolved candidate SHAが指定SHAと一致することを確認する。手動runはtrusted default branchのworkflow定義とresolverを使い、candidate側の`.github/workflows/release.yml`は実行しない。workflow YAML自体の修正はcontract testを通してmergeした後、`candidate_ref=master`でhosted gateを実行する。

mac／publish／allはproduction secretをbranch codeへ渡さないため、focusedなlocal／contract検証後に修正を `/ship-branch` でdefault branchへmergeしてから実行する。candidateの`package.json` versionがdefault branchから変わっている場合もgateは拒否する。

例:

```bash
gh workflow run release.yml \
  --ref master \
  -f target=windows \
  -f publish=false \
  -f candidate_ref=<40-character-fix-commit-sha>

gh workflow run release.yml \
  --ref master \
  -f target=publish \
  -f publish=false \
  -f candidate_ref=master \
  -f source_run_id=<failed-release-run-id>
```

`target=publish` はsource runが正規の`.github/workflows/release.yml`、対象tag／SHA、またはtrusted default-branch debug runに属することを検査してからhost artifactをdownloadする。artifact名とversionの完全性を検証し、署名、signature検証、`latest.json`生成まで行うが、GitHub Releaseの作成・更新・uploadは行わない。source artifactが期限切れの場合だけ、`target=all`をdefault branchで実行し、そのrun IDを新しい`source_run_id`として使う。

## 4. 修正と証跡を閉じる

### Windows／Linux

1. 原因に対応する最小test／commandをgreenにする。
2. script／package修正ならcandidate SHAを固定し、対象platformのtargeted workflowをそのSHAでgreenにする。workflow YAML／job control／permissions／matrixの修正ならcontract test後に先にmergeし、default branch SHAでhosted gateを通す。
3. run ID、candidate SHA、target、成功job、元runの成功済みjobを記録する。別SHAの結果を「1つのgreen release」と表現しない。
4. PR／mergeが依頼範囲なら、ユーザー差分を混ぜずfix commitを作り、`/ship-branch`へ失敗run、原因、成功済みjob、focused gate、fix commit SHAを渡す。依頼範囲外なら証跡を報告して停止する。

### mac／publish／all

1. 原因に対応する最小test／commandをgreenにする。
2. PR／mergeが依頼範囲ならfix commitを`/ship-branch`でdefault branchへmergeする。権限がなければ、secret-backed gateや`/bump-version`へ進まずhandoff地点を報告する。
3. merge後のdefault branch SHAを固定し、`candidate_ref=master`で対象targetをgreenにする。
4. run ID、candidate SHA、target、成功job、再利用したsource_run_idとそのtag／SHA／artifact期限を記録する。

どちらの経路でも、元のゴールがrelease準備までの場合だけ、fixが`origin/master`に含まれfocused gateが成功した後 `/bump-version` へ渡す。version bump、tag、full release workflow、Draft Release組み立てはここで一度だけ行い、Releaseは公開しない。

## 停止条件

- run ID、head SHA、失敗stepを固定できない
- workflow dispatchの`--ref`がdefault branch以外、未mergeのWindows／Linux修正の`candidate_ref`が40桁SHA以外、またはsecret-backed targetの`candidate_ref`がdefault branch以外
- `publish=true`、tag移動、既存releaseの破壊的変更が必要
- source artifactが不足・期限切れで、再build範囲を広げる根拠を説明できない
- focused gateが失敗中
- secret-backed gateのfix commitが未mergeで、`/ship-branch`へ進む権限もない

停止時は、成功済みjobを含む現在状態、足りない証跡、次に必要な最小操作を報告する。
