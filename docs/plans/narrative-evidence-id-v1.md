# Narrative evidence ID citation — implementation contract

Status: implementation and deterministic regression coverage recorded below; final
validation evidence is tracked in the candidate ledger. No NIR certification or
live-model quality claim.

## Confirmed scope

The user confirmed this design and its security/data-sharing conditions with
`OKです` on 2026-09-05, following the citation-mode precheck in this task.
Threat-model reference: `citation-id-v1/2026-09-05-confirmed`.

LLMs select short, request-bound evidence IDs. Code constructs exact quotes and
document-global UTF-16 ranges from a sealed snapshot catalog. Existing Native
Evidence integrity, Freshness and Apply authorities remain unchanged. This is
not a semantic-scoring fix or a new NIR certification.

Trusted components are the sealed snapshot builder, code-owned catalog builder,
deterministic resolver and existing Native validation/writers. Manuscript
instructions, model output, mutable caller objects and replay input are
untrusted. Fabricated IDs, mixed request/snapshot identities, repeated-text
confusion, unseen-range citations and incorrect observation merging are in
scope. OS or executable compromise is out of scope. A valid citation does not
prove the model's interpretation is correct.

Mandatory defenses:

- Build the versioned catalog after sealing the snapshot and before planning
  reading windows. Bind identity to snapshot artifact, document and occurrence
  range, never quote text alone.
- Preserve the existing 6,000/240 reading-window policy. Reference spans are not
  semantic units: multiple spans may support one observation and one span may
  support multiple observations.
- Distinguish canonical occurrence references from request-local display IDs.
  Capture request identity and mappings before dispatch. Do not interpret a
  response with another request's catalog or aliases.
  Persist the complete alias map, mode and catalog/version/snapshot/window
  identities with the audited request; a short alias prefix alone is not an
  authority or an adequate replay receipt.
- Validate the catalog against the sealed snapshot, retain its segmentation
  version and digest, and persist its exact representation for resume/replay.
  Do not regenerate an old response's catalog with a newer segmentation policy.
- Only fully visible spans are selectable. Partial context remains visible but
  is not silently promoted into a complete quotation. Check full-catalog
  coverage over all windows separately from binding each individual request.
  A coverage hole is an explicit precheck failure, not a successful empty run.
  Fully visible context spans are selectable: ownedRanges assign work but do
  not forbid using context as evidence.
- Respect the existing 4,096-unit quote limit and Unicode boundaries. No fuzzy
  relocation, model offsets, invented digest, or disconnected quote concatenation.
- Reject empty, duplicate, unknown or foreign references without retaining a
  partially supported observation. Repair is bound to the same selected input
  catalog and cannot fall back to model-written quotes.
- Preserve complete claim content during deduplication. Only identical claims
  with identical occurrence evidence may merge; predicates, roles, actuality
  and assertion frames are not interchangeable.

## Boundary design and compatibility

Each catalog occurrence owns an exact-range Source View with a distinct internal
reference. This retains occurrence identity through existing internal
`RawEvidenceReference` and anchor lookup shapes without accepting model ranges.
The new model response carries `evidenceRefs`; code materializes internal
`{sourceRef, quote}` references and verifies the catalog-owned range through the
deterministic resolver. The final anchor retains all existing exact quote,
range, projection and digest fields.

The sealed `source.snapshot@1` payload can carry an additive, explicitly
versioned catalog companion. Existing Native validation verifies Source View
uniqueness, source text/ranges and digests, and the full inline payload digest.
It remains the authority; the new companion does not grant Apply permission.
Relevant existing checks are in `scope_authority_runtime.rs` and `repository.rs`.
Native does not validate the new catalog/alias schema or its completeness. The
catalog is a non-authoritative model-selection companion, revalidated by the
versioned TS implementation against the sealed snapshot before use. Its own
self-consistent digest alone is insufficient validation.

Historical quote-format Fixtures, Gold and replay identities remain intact.
Legacy mode is explicit at compatibility boundaries. New ID mode never accepts
quote-format output as an automatic fallback. Resume must use its saved mode
and catalog or fail closed, never silently upgrade a historical run.

## Impact matrix

