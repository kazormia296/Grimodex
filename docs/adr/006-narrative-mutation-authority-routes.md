# ADR 006: Narrative Mutation Origin and Authority Routes

## Status

Accepted — 2026-08-14（Gate C1.5）

Amended — 2026-08-15（Gate C2, C2-T1 Transport Assembly）: added the
`attention-typed-writer` route. See "Attention Typed Writer" below.

This ADR ratifies the mutation authority boundary used by ADR 004 and ADR 005.
It does not change the existing low-level `origin` field or introduce a new
database table. The machine-readable contract is
`policies/narrative/mutation-authority-routes.json`.

Caller authorization is a positive, fail-closed allowlist. Only a route's
`allowedCallers` can grant access; absence from `forbiddenCallers` never grants
access. `forbiddenCallers` is diagnostic-only, and the two lists must be
disjoint.

## Context

The C1 Change Feed records the low-level origin of a mutation:

```text
human | ai-apply | import | undo | redo | restore | migration
```

That audit attribute is not sufficient to describe who was allowed to cross
the mutation boundary. In particular, an explicit author command such as
“create a Codex entry” and a Reconciler projection produced from an
interpretation are both observable as `ai-apply`, but have different review,
provenance, and authority requirements.

## Decision

`origin` and `authorityRoute` are separate concepts. `origin` remains an
immutable, low-level audit attribute. Every canonical C1 operation additionally
declares exactly one `MutationAuthorityRoute`:

```ts
type MutationAuthorityRoute =
  | "human-direct"
  | "interactive-agent-command"
  | "interpreter-projection"
  | "import-apply"
  | "history-replay"
  | "restore-or-migration"
  | "attention-typed-writer";
```

Unknown and unclassified routes fail closed.

### Human Direct Authoring

```text
Human UI
  → Runtime Policy / Actor Context
  → OCC / Field Authority
  → Typed Writer
  → Domain Data
```

Human Direct Authoring does not require a Proposal. It does require the typed
writer, actor context, OCC, the canonical Change Event, and Change Feed
controls.

### Interactive Agent Command

```text
User Turn / Standing knowledgeWrite Authority
  → Agent Tool Policy
  → Typed Writer
  → Domain Data
```

An Interactive Agent Command is an authoring surface, not an Interpreter. It
does not require a Proposal when the user has explicitly authorized the
command, but it always requires:

- `knowledgeWrite` capability;
- stable request identity;
- chat message, tool call, and trace provenance;
- a Typed Writer and OCC;
- Field Authority admission;
- Undo Journal lineage;
- canonical Change Event and Change Feed emission.

Background maintenance, idle schedulers, and Reconcilers may not call this
route. A chat tool executor, an explicitly registered manual wrapper, or a
registered Agent Surface may call it.

### Interpreter Projection

```text
Semantic Interpretation
  → Narrative IR / Proposal Revision
  → Decision
  → Prepared Commit
  → OCC / Field Authority
  → Typed Writer
  → Domain Projection
```

Interpretation-originated mutation may not bypass Proposal, Decision, or
Prepared Commit. A Reconciler never returns SQL, a DB operation, a Prepared
Commit command, or a Typed Writer command as its output.

### Import, History, and System Routes

`import-apply` is the explicit Import application route. AI extraction may not
write Domain Data directly through it.

`history-replay` is reserved for Undo and Redo and requires original
transaction and journal lineage. It is not semantic truth correction.

`restore-or-migration` is reserved for Restore, Migration, and Integrity Repair
operations. These may emit a Semantic Epoch Reset and request a full rebuild;
they do not pretend to be a set of ordinary row-level mutations.

`ai-apply` is intentionally ambiguous between the Interactive Agent Command
and Interpreter Projection routes. Callers must provide `authorityRoute`
explicitly; no canonical writer may infer a route from `ai-apply`.

### Attention Typed Writer

```text
Human UI (Maintenance Inbox)
  → Typed Writer
  → narrative_maintenance_attention
```

None of the six routes above fit a Maintenance Attention disposition
(`policies/narrative/maintenance-attention-contract.json`:
`storageClass: "durable-user-state"`, `epochBinding: "none"`,
`backflowPolicy: "forbid"`). Every existing route either requires OCC plus
the canonical Change Event and Change Feed controls (Human Direct,
Interactive Agent Command, Import, History Replay), the Proposal/Decision/
Prepared Commit pipeline (Interpreter Projection), or is reserved for
Restore/Migration/Integrity Repair. Attention is none of these: it is a
single upsert or delete against one durable, non-epoch-bound row, with no
OCC, no Proposal, and — by contract — no Change Feed emission at all.

