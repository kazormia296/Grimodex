# DA-1 の委任判断の記録（mutation の前に記録。継続計画 §3.2 の形式）

lane: DA-1（branch `claude/nir1-da1`、base `a0ce11aa`）。出所の確認済み draft は K3/2（`docs/plans/nir1-d2a-activation-proposal-2-draft.md`）。この版は ST1（隔離の固定と書出し経路の遮断）の実装の前に書いた記録で、ST2 以降の判断（DR-DA1-1〜4、8〜10）は「見込み」として置く。実装で変わったものは、後ろの追記の行（状態の列）と ST ごとの commit に書き、この表の本文は直さない。

| ID | 日付 | レーン／PR | 判断 | 信頼境界 | 代替案 | advisor | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-DA1-0 | 2026-10-17 | DA-1 | 範囲の読み。lane の定義文にある「activation の順序（grant の消費を最初の段に置く）と一方向の状態遷移の起動」は、K3/2 の「Lane unlocked if confirmed」が DA-2 に置いている。DA-1 は K3/2 の DA-1 の列挙（route 区分と `own-data-read`、外へ出す経路の閉鎖、renderer の隔離、SF-1、E-3、窓の title、`license-control`、旧 AI の入口の拒否〔G-2〕、Vivliostyle の CLI の検出の拒否、NIR の区分の identity、Scope の Native の検査、R と R+IR の parity の計測）に従う。activation の段 1〜7、待ちの上限、状態ファイルの受理条件、spellchecker の記録、`resetWindowTitles()` の呼出しは実装しない。SF-1 は DA-2 の trigger より先に merge する | 新しい authority を作らない。grant を伴わない activation の経路を足さない。SF-1 で状態ファイルへの画面からの到達を閉じてから trigger が入る | lane の定義文どおり activation の順序を DA-1 に含める（K3/2 の列挙と食い違い、確認の範囲を越える） | 不要（確認済み draft の列挙の読み。integrator に通知） | 該当なし | 不要 | 記録済み（実装前） |
| DR-DA1-1 | 2026-10-17 | DA-1（ST3） | Native の表の台帳の表現。closed（26 表、名前で列挙）と read-open（58 表）を別の集合で持ち、policy を版 2 にする。宣言を欠く追加は、実 DB（schema 41）の `sqlite_master` の全表を closed／read-open／台帳に載らない表のどれかに分類する網羅の試験と、enum の宣言の全表照合で、試験が通らないようにする。既定の扱いは置かない | 台帳が authorizer と Main の早期分類の唯一の正本。台帳にない表は未分類として扱い、広げない | 接頭辞で決める（未知の表が既定で開く）。既定を closed にする（read-open の宣言が漏れても気づけない） | ST3 の開始時に判断する見込み | 該当なし（保存範囲を広げない。読取だけを開く） | 不要 | 見込み（ST3 で確定） |
| DR-DA1-2 | 2026-10-17 | DA-1（ST3） | Main から Native への `own-data-read` の分類は、`dispatchArgs` の側で Main が N-API の追加の引数として付ける。renderer の値は無視する | renderer が偽造できない。renderer が渡した同名の key は捨てる | wire の payload に key を足す（renderer の値と衝突する）。Native が SQL を自分で再分類する（authorizer が権威。読取専用の確認だけを足す） | ST3 の開始時 | 該当なし（新しい IPC の入口ではない。draft が求める引数） | 不要 | 見込み（ST3 で確定） |
| DR-DA1-3 | 2026-10-17 | DA-1（ST4） | NIR の区分と Scope の Native の入口の identity は、`ipc.ts` の non-enumerable な `callerIdentity` の sidecar と `callerIdentityWire` の形式に揃える。typed command の enumerable な wire の形を変えない（`deny_unknown_fields` を壊さない） | 既存 request の形を変えない | N-API の引数を command ごとに足す（`index.d.ts` の変更が広がる） | ST4 の開始時 | 該当なし | ST4 で §8 の行を埋める | 見込み（ST4 で確定） |
| DR-DA1-4 | 2026-10-17 | DA-1（ST2） | G-2 の判定は `begin_profile_egress_dispatch` の中（permit を作る前）で、profile が restricted なら登録済み caller と停止済みでも拒否する。`ProfileEgressState::begin_dispatch` は変えない | Native は command の一覧を持たず、Main の route 台帳に依らずに拒否する | 8 入口で個別に判定する（漏れる） | ST2 の開始時 | 該当なし（拒否を増やす） | ST2 で §8 の行を埋める | 見込み（ST2 で確定） |
| DR-DA1-5 | 2026-10-17 | DA-1（ST1） | SF-1 の方法。(1) 比較は canonical path と file の identity（device と inode）の両方で行い、どちらか一方で一致したら「重なる」とする。対象の最も近い既存の祖先まで realpath し（存在しない末尾の名前は祖先に付ける）、祖先の鎖の identity に profile data directory の identity があるかを見る。鎖で見るので、大文字小文字を区別しない file system、Windows の短縮名、junction、bind mount、profile data directory 自体が symlink の場合も成り立つ。canonical にできない、末尾が dangling symlink、profile data directory が解決できないときは拒否（fail closed）。inode が 0 の volume は identity を使わず canonical path の比較（Windows と macOS は大文字小文字を区別しない）だけにする。profile data directory は呼出しごとに `app.getPath("userData")` から解決し直し、cache しない。(2) 集める場所は `electron/main/profileDataGuard.ts`。mount の manager と `showSavePathDialog` と `will-download` が同じ guard を使う。(3) mount: 登録時に root と profile data directory が等しい、含む、含まれるを拒否（registry と scan の前）。read／write／mtime は呼出しごとに解決した最終 path が profile data directory の中なら拒否し、write は書込みの直前にも解決し直す。(4) 保存 dialog: `suggestedName` は単一のファイル名にする（`/`、`\`、NUL、制御文字を `_`。Windows は `:` も `_`。`.`、`..`、空は既定名 `export`）。長さの上限は 120 文字（code point）で、拡張子（16 文字まで）を残して stem を切る。通常の拡張子つきの名前は変わらない。返却 path は書く前に guard で検査し、拒否は平文と path を含まない typed な理由にする。(5) Chromium の download は候補 (a)。全 session の `will-download` で、同期に `item.setSavePath` を OS の temp 直下の新規 directory（`mkdtemp`）の固定名 file に向け、完了後に Main が `showSavePathDialog`（初期値は単一のファイル名にした `item.getFilename()`）で利用者に保存先を選ばせ、guard で検査してから copy する。temp の directory は完了、取消、失敗のどれでも削除する。temp の directory が profile data directory の中なら取り消す。renderer が決められるのは名前（単一のファイル名にされる）と内容だけで、保存先は利用者が dialog で決める。(6) E-3: mount の manager に `restricted || unavailable` を返す関数を注入し、read／write／mtime は解決した最終 path の拡張子が `.md`（大文字小文字を区別する）のときだけ通す。root の選択、登録時の scan、unrestricted は変えない | Untrusted は renderer が渡す path、`suggestedName`、download の名前と内容、symlink の差し替え。check と use の間の root の下の差し替え（renderer は symlink を作れない。同じ OS ユーザーの process は Out-of-scope）は呼出しごとの検査と書込み直前の再解決で縮める。hard link で状態ファイルへつながる file を renderer が作る手段はない（残余として記録） | 文字列の前方一致だけの比較（大文字小文字、短縮名、symlink で破れる）。identity だけの比較（inode が 0 の volume で使えない）。(b) 製品の 5 箇所を `export_save_*` に寄せる（renderer の呼出しを変える範囲が広く、安全網がなお必要。後続で寄せてもよい）。(c) 保存先が決まった後の `updated` で取り消す（Chromium の中間 file が保存先に作られる。「書く前に拒否」を満たさない）。download の取消だけにする（利用者の書出しが壊れる） | 未実施。この builder には subagent の起動手段がないので、integrator に read-only の Opus advisor（requested／effective の model と effort を記録）による事後の確認を依頼する。結論が違えば ST1 を直す | 該当なし（新しい受信先なし。保存範囲を広げない。拒否を増やす。unrestricted の挙動は SF-1 の拒否を除いて変えない） | 要。§8 の `will-download`、保存 dialog、mount の行 | 記録済み（実装前） |
| DR-DA1-6 | 2026-10-17 | DA-1（ST1） | (1) CSP: `createAppProtocolHandler` の全応答（200、404、405）に同じ `APP_CONTENT_SECURITY_POLICY` を付ける。directive は変えない。(2) packaged の env: `electron/main/devRendererUrl.ts` の `resolveDevRendererUrl({ isPackaged, env })` を `windows.ts`、`windowChrome.ts` の呼出し、`security.ts`、`index.ts` が共通に使う。`app.isPackaged` が true のときは undefined を返す。非 packaged の dev server と journey の起動は変えない。(3) 窓の title: `windows.ts` が窓の生成時に `page-title-updated` の handler を付け、`setWindowTitleLock(() => boolean)` で注入された関数（既定は固定する側）が true なら `preventDefault()` する。`index.ts` が `restricted || unavailable` を注入する。`resetWindowTitles()` が生成時の title に戻す（呼出しは DA-2）。(4) 版上げの検知を採る: probe が記録 file に Electron の版を書き、`package.json` の版との一致を `electron/main` の試験で確かめる | CSP は renderer の同一 origin の realm（iframe、worker）の通信を閉じる。packaged が env を見ないことで dev origin の読込を閉じる | CSP を HTML だけに残す（HTML 以外の応答を開いた realm が CSP なしになる）。env の無視を各所で個別に書く（漏れる） | 不要（確認済みの設計の実装） | 該当なし | 不要（既存 owner の判定の追加。title の handler は窓に従う） | 記録済み（実装前） |
| DR-DA1-7 | 2026-10-17 | DA-1（ST1） | Y-1 の道具の構成。`electron/scripts/renderer-isolation-probe.mjs` が、本体の `protocol.ts`、`security.ts`、`windows.ts` の `buildWebPreferences()`、`downloadGuard.ts` を esbuild で束ねた probe 用の main を、一時 userData と一時 dist で起動する。Electron は `scripts/local-ci-xvfb.mjs` 経由の host namespace の Xvfb で動かし、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS` を外し、`ELECTRON_OZONE_PLATFORM_HINT=x11` にする。`unshare -n` は使わない。外への通信の遮断と記録は Chromium に効く `--host-resolver-rules`（`*.probe.test` だけを 127.0.0.1 の canary に向け、ほかは `~NOTFOUND`）と `--log-net-log`（Everything）で行い、canary の TCP／UDP の listener の受信を数える。試す内容は K3/2 の (i)〜(vi)。外へ出せる経路が見つかったときの塞ぎ方は、Main の network 層（WebRTC の IP の取扱い方針、resolver の規則、`session.webRequest` など）の候補を記録し、塞げなければ [precheck]。この commit では塞ぐ設定を足さない | probe は診断で、製品の挙動を変えない。canary は loopback だけ | probe を実アプリ（`dist-electron/main.cjs`）で動かす（native addon の cargo build が必要で重い。実アプリの試走は独立受入れ） | 難しい判断。DR-DA1-5 と同じく integrator に Opus advisor の事後確認を依頼 | 該当なし（新しい受信先なし。診断） | 要。§8 の Y-1 の probe の窓の行 | 記録済み（実装前） |
| DR-DA1-8 | 2026-10-17 | DA-1（ST2） | license の key の exact な文法と長さの上限、restricted の client の構成 | `api.polar.sh` の固定の 3 path だけ。proxy と redirect を使わない | — | ST2 の開始時 | 該当なし（確認済みの L-1／N-1。委任の外に当たりそうなら [precheck]） | ST2 で §8 の行を埋める | 見込み（ST2 で確定） |
| DR-DA1-9 | 2026-10-17 | DA-1（ST2〜3） | 実 router＋gate＋Native の試験の置き場と実行方法 | — | — | ST2 の開始時 | 該当なし | 不要 | 見込み（ST2 で確定） |
| DR-DA1-10 | 2026-10-17 | DA-1（ST4） | R と R+IR の parity の harness の引数（`--d2a-mode`）と receipt の項目 | `contract.mjs`、Gold、期待値は変えない | — | ST4 の開始時 | 該当なし | 不要 | 見込み（ST4 で確定） |

