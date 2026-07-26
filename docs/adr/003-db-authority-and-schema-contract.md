# ADR 003: DB authority と schema contract

## Status

Accepted — 2026-07-12

## Context

Grimodex には、物理 SQLite schema、Drizzle の renderer projection、browser mock の
テスト DDL、seed SQL、設計書が存在する。これらを同じ「正本」と扱うと、列・既定値・
FK・trigger のドリフトを見逃しやすい。実際に、Drizzle の version 列の遅れ、browser
mock の legacy column、AI policy の既定値差分が発生していた。

tracked write の実装整理と同様に、責務ごとに一方向の authority を定める必要がある。

## Decision

責務ごとの authority を次のように固定する。

| 責務 | authority |
| --- | --- |
| table / column / FK / CHECK / trigger / index | `grimodex-db` の migration |
| 複数表をまたぐ tracked write | typed native write |
| renderer が利用する table 型 | Drizzle。物理 schema の検証済み projection |
| browser test 用 DDL | 物理 schemaの明示 subset。将来 generator へ移行 |
| seed SQL | fixture。migration への収束を parity test で検証 |
| DB 設計書 | schema contract から生成または説明する資料 |

migration は runtime の物理 schema を作る唯一の実行 authority とする。設計書や
Drizzle から migration を自動生成しない。FTS5、複雑な CHECK、trigger、table rebuild、
既存データの移行意味を Drizzle だけでは表現できないためである。

## Schema contract

`src-tauri/crates/grimodex-db/src/schema_contract.rs` は fresh migration 済み DB を
読み取り、次を安定した JSON へ変換する。

- `PRAGMA user_version`
- table / virtual table と column の型、nullability、default、PK 順序
- FK の参照先と delete / update action
- 明示 index の列、unique、partial 条件
- trigger の正規化済み SQL

生成物は `src/db/generated/schema-contract.json` であり、次のコマンドで更新する。

```text
pnpm generate:db-contract
git diff --exit-code
```

生成物を変更する場合は、migration、Drizzle、browser mock のいずれかの変更理由を
同じ変更に含める。生成 JSON を直接編集しない。

## Projection rules

Drizzle parity test は、Drizzle の全 table / column が contract に存在し、型と nullability
が互換であることを検査する。Rust native-only table と、SQLite の TEXT primary key が
`PRAGMA table_info` 上で nullable に見える差分だけを名前付き allowlist で管理する。

browser mock は production schema の subset である。mock に存在する table / column は
contract に存在し、型、nullability、PK を一致させる。subset の table 一覧はテスト内の
明示 allowlistで固定し、Rust 専用の FTS / chunk / undo table を暗黙に追加しない。

seed parity は schema contract の同じ introspection を再利用し、既存の seed subset、
trigger、migration convergence gate を維持する。

## Consequences

この ADR では raw `db_execute` や手書き browser DDL を直ちに廃止しない。まず authority
と parity gate を固定し、次の段階で browser subset の生成化、tracked write の typed
command 化、versioned migration runner を導入する。これにより runtime の write 挙動を
変えずに、以後の drift を CI で検出できる。
