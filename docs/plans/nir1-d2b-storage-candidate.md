# NIR-1 D2b durable storage implementation record

Base: `5e62af3267103604ade3c8cf60fffb3b4efb07dc`. This record implements the
confirmed `nir1-l6-l9-contract-proposal/3#native-generation-receipt` and
`nir1-l6-l9-contract-proposal/3#history-reauthorization` rows and post-B sections
3, 4, and 9. It introduces no new actor, authority, transport, or publication.

## Precheck and concrete mapping

The Native storage writer owns immutable metadata references to existing
`chat_messages` bodies, generation attempts with at most one terminal receipt,
ordered final input references, and qualification references. Existing
`narrative_extraction_artifacts` remain their own body store. Chronicle stage
receipts retain their extraction-only contract. No body, thinking, or closure
is copied into the new reference tables. Unbound legacy messages remain
display-only; binding a human input never invents a generation receipt.

The requested schema extension is the storage of already confirmed receipt and
history fields. Generic renderer/MCP mutations are denied by the Native writer
authorizer; profile plaintext protection includes the new tables. The storage
CAS is not profile, workspace, Scope, route, or transport authorization. The
coordinator must supply its current trusted binding at the claim boundary.
Message content/role/session/identity/thinking edits and deletion permanently
invalidate the version through canonical SQL triggers. Undo or byte-identical
reinsertion cannot revive it. Only those triggers may set the protected
invalidation bit from generic message mutation; direct marker writes are denied.
The reference-count/JSON-byte read budget is only a child-reference budget;
resolved body bytes and whole-turn history resource admission remain the history
owner's responsibility and are not certified by this storage API.

## Finite owner and lifecycle matrix

| Entry/state | Owner and durable state | Stop, error, and restart result |
|---|---|---|
| Create/reentrant create | Native writer stores immutable attempt identity, final payload digest, ordered direct refs and qualification refs in one short transaction | Before commit there is no accepted attempt; after commit the attempt is recoverable. Identity collision is rejected, not rebound. |
| Pending start | Existing coordinator owns the attempt and nonauthorizing handle; no DB transaction is held while queued | Cancellation/expiry before claim prevents dispatch. A closed lifecycle does not admit new work. |
| Concurrent claim | Conditional DB update consumes the attempt once; coordinator serializes profile/caller/workspace/current tuple with this claim | Exactly one DB claim can win. It is never reset. DB CAS alone does not prove transport 0/1 or final authorization. |
| Active transport | Existing generation owner retains profile lease and workspace participant, but no DB transaction or maintenance slot | Cancellation/timeout closes admission and waits for observed transport termination under the coordinator's bounded transport timeout; a cancellation request alone is not termination evidence. |
| Terminal save | The same owner may finish on its pinned DB after new admissions close; body, immutable version, and terminal receipt commit atomically | Failed write exposes no reusable history. A conflicting terminal is rejected; an exact retry returns the durable terminal. |
| Crash/restart | Persisted unfinished attempts are recovered in bounded exact-ID batches, without any transport callback | One failed/not-attempted/null terminal with absent provider observation; the field is not proof that the provider did not execute. Old handles are never resent. |
| Retry/regenerate | New attempt and immutable message version, with new final refs and authorization | Old receipt cannot be attached to changed content. |
| Read/history | Exact attempt/version lookup and caller-supplied bounded child budget | Missing, changed body, unknown version, or truncated lookup is unavailable; this storage reader does not certify per-turn history eligibility. |

## Validation boundary

Focused storage tests cover file-backed reopen and no-resend recovery, duplicate
claims and terminal retries, rollback between body and terminal writes, body
mutation detection, immutable ordered references, two-generation parent chains,
and exclusion of unrelated candidate references. Primitive tests own terminal
matrix and digest vectors. Native integration must separately prove profile and
workspace races, recorder 0/1, lifecycle termination and transport isolation.
No Quick/Full, commit, product dispatch, or NIR-1 completion is claimed here.
