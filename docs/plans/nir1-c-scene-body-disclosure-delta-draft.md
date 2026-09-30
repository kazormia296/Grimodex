# NIR-1 C: target Scene body disclosure decision (DRAFT)

Status: **fail-closed Hold; no new contract or approval request**
Scope: Graph-added Related Scenes only. This note does not revise the confirmed Entity/Relation, Graph, history, egress, Gold, metric, or resource contracts.

## Decision

Keep a Graph-only target Scene body unavailable. A pin from a qualified Graph path locates a Scene; it does not authorize or prove disclosure of that Scene's body. Current product behavior remains fail closed and the Graph product entry remains closed. No new disclosure authority is being proposed for approval here.

## Evidence and boundary

- Confirmed `nir1.entity-relation@1` covers the approved Entity/Relation assertion family and its own Evidence. It does not bind an arbitrary pinned Scene body. The pin is locator data; Relation/path Evidence and body Source/anchor remain separate.
- `validate_scene_scope` checks an explicit target Scene binding, matching project and Scene IDs/incarnation/token, Timeline/Worldline/layer, holder/audience, and reading-before-query. Its own comment states that it does not validate project Scope authority, reveal state, or lifecycle/read-identity proof, and that full path A2/A3 is a separate C-query input. A matching `project_id` field is not proof of live project authority.
- The existing reading-query context and Scene Source reader provide the current reading context and exact saved/canonical body. The Source reader does not itself authorize an arbitrary pinned target body. No typed target-body material proof currently carries all relevant story/auto/phase/reveal/POV constraints. The typed path A3 proof cannot be copied onto the target Scene.
- Independent review confirms that existing readers do not cover the target body's story/auto/phase/reveal/POV constraints. Target-body A3, return/click currentness, and Graph result integration remain incomplete. The independent C resource review also leaves the simultaneous 2 MiB bound unproved. The debug 8 ms probe returned unavailable at 8.202 ms; the later optimized release probe returned available for one fixture at 6.622 ms. That single fixture is not integrated performance acceptance, and real G-01 retrieval remains unmeasured.
- The general first-non-empty-line rule and G-01 full-body expectation agree for this fixture. `evals/nir1-g01/fixture.v1.json` stores Mira's body as one unbroken string of 78 UTF-16 units; the candidate describes it as one paragraph; `scene_canonical_text` joins blocks with `\n`, so this one-paragraph body has no separator newline; `first_non_empty_anchor` therefore spans the entire `[0,78)` body, as G-01 expects. No exception or fixture change is needed. Preserve the Gold, metrics, and thresholds. This shape check does not establish disclosure authority or runtime acceptance.

## Why Option B cannot yet be specified

The conditional “Raw excerpt under existing authority” choice is removed. Independent review shows existing readers do not authorize a pinned target body across the required axes; the Raw Scene Source reader returns exact source text but is not disclosure authority, and `validate_scene_scope` is only an A1/reading-before helper. The existing typed A3 proof applies to the approved Entity/Relation path, not the target Scene. Therefore user confirmation of a “narrow Raw” rule would still leave the implementing actor, authoritative fields and writers, exact reader boundary, invalidation/currentness contract, and acceptance proof undefined.

A future B proposal would need to name a specific Native-owned source/writer for each target-body axis; define a closed typed binding and the reader that consumes it; prove same-project/workspace and target identity; specify mutation, deletion, restore, copy, and lifecycle invalidation; and bound concurrent memory, SQL, cancellation, and currentness checks against existing limits. This decision note does not invent those owners or fields. That work requires a separate security-sensitive precheck and explicit confirmation after the full threat model and acceptance contract are concrete.

Current acceptance consequence: existing Raw/IR results continue under their existing admission. A Graph-only pin returns no body excerpt. Preserve the fixed G-01, Gold, metrics, and limits; report G-01 and C-product as Hold while the expected Graph-added body cannot be disclosed. Focused helper coverage, the 31-case Graph suite, and a pure fusion fixture do not close the product gate.

## Existing fail-closed boundary

| Element | Current boundary retained |
| --- | --- |
| Trusted evidence | Existing reviewed Entity/Relation proof is trusted only for its own path and Evidence. Native's current workspace/database binding, canonical project Scope authority, target Scene membership/identity, and body Source do not independently grant a Graph-only body disclosure. |
| Untrusted input | Renderer/caller IDs and scope claims, model text, cached mentions, stale result digests, and a pin as any claim beyond location. Pin rows are accepted only as current locators after Native checks them. |
| Boundary | No Graph-only target body is admitted to the reader-facing Related Scenes result or navigation. Existing Raw/IR routes keep their current admission. Model send, extraction, history, export, durable disclosure records, and Graph activation are not opened. |
| Risks blocked by the current denial | Cross-project/ID reuse; stale or moved pins; Scene edit/delete/restore/copy races; future, secret, reveal-gated, or wrong-holder/audience material; missing-axis-as-`Any`; treating the path's review Scene/A3 as target-body permission; confusing Relation provenance with body provenance. |
| Defense | Return no body excerpt for a Graph-only target while target-body authority is absent. A future disclosure proposal must independently address every listed risk and receive its own precheck; this note does not define those defenses as implemented. |
| Acceptance effect | G-01's fixture shape is consistent, but its expected Graph-added body remains unavailable; G-01 and C-product stay Hold. Existing limits remain unchanged. |

## Precheck boundary

This note restates the existing fail-closed boundary and requests no new security-sensitive authority, so no approval is requested. Any future proposal that grants target-body disclosure must follow GDX-PRECHECK-001: present a complete threat model with trusted/untrusted actors, boundary, in/out-of-scope attacks, required defenses, and acceptance implications; obtain explicit user confirmation of its exact ref before implementation; and keep activation separately gated. Broad approval of the post-B plan cannot stand in for that confirmation.

## References

- `docs/plans/nir1-post-b-execution-plan.md` §§6.3–7
- `docs/plans/nir1-c-scene-connection-candidate.md` §§2–4, 7–11
- `evals/nir1-g01/fixture.v1.json` (single-line body and `[0,78)` expected range)
- `src-tauri/crates/grimodex-db/src/narrative_extraction/change_feed.rs::scene_canonical_text`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/scenes.rs::first_non_empty_anchor`
- `docs/plans/nir1-post-b-candidate.md` C-query and C-product acceptance ledger
- Independent C review finding: existing readers do not cover all target-body disclosure axes.
- `docs/plans/nir1-l6-l9-execution-plan.md` confirmed `typed-revision-material` and confirmation protocol
- `src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_graph/scenes.rs::validate_scene_scope`
- `src-tauri/crates/grimodex-db/src/narrative_extraction/retrieval_admission/query_context.rs` and `disclosure.rs`
- `policies/quality/iron-laws.md#GDX-PRECHECK-001`