## ST1 で確かめた事実と実装メモ

- `app://bundle` の応答は `createAppProtocolHandler` の 4 経路（405、404 の解決不能、404 の読めない、200）。HTML だけに CSP が付いていた。
- `ELECTRON_RENDERER_URL` を読む箇所は `windows.ts`（262 付近の main 窓、パネル窓の `buildPanelUrl` の引数）、`security.ts`（`isAllowedNavigation`、`isTrustedRendererUrl`）、`index.ts`（app protocol の登録）。`electron/scripts/dev.mjs` だけが env を設定し、`start.mjs` と journey の harness は外している。
- 状態ファイルのある profile data directory は `app.getPath("userData")`（`backend.ts` が Native の `appDataDir` に渡す値と同じ）。
- `showSavePathDialog` の呼出し元は `shellCommands.ts` の `promptSavePath`（`export_save_text`／`export_save_bytes`）と `index.ts` の Vivliostyle の `pickSavePath`（`vivliostyle_save_output`）の 2 つ。guard は `showSavePathDialog` の中に置き、両方が通る。
- Electron の `fileSystem` permission（File System Access API の書込み）は `isAllowedRendererPermission` の allowlist（`notifications`、`clipboard-sanitized-write`）にないので拒否される。実機の確認は probe に含める。