`attention-typed-writer` requires only the Typed Writer control. Only a
Human UI caller (the Maintenance Inbox) may use it; Background Maintenance,
the Reconciler, and idle schedulers are forbidden callers, matching
`maintenance-attention-contract.json`'s negative fixture that Run publish,
Finding Observation writes, and epoch rotation must never mutate these rows.

## Invariants

1. `origin` and `authorityRoute` are stored and reasoned about independently.
2. Human Direct Authoring does not require a Proposal.
3. Interactive Agent Command is an explicitly authorized authoring route.
4. Standing authorization is still bounded by Agent Tool Policy and provenance.
5. Background AI, Maintenance AI, Reconciler, and idle scheduler code cannot
   use the Interactive Agent Command route.
6. Semantic Interpretation mutation always uses Proposal, Decision, and
   Prepared Commit.
7. Undo, Redo, Restore, and Migration remain independent system routes.
8. Caller authority comes only from `allowedCallers`; `forbiddenCallers` is
   diagnostic-only, and an unknown caller fails closed.
9. `allowedCallers` and `forbiddenCallers` are disjoint, and each list is
   unique where present.
10. `ai-apply` never receives an implicitly inferred authority route.
11. An unknown or unclassified route is a hard validation error.

## Consequences

The C1 Change Feed manifest is now a complete authority-route inventory. The
route controls are machine-readable and checked by
`scripts/quality/validate-semantic-core-boundary.mjs`. C1.5 does not change
the C1 `origin` vocabulary, add a dependency graph, or bump the workspace
schema (SCHEMA 22 remains unchanged).

The same typed Native Writer may be used by several routes, but the operation
manifest must classify the caller's authority route for each operation. This
keeps shared writer implementation from becoming an implicit authority grant.

## Rejected alternatives

- Treating every `ai-apply` as an Interpreter would incorrectly force explicit
  user commands through a Proposal and obscure their authoring provenance.
- Treating every Agent Writer call as an Interactive Agent Command would allow
  background code to acquire user-turn authority by importing a shared helper.
- Adding a second `origin` enum would mix audit history and authority policy and
  make C1 Change Feed consumers ambiguous.

## 追補（2026-11-23）：出来事の削除に連動する承認の撤回の読みと、承認つき・MCP の免除の control

本 ADR の本文と、Status の Amended の記録は書き換えない。次の 2 本の起案が確認されたので、本文の文の読みと、`interactive-agent-command` に足す control を、ここに記す。規則の正本は各起案である。この追補は、本文のどの文がどう読み替わるかを示すだけで、規則を足さない。route の定義（`MutationAuthorityRoute` の値）は、増やさない。