| ID | Flow | Producer / boundary / consumer | Compatibility and invariant | Verification | Status |
| --- | --- | --- | --- | --- | --- |
| C1 | Catalog construction | sealed snapshot → span catalog → exact Source Views | occurrence identity and parent structure, immutable before async use | repetition, Unicode, range/digest tampering, quote limits | implemented; regression added |
| C2 | Window binding | existing planner → visibility coverage → request alias map | original reading text/ranges unchanged; no unseen citation or silent coverage gap | overlap, partial context, full-corpus coverage vs per-window subset | implemented; regression added |
| C3 | Production observation | coordinator → task prompt/parser → code-owned evidence | ID-only v2, full claim retained, request-bound aliases | correct/invalid fixed response through canonical task | implemented; regression added |
| C4 | Repair/error | original request → repair child → same bound validator | no alias rebinding, quote fallback or partial evidence salvage | malformed JSON, invalid IDs, repair child provenance | implemented; regression added |
| C5 | Resume and audit | sealed generic payload / stage request → persisted companion → resume | old version explicit; no live-source regeneration; request/catalog provenance | serialization, stale/missing companion, cold resume | implemented; regression added |
| C6 | Merge and downstream | occurrence references → claim-aware merge → synthesis/match/proposals | distinct claims and repeated occurrences survive; true duplicates merge | same evidence/different predicate, same claim/duplicate | implemented; regression added |
| C7 | Evaluation | explicit versioned ID mode → production adapter → unchanged semantic scorer | historical v1 fixture/Gold bytes preserved; no semantic pass inferred | fixed ID 015 path, repeated-text anchors, v1 regression | implemented; regression added |
| C8 | Existing Native/IPC | inline payload → existing Native Source View/seal validation → typed writer | no new command, DB schema or authority | relevant existing contracts plus additive payload evidence | implemented; regression added |
| C9 | Deterministic non-LLM extraction | existing regex producer → existing internal evidence | no new model dispatch or mandatory ID mode | existing coordinator regressions | implemented; regression added |
| C10 | Other AI surfaces / Web citations | unrelated routes | no feature or provider routing changes | diff/symbol audit | out of scope: Chronicle citation mode only |

## Roles and evidence

- Integrator: root; orchestration, integration checks and analysis.
- Implementers: original catalog/runtime authors, resumed by
  `citation_catalog_resume_v2`, `citation_runtime_resume_v2` and
  `citation_eval_resume_v2`;
  requested GPT-5.6 Luna / max / Fast-equivalent. Effective Fast is not exposed
  by the collaboration tool and must not be reported as verified.
- Acceptance: `citation_independent_review`, candidate-untouched and separate
  from the authors. Lane reviews do not stand in for final candidate gates.
- External analysis: Claude CLI, requested `claude-fable-5-1`, effort `high`,
  Fast off/standard. Record effective settings where the CLI exposes them;
  no silent substitution.
- Approved external packet categories: design summary, relevant code diff,
  synthetic Fixtures and credential-free test results. Exclude API credentials,
  unrelated repository content, provider activity logs and private manuscripts.

Candidate ledger and validation logs live under
`.artifacts/narrative-eval/citation-id-v1-20260905/`.
Baseline HEAD: `a60adf786eee2c0a689e212ab852323f2961b64b`.
Baseline tree: `1fa9984a85551010a75a3a44a34d088f9d9116e9`.
Local comparison base: `484575e8c1f8bffe94d46f62506ec52f07e8e1d4`
(`origin/master`, not a new remote-state claim).
Unrelated `.tmp-c2-5b-edit/` and `target/` are preserved.

Focused baseline and red-first tests precede the implementation. Final checks
include focused regressions, quality consistency, selected Light suites and
Quick with same-ref verification. No billed live-model comparison is part of
this deterministic implementation slice. Heavy or unavailable gates remain
explicitly deferred/blocked; no merge/Full acceptance is claimed.

The earlier Electron-Journey waiver applied to fixture-only changes. This
production change is assessed on its actual impacted boundaries; a blanket
runtime-performance or unrelated Journey requirement is not inferred.

## Verification boundaries

The deterministic suite includes a fixed case-015 ID response, repeated-text
occurrences, distinct claims on one occurrence, multi-ID observations, invalid
reference rejection, shared parser/diagnostic behavior and parent/repair audit
identity. The coordinator tests exercise TS scheduling and cold hydration after
clearing in-memory indexes using mocked Native and AI boundaries; they do not
prove recovery from a real process crash or Native/Apply acceptance. The Native
test-only additions independently exercise generic companion/ref/seal
compatibility without adding Native catalog-schema authority.

Live-report failure handling retains explicit terminal failures and bounded
credential-free diagnostics; a rejected observation never becomes an accepted
empty batch. Actual paid model comparison remains deferred. Exact quotes still
provide evidence location, not a verdict on predicate meaning. Historical raw
fixtures and Gold are unchanged, and the semantic scorer's known limitations
are not relaxed or claimed to be solved by this citation change.