## owner／lifecycle matrix（mutation の前に写し、builder が埋めた。ST1 の行）

| 対象 | entry／start／retry／reentrant | admission closure／pending start | active handle／cancellation | bounded wait／終了の証拠 | error／timeout／onClosed／restart |
|---|---|---|---|---|---|
| `will-download` の handler（ST1） | 全 session の `will-download` で download ごとに 1 回。再入は download item ごとに独立。retry なし。temp の directory は item ごとに `mkdtemp` で新規に作る | 保存先が決まる前の item は、setSavePath を同期に temp へ向けるので profile data directory に書かない。temp が profile data directory の中なら取り消す。窓（webContents）が destroyed になったら `item.cancel()` | `item.cancel()`。temp の directory は `done`（completed／cancelled／interrupted）のどれでも削除する | 完了、取消、失敗のどれかの `done` event を証拠にする。保存 dialog の待ちは利用者の操作で、app の上限は持たない（item の寿命は窓に従う）。dialog の後の copy が終わるか失敗するまでを 1 つの async 区間とし、temp の削除は finally | 失敗と拒否は平文と path を含まない typed な通知（Main の記録と error の dialog）。temp を残さない。再起動では何も残らない（temp は OS の temp directory で、起動時の掃除は持たない） |
| 保存 dialog（`showSavePathDialog`） | 既存の 1 呼出し 1 dialog。検査は dialog の返却の後、書込みの前に 1 回 | 窓が閉じたら null（既存） | 取消は dialog の取消 | 返却 path の guard の結果を証拠にする | 拒否は typed。書込みの失敗は既存どおり |
| mount の manager（ST1） | 既存の register／read／write／mtime／scan。検査は登録時と呼出しごと。write は書込みの直前にも解決し直す | gate が unavailable のときも E-3 を当てる（`restricted || unavailable` を呼出しごとに読む） | watcher の停止は既存 | 変えない | 拒否は typed。再起動で registry は空（既存） |
| Y-1 の probe の窓（ST1、ST4） | probe の実行ごとに起動し、終了で消える。一時 userData と一時 dist を作り、終了で削除する | — | probe の終了で窓を閉じ、listener を閉じ、net log を保存する。timeout で Electron の process を kill する | 記録 file（Electron の版つき）が証拠 | 異常終了では記録を採り直す。desktop への副作用が出たら報告 |

