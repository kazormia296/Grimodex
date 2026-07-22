# macOS IME Phase 5 E2E

Phase 5 の必須 CI は、Grimodex の writer と実物の macOS
`ConverterServer` プロセスを同じ一時ディレクトリで接続する。
mock server や handshake fixture だけでは代用しない。

## CI で保証する範囲

- azooKey-Desktop fork の Core protocol / scope / generation tests
- Release 構成の実 `ConverterServer` build
- `GRIMODEX_IME_ROOT` を共有した writer-to-reader process E2E
- 初期 snapshot の parse/mapping と atomic project replace 後の watcher reload
- `azookey-grimodex` handshake、macOS platform、4 capabilities
- network entitlement を持たない sandboxed app/helper
- unsigned `.app` と `.pkg` の構造、bundle ID、LaunchAgent
- release workflow 上の Developer ID 署名、公証、staple、Gatekeeper 検証

consumer 側 CI は、契約テストを追加した Grimodex commit を
`GRIMODEX_CONTRACT_COMMIT` で固定して checkout する。branch 名や mutable tag は
参照しない。

## ローカルまたは CI での実行

macOS で fork の `ConverterServer` を先に build する。

```bash
swift test --package-path Core
swift build --package-path Core --configuration release --product ConverterServer
```

続いて、この repository で実プロセス E2E を実行する。

```bash
GRIMODEX_MACOS_IME_SERVER=/absolute/path/to/Core/.build/release/ConverterServer \
  cargo test \
  --manifest-path src-tauri/Cargo.toml \
  -p grimodex-db \
  --test macos_ime_server_e2e \
  -- --ignored --nocapture
```

test harness は `GRIMODEX_PROCESS_E2E=1` と一時 `GRIMODEX_IME_ROOT` を設定する。
実 server が初期 project の辞書語・Zenzai topic を読み込んだ probe を確認後、project
JSON を同一 directory 内で atomic replace し、更新後の辞書語・topic が watcher 経由で
publish されるまで待つ。併せて consumer heartbeat が Grimodex の `auto` mode を
有効化することを確認し、終了時は子プロセスと一時データを破棄する。

## hosted runner の境界

GitHub-hosted macOS runner は Core、実 server process、Xcode build、pkg を検証する。
一方、InputMethodKit の入力ソースをログイン中 GUI session に登録し、System Settings
で有効化して他アプリへ実際に打鍵する試験は interactive session を必要とするため、
hosted runner の必須 gate には含めない。

実機を利用できる場合だけ、別の interactive self-hosted macOS runner で次を追加する。

1. 公証済み pkg を install する。
2. 入力ソースを有効化する。
3. Grimodex と通常アプリで scope を確認する。
4. secure-input 欄で変換、学習、文脈取得が停止することを確認する。
5. 入力ソースを無効化し、uninstall 後に handshake を削除する。

この任意試験がないことを、hosted CI の process E2E 失敗を許容する理由にはしない。
