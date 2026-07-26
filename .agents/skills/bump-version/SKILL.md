---
name: bump-version
description: >
  Grimodex の Electron リリースバージョンを上げ、リリースノート、commit、
  branch、PR、merge、注釈付き Release tag、GitHub Draft Release の確認まで進める。
  Release は公開せず、Draft のまま停止する。
  「バージョン上げて」「パッチ／マイナー／メジャーバージョン」
  「リリースタグ」「リリース準備して」で使用する。
---

# Bump Version

リリースバージョンを上げ、日英リリースノートを作成し、GitHub Draft Release の検証まで進める。引数が `patch`、`minor`、`major` のいずれかで、指定がなければ `patch` とする。`major` は対象 major の release workflow が準備済みの場合だけ実行する。本スキルは Release を公開しない。

## Release CIデバッグの停止guard

release workflow のfail／cancelled／timed_outを再実行することだけが目的なら、新しいバージョンは上げない。停止して`/debug-release-ci`へ渡す。失敗stage相当のfocused gateが修正HEADで成功し、そのfix commitが`origin/master`に含まれるまでは、version、release notes、tagを作成しない。

tag push後にreleaseが失敗しても、本スキル内で次のpatchへ再帰しない。同一SHAで回復できる一時障害はfailed jobだけを再実行し、修正が必要な失敗は`/debug-release-ci`で対象platform／stageを先に検証する。

## Electron 版バージョンの正本

electron-builder、`app.getVersion()`、v2 release workflow の tag gate は、すべて `package.json` の `version` を参照する。アプリのバージョン値はここだけを更新する。

次は変更しない。

- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`
- `src-tauri/Cargo.lock` 内の `grimodex` version
- shared Rust crate と N-API crate の `0.1.0`

これらは凍結済み Tauri v1 の履歴・移行契約、またはアプリ版とは独立した crate version である。

## Workflow

1. **Preflight**
   - `git status`、現在の branch、`origin/master` を確認する。
   - ユーザーの既存変更を release commit に混ぜない。
   - bump 種別と、ゴールが local、PR、merge、tag、Draft Release のどこまでかを確認する。
   - ユーザーが「リリース」と依頼しても、本スキルの終端は Draft Release とする。公開は同じ実行へ含めない。
2. **現在値と次の値を決める**
   - `package.json` の `version` を読む。
   - `patch`: `z + 1`
   - `minor`: `y + 1`, `z = 0`
   - `major`: `x + 1`, `y = 0`, `z = 0`
   - `major` の場合、`.github/workflows/release.yml` の tag pattern と release gate が新しい major を受け付けることを確認する。未対応なら version を変更せず、release pipeline migration が必要と報告して停止する。
   - local／remote に `v<新バージョン>` tag が存在しないことを確認する。
3. **`package.json` を編集する**
   - アプリのバージョン値は `package.json` だけを新値へ上げる。
4. **リリースノートを作る**
   - `public/RELEASE_NOTES/v<新バージョン>.ja.md`
   - `public/RELEASE_NOTES/v<新バージョン>.en.md`
   - `/write-grimodex-copy` を使用し、`docs/communication-style-guide.md` を正本として作成する。
   - 直近リリース以降の事実を一つのFact ledgerへ固定し、ja／enの変更、分類、深刻度、対象範囲、必要操作、backup、workaroundを一致させる。
   - 空の節、placeholder、裏付けのない変更を残さない。
5. **整合性を検証する**

   ```bash
   node -p "require('./package.json').version"
   node -p "require('./src-tauri/tauri.conf.json').version"
   node scripts/validate-release-version.mjs \
     --tag "v<新バージョン>" --ref-type tag --package package.json --major <新major>
   ```

   Electron 版が新値で、凍結 Tauri 版が v1 のままであることを確認する。release workflow の tag pattern と `--major` も同じ新 major を使っていることを確認する。

6. **branch と commit を作る**
   - `master` へ直接 commit しない。
   - 新規 branch は `chore/bump-v<新バージョン>` とする。既に適切な作業 branch 上ならそのまま使える。
   - `git status` と diff で対象を確認する。
   - `git add -A` は使わず、`package.json` と2つのリリースノートを明示パスで stage する。
   - commit 例: `chore(release): バージョンを<旧>から<新>に上げる`
   - repository の規約で要求される場合だけ `Co-Authored-By` trailer を付ける。
7. **push、PR、merge を行う**
   - release commit を作成して作業ツリーが clean になった後、`/ship-branch` をbranchのpush／PR／mergeフローとして使用する。
   - ユーザーが依頼したゴールに含まれる push、PR、merge まで進める。
   - `/ship-branch` の CI、mergeability、レビュー、HEAD 固定、base 反映確認を満たす。
8. **注釈付き tag をpushし、Draft Releaseを確認する**
   - merge 後の `origin/master` を fetch し、release commit を確認する。
   - ゴールに tag／Draft Release 作成が含まれる場合、`origin/master` の release commit に `v<新バージョン>` を付ける。
   - `git tag -a v<新バージョン> <release-commit> -m "Release v<新バージョン>"`
   - lightweight tag は使わない。
   - tag を push し、remote に反映されたことを確認する。
   - tag／head SHAが一致する `.github/workflows/release.yml` のrunを固定し、完了まで待つ。失敗時は次のversionを作らず `/debug-release-ci` へ渡す。
   - workflow成功後、`gh release view "v<新バージョン>" --json tagName,isDraft,isPrerelease,body,url` を直接確認する。
   - `tagName`が正しく、`isDraft`が`true`で、bodyが日英リリースノートと一致する場合だけ完了とする。
   - Draft URL、tag、release commit SHA、workflow run IDを報告して停止する。

ユーザーが単にファイル更新だけを指定した場合は、commit、push、PR、merge、tag、Draft Releaseへ範囲を広げない。一方、ゴールに含まれる操作については段階ごとに同じ承認を取り直さない。

## 公開境界

- 本スキルでは `gh release edit <tag> --draft=false` を実行しない。
- 元の依頼が「リリース」「公開まで」であっても、version bumpと同じ実行ではDraftのまま停止する。
- Releaseは、後続の別の明示的な指示があった場合だけ公開する。
- Releaseの公開は、Draft本文、asset、CI、tag／SHAをユーザーが確認した後の、別の明示的な公開指示を必要とする。
- Draftが意図せず公開済み、本文不一致、asset不足の場合は完了扱いにせず停止する。

## Release notesの正本

文体、呼称、日英テンプレート、重大情報、公開前チェックリストは `docs/communication-style-guide.md` を正本とし、ここへ複製しない。GitHub Draft Releaseのbodyは2つのversioned notesから生成する。アップグレード後の初回起動では `ReleaseNotesDialog` がja正本を参照し、英語UIはenからjaへフォールバックする。
