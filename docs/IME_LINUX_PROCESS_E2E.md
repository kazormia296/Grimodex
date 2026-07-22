# Linux IME process E2E

Linux受け入れ条件44（IME起動でconsumerがGrimodexに検出される）は、
`grimodex-db`のignored integration testで確認する。

テストはMozkey IbGリポジトリの実Fcitx5 launcherを一時的な
`GRIMODEX_IME_ROOT`とXDGディレクトリ群で起動し、`get_status(root, Auto)`をpollする。
Mozkey IbGが宣言する `fcitx5-mozkey-ibg` consumer、Linux platform、Phase 3の能力フラグ4種、
`effective_enabled`を確認後、headless Fcitx5と一時ディレクトリを終了・削除する。

通常の`cargo test`では実行されない。実行するときは、launcherの絶対パスを指定する。

```bash
GRIMODEX_LINUX_MOZKEY_LAUNCHER=/absolute/path/to/mozkey-ibg/scripts/launch_fcitx5_mozkey_e2e \
  cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --test linux_ime_server_e2e -- --ignored --nocapture
```

CIでforkと結合する場合は、Mozkey IbGのリポジトリを先にcheckoutしてFcitx5 addonと
serverをbuild・installし、`scripts/launch_fcitx5_mozkey_e2e`を
`GRIMODEX_LINUX_MOZKEY_LAUNCHER`へ渡してから上記コマンドを実行する。
fork側PRのcommitとGrimodex側のE2E基準branch/commitを明示的にpinする。

launcherはprivate XDG profileを作成し、`dbus-run-session`配下でheadless Fcitx5を起動する。
`/usr`にcanonical addon、server runtime marker、addon metadata、input-method metadataが
揃っていなければ起動前に失敗する。mock handshake writerは受け入れ44の代用にしない。