- 起案：SRD/1（[nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md](../plans/nir1-chronicle-scene-review-apply-delta-proposal-1-draft.md)。draftRef `nir1-chronicle-scene-review-apply-delta/1`、下書きの SHA-256 `bb7bfbb90ca9dece6e409fc70c73ae7a378742f31b129da371419230b5518c4b`）と、AWA/1（[nir1-agent-event-write-approval-proposal-1-draft.md](../plans/nir1-agent-event-write-approval-proposal-1-draft.md)。draftRef `nir1-agent-event-write-approval-proposal/1`、下書きの SHA-256 `1dd0fdf64700393b0b8d6a9e5c7034f14edddf7be9dcf6dc87a4f8b31a650d0e`）。
- 確認の記録：`claude/nir1-contracts` の commit `2778cf5abbbc25114b40c9ce8e1233543515ddc8` の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-22-chronicle-scene-review-apply.md`。SRD/1-1 は確認 138、SRD/1-2 は確認 139、AWA/1-1 は確認 141、AWA/1-2 は確認 142。それぞれ、その行だけに掛かる。確認 138 は、設計の記録（ADR 004・005・006、Gate B2）に例外・追補を足す文の置き場を、起案者の読みとして挙げている。

### 1. 出来事の削除に連動する承認の撤回（SRD/1 の X。SRD/1-1。確認 138）

X は、出来事を消す各操作の transaction の中で、既にある提案に決定（却下）を 1 件足す。例外の内容は、ADR 004 の同日の追補（1）のとおりである。本 ADR の文は、次のように読む（新しい route は足さない）。

- **`history-replay`（「reserved for Undo and Redo」「It is not semantic truth correction.」）。** X は、redo の delete の再実行、create の undo、まとめ操作の replay の transaction の中で、決定を 1 件足す。この書き込みは、出来事の削除に連動する却下であり、真偽の訂正でも、journal の lineage の変更でもない。
- **`restore-or-migration`（「reserved for Restore, Migration, and Integrity Repair」）と、不変条件 6・7。** X は、スナップショットの復元（`snapshot-restore`）、画面の単体削除・まとめ削除（`human-direct`）、取り込みの取り消し（`commit-undo`）の transaction の中でも、却下を書く。Domain を変更せず、既にある提案に決定を 1 件足すだけで、Prepared Commit は通らない。これは、不変条件 6（「Semantic Interpretation mutation always uses Proposal, Decision, and Prepared Commit.」）の文面に当たる（決定を書くのに、Prepared Commit を通らない）。この読みを、ここに明記する。不変条件 7（Undo、Redo、Restore、Migration は独立した system route のまま）は、保つ。
- **不変条件 8・11 は、変えない。** X と RA（承認し直し。下の 2）の書き手は、新しい route も caller も足さない。登録は、既にある route の ID と、その route の `allowedCallers` の中に置く。見込み：RA の command は、BAO/1 の command の登録（`interpreter-projection`。`allowedCallers` に `proposal-review`）の形に合わせる。X の書き込みは、出来事を消す各操作の登録の行の中の 1 段として扱い、決定の表の書き手を、1 つの関数に限る。検査（`validate-semantic-core-boundary.mjs`・`validate-native-writer-ownership.mjs`・`pnpm test:narrative:change-feed-writers`）が、新しい route・caller なしには通らないと分かったら、実装を止めて、ユーザーに伝える（`[precheck]`）。unknown が fail closed になること（不変条件 8・11）を、X・RA は避けない。
- 決定を書く書き手の登録（`change-feed-writers.json`・`protected-writers.json`）は、実装の PR で更新する（この追補では書き換えない）。

### 2. 承認し直しの入口（SRD/1 の RA。SRD/1-2。確認 139）

承認し直し（RA）は、人の review の入口を、もう 1 つ足す（型付きで、3 つの id だけを受け、内容は本体が組み立てる）。BAO/1 が既に足した入口と、同じ種類である。NIR0-CERT の「the typed C2B Human writer is the only V2 review route」との間の緊張を、ここに 1 行で記す。RA は、撤回の入口ではなく、承認し直す入口である。

### 3. 承認つきの override と MCP の免除（AWA/1。AWA/1-1 は確認 141、AWA/1-2 は確認 142）

本文の Interactive Agent Command の必須の control「Field Authority admission」（と、`policies/narrative/mutation-authority-routes.json` の `requiredControls` の `field-authority`）に、次を足す。

- **承認つきの override（AWA/1-1）。** `interactive-agent-command` の `conditionalControls`（今は空）に、条件つきの control を足す。名前は `author-field-override` とする（技術判断）。`field-authority` とは別にする。同じ名前を、同じ route の `requiredControls` と `conditionalControls` の両方に置くと、`validate-semantic-core-boundary.mjs` が「controls cannot be both required and conditional」の error にするためである。`EXPECTED_CONDITIONAL_CONTROLS`、schema、fixtures、`validate-semantic-core-boundary.test.mjs` も揃える（policy の JSON と検査は、実装の PR で変える。この追補では書き換えない）。
- **MCP の免除（AWA/1-2）。** MCP の免除は、人の持ち主の拒みを外すので、「Interactive Agent Command は Field Authority admission を常に要する」という必須の control を、そのままでは満たさない。実装の前に、次のどちらかを選び、本 ADR の文と routes JSON を、それに合わせて改める（技術判断。どちらも改めの対象で、この追補では選ばない）。(i) MCP を `interactive-agent-command` の例外にする。(ii) 承認つきと MCP の免除の両方を受ける、別の条件つき control を置く（名前は、上と同じ理由で `field-authority` と別）。
- 変えないもの：必須の controls の列と、経路の固定（renderer の `origin` を見ない）。不変条件 8・11（unknown の caller・route は fail closed）。
