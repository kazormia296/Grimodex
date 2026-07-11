# Cross-Boundary Impact Matrix

このファイル自体は編集せず、計画または PR 本文へ必要な行をコピーして使う。実装前に一行ずつ根拠を確認し、推測は `unknown` と記録する。

## Template

| ID  | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status  |
| --- | -------------- | ---------------- | ----------------------------------------- | --------------- | ------------------- | ------------------------ | ------------ | ------- |
| P1  |                |                  |                                           |                 |                     |                          |              | unknown |

一つの entry point でも実行形態、route、fallback、retry、cancel、永続化形式、wire form が変わる場合は行を分ける。

## Inventory checklist

- 通常操作、streaming、background、Agent、CLI、MCP、migration
- retry、resume、cancel、error recovery
- producer、正本の型／schema、所有レイヤー、consumer
- serialization、validation、allowlist、error envelope
- provider、model、API variant、endpoint、override、fallback が関係する経路
- `null`、未指定、空文字列、旧永続形式の意味
- async 処理中の設定変更と snapshot 境界
- focused test、contract test、serialization test、representative end-to-end path

## Status values

- `unknown`
- `planned`
- `implemented`
- `verified unchanged`
- `out of scope: <reason>`

対象経路の `unknown` を残したまま広範な編集へ進まない。最終監査では全行を `implemented`、`verified unchanged`、`out of scope: <reason>` のいずれかにする。
