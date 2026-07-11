# Linux IME process E2E

Linux受け入れ条件44（IME起動でconsumerがGrimodexに検出される）は、
`grimodex-db`のignored integration testで確認する。

テストは指定された実`fcitx5-grimodex-server`を一時的な
`GRIMODEX_IME_ROOT`とXDGディレクトリ群で起動し、`get_status(root, Auto)`をpollする。
`fcitx5-grimodex` consumer、Linux platform、Phase 3の能力フラグ4種、
`effective_enabled`を確認後、サーバーと一時ディレクトリを終了・削除する。

通常の`cargo test`では実行されない。実行するときは、サーバーの絶対パスを指定する。

```bash
GRIMODEX_LINUX_IME_SERVER=/absolute/path/to/fcitx5-grimodex-server \
  cargo test --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db --test linux_ime_server_e2e -- --ignored --nocapture
```

CIでforkと結合する場合は、forkを先にcheckoutして`hazkey-server` productをbuildし、
その実行ファイルを`GRIMODEX_LINUX_IME_SERVER`へ渡してから上記コマンドを実行する。
fork側PRのcommitとGrimodex側のE2E基準branch/commitを明示的にpinする。

現在のローカル開発環境にはSwift toolchainとbuild済みserver artifactが無いため、
実server指定の実行は未実施である。mock handshake writerは受け入れ44の代用にしない。
fork CIで実`hazkey-server` productのbuildが成功した後、そのartifactに対して上記コマンドを
実行する。