ST2 以降の行（Native の旧 AI の 8 入口、license の client、NIR の区分の Native の入口）は、それぞれの ST の commit で埋める。

## ST1 の実装後の追記（2026-10-17。上の表の本文は直さない）

### 実装で決めたこと（DR-DA1-5、DR-DA1-6 の範囲内）

- guard の既定は `app.getPath("userData")` を呼出しごとに解決する `profileDataGuardDefault.ts`。mount の manager は guard を option で受け、省略すると何も通さない（fail closed）。`index.ts` が既定の guard と `isProfileRestricted: () => restricted || unavailable` を渡し、静的な検査（`rendererIsolation.static.test.ts`）が配線を固定する。
- 比較は、対象の最も近い既存の祖先まで `realpath` し、祖先の鎖の identity（device と inode）に profile data directory が入るか、または canonical path の包含（Windows と macOS は大文字小文字を区別しない）で見る。絶対 path でない、`..` を含む、NUL を含む、ENOENT 以外の error、dangling symlink、ENOTDIR は拒否する。
- 保存 dialog の guard は `showSavePathDialog` の既定の引数なので、`export_save_*` と `vivliostyle_save_output` の両方が通る。拒否の理由は `PROFILE_DATA_DIR_REJECTED: <reason>` で、path を含まない。
- download の guard は、既定の session と `app.on("session-created")` で後から作られる session の両方に付ける。保存先は mkdtemp の固定名 file。完了後に `showSavePathDialog` で利用者に選ばせ、guard で検査してから copy する。実機で `<a download>` が `will-download` に来て、保存先を同期に決めれば Electron の既定の dialog が開かないこと、状態ファイルへの保存が拒否されること、通常の保存先へは書けることを probe で確かめた（`renderer-isolation-probe.record.json` の downloads）。
- `<iframe src=…>` で octet-stream の応答を開くと Chromium の download が起きる（probe で観測）。同じ guard を通る。
- 窓の title は `BrowserWindow` の `page-title-updated` を取り消す（`win.on`）。title の固定は供給されるまで固定する側（fail closed）。`resetWindowTitles()` は生成時の title に戻す（呼出しは DA-2）。
- 長さの上限は 120 code point、拡張子は 17 文字（`.` を含む）まで残す。surrogate pair を割らない。
- 版上げの検知は採った（DR-DA1-6 の (4)）。`electron/main/rendererIsolationProbeRecord.test.ts` が記録の Electron の版と `package.json` の版を比べる。

### 残余として記録するもの（委任の範囲では閉じない。新しい経路ではない）

- hard link: profile data directory の file への hard link を外に置いても、保存 dialog の `writeFile` は同じ inode を書く。renderer は hard link を作る経路を持たない（同じ OS ユーザーの process は Out-of-scope）。置き場所で見るので guard は通す（`profileDataGuard.test.ts` で固定）。
- check と use の競合: renderer は symlink を作れない。同じ OS ユーザーの process による差し替えは Out-of-scope。呼出しごとの検査と、書込みの直前の再解決で縮めた。
- Windows の短縮名と大文字小文字だけの違い: Linux では実機で試せない。identity（NTFS の file ID）と canonical path の大文字小文字を区別しない比較の両方で拒否する設計で、比較関数は platform を指定して単体試験している。実機の確認は Windows の独立受入れ。

### E-3: FE が `.md` だけを渡すことの確認（K3/2 の DA-1 の確認事項）

`external_mount_read_file`／`_write_file`／`_file_mtime` を呼ぶ FE の箇所は 4 つで、`relPath` の出所はすべて `.md` に限られる。
- `src/features/external-mount/api.ts` の 3 つの wrapper の呼出し元は、`mountManager.ts:1684-1686`（`handleFileChanged`）、`mountManager.ts:2181`（conflict の書き戻し）、`writeBack.ts:96`（`flushWriteBack`）だけ。
- `handleFileChanged` の `relPath` は main の watcher の event（`externalMount.ts` の `onFsEvent` が `.md` 以外を捨てる。`externalMount.test.ts` の「非 .md イベントは無視」が固定）。conflict の `relPath` と `writeBack` の `sourceUri` の `relPath` は、scan（`.md` だけ）か同じ watcher の event から作った Scene の `sourceUri` に由来する。`buildSourceUri` の呼出し 15 箇所を確かめた。
- `.md` 以外を渡す呼出しは見つからなかった（[precheck] は不要）。

### 棚卸し: renderer が渡す値で書く file の path が決まる経路（最終候補で ST4 が再実行する）

`electron/main` の fs の書込み（`writeFile`、`appendFile`、`copyFile`、`rename`、`rm`、`mkdir`、`createWriteStream` と同期版）を `git grep` した結果は次のとおり（K3/2 の結果から増えていない）。
- renderer の値で path が決まるもの: `external_mount_write_file`（SF-1 と E-3 の対象）、`export_save_text`／`export_save_bytes`／`vivliostyle_save_output`（保存 dialog。SF-1 の 7）、Chromium の download（`will-download`。SF-1 の 8）。
- 固定の path か、renderer が名前を決められないもの: `keyStore.ts`、`windowState.ts`、`credentialMigration.ts` の marker、`mcpSidecarInstall.ts`、`mozkeyInstaller.ts`（名前は GitHub の release の asset）、`codexAppServer/isolatedHome.ts`、`narrativeMaintenanceCiSeam.ts`（CI の env）、`vivliostyle.ts` の入力（`book.html`／`theme.css` の allowlist だけ。`ALLOWED_FILE_NAMES`）、ログ（`~/.grimodex/logs`）。
- N-API: path を受けるのは `open_workspace`（固定の名前の file だけを書く）と `restore_backup`（`grimodex-*.db` の basename だけ）。
- File System Access API: `showSaveFilePicker`／`showOpenFilePicker`／`showDirectoryPicker` は存在する（probe で確認）。利用者の操作を模して呼ぶと native の dialog が開く（probe では 4 秒後も pending）。picker で選んだ後の書込みは `fileSystem` permission を要し、`isAllowedRendererPermission` の allowlist にないので拒否される設計だが、dialog の中の操作は probe では自動化できていない。**未確認の項目として独立受入れの実機に渡す**（利用者が profile data directory の file を picker で選び、書込みが拒否されること）。
- `window.print()`: 利用者の操作を模して呼ぶと printing の utility process が起動し 4 秒後も pending（native の印刷 dialog と思われる）。dialog の中の「ファイルへ印刷」で保存先を選べる場合、保存先は利用者が選ぶが、profile data directory の検査は通らない。**新しい経路の候補として独立受入れの実機に渡す**（Linux の GTK の印刷 dialog に「ファイルへ印刷」があるか、初期の名前が `document.title` から決まるか）。閉じられない場合は [precheck]。

### Y-1 の試走（ST1。`node electron/scripts/renderer-isolation-probe.mjs`）

環境: Electron 43.5.0（Chromium 150）。`scripts/local-ci-xvfb.mjs` を host namespace で使い、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS` と env の proxy を外し、`ELECTRON_OZONE_PLATFORM_HINT=x11`。`unshare -n` は使っていない。process の sandbox は有効（`--no-sandbox` なし）。遮断と記録は `--host-resolver-rules`（`*.probe.test` だけを loopback の canary へ、ほかは `~NOTFOUND`）と net log（Everything）。試走の前後で `/tmp/.X11-unix` は X0、X1 のままで、desktop への副作用は出なかった（最初の試走が正常終了せず Xvfb が 1 つ残ったので、その pid だけを止めた）。

**製品の候補（`renderer-isolation-probe.record.json`）の結果**
- 外向きの試みが網に届いたもの: **WebRTC の ICE server 経由だけ**（`webrtc.turn-tcp`、`webrtc.turns-tls`、同一 origin の realm からの同じ試み）。`RTCPeerConnection` に `turn:host:port?transport=tcp` か `turns:host:port` を渡すと、Chromium は名前を解決して TCP に接続し、`turns:` では TLS の ClientHello（SNI）まで送る。接続先の host 名と port に、画面が読めるデータを載せられる。CSP の `connect-src` も permission も止めない。UDP の STUN／TURN は canary に届かなかった。
- 0 件だったもの: fetch、no-cors の fetch、XHR、WebSocket、EventSource、sendBeacon、img、CSS／script／iframe／media、form、meta refresh、`window.open`（窓は増えない）、`<a ping>`、dns-prefetch／preconnect／prefetch／prerender／preload／modulepreload、同梱 script から作る classic と module の worker（fetch と importScripts は CSP で止まる）、blob／data／外部 URL の worker、service worker（登録は TypeError で拒否）、HTML 以外の応答（json、png、js、md、未知の拡張子）と 404 と `%2e%2e` の応答を開いた realm（応答に CSP が付き、その realm からの fetch／beacon／img／WebSocket／XHR は止まる）。
- 同梱の force-layout worker は CSP の下で動く（3 node の layout が `done`）。
- 窓の title: restricted の固定で `document.title` を変えても製品名のまま。固定を外した対照では変わる（検査が検出できる）。
- `<a download>` で名前を `profile-egress.json` にし、保存先に状態ファイルが選ばれる攻撃は拒否され、状態ファイルは変わらない。通常の保存先へは書ける。
- clipboard は利用者の操作なしでは書けない（NotAllowedError）。通知は allowlist にあり、`permission:granted`（開示の残余）。geolocation、camera、microphone、clipboard-read、midi、persistent-storage、background-sync、screen-wake-lock は拒否される。`navigator.mediaSession.metadata` と `navigator.setAppBadge` は設定できる（OS に渡るかは、D-Bus の session を外した probe では未確認）。
- marker のない外向きの観測: spellchecker の辞書の取得（`redirector.gvt1.com`。X-1 の開示の「続く通信」）と、Chromium の IPv6 到達性の確認（`[2001:4860:4860::8888]:443` への UDP connect。データは送らない）だけ。
- 対照（DA-1 の前の挙動に戻した `--legacy-control`）では、CSP のない同一 origin の realm と worker からの fetch／beacon／img／WebSocket／XHR が網に届く（検出できる）。

**Main の設定で塞げるかの試験（`--countermeasure`／`--electron-arg`。どれも製品には入れていない）**

| 候補 | WebRTC の経路 |
|---|---|
| `webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` | 塞がらない（TCP と TLS の TURN は残る） |
| `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` | 塞がらない |
| `--webrtc-ip-handling-policy=disable_non_proxied_udp` | 塞がらない |
| CSP に `webrtc 'block'` を足す | 効かなかった（Chromium 150 の既定では効かない。CSP の directive の変更は再確認の対象でもある） |
| `--disable-webrtc` | 効かない |
| `--disable-blink-features=RTCPeerConnection` | 効かない |
| `--proxy-server=socks5://127.0.0.1:9`（全 Chromium の通信を blackhole の proxy へ） | 塞がる。ただし更新・spellchecker を含む Chromium の通信すべてを止める（unrestricted の挙動を変える） |

**判断**: 委任の範囲で塞げる設定がない。塞ぐ候補（PAC による allowlist の proxy、窓だけの partition など）は unrestricted の更新と spellchecker の通信、または保存済みの renderer のデータを変えうるので、U3 の委任の外（新しい network 設定、再確認）。したがって **ST3 の「`own-data-read` の開放を有効にする」commit は入れない**（TASK §4 の依存と §10）。`rendererIsolationProbeRecord.test.ts` の `OPEN_FINDINGS` が、この finding だけが残っていることを固定する。
