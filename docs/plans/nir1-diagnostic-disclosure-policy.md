# NIR-1 reader-history disclosure policy — diagnostic only

Policy: `nir1.scene-body-reader-history/1`.

The user explicitly approved adoption on 2026-09-08, by replying 「承認します」
to the confirmation of the four conditions below. This adopts the previously
proposed `nir1.scene-body-reader-history/1-draft` for read-only diagnostics only.
It does not approve a product search policy or runtime activation. The completed
membership proof and nonsecret Adapter fixture remain completed and unchanged.

## Approved boundary

1. **All scene-body material.** In one read-only SQLite snapshot, bind every
   verified material occurrence to the same project's live scene/order authority.
   Every source scene must strictly precede the distinct query scene S2 in reading
   order. Include unselected spans and context segments, not only selected Evidence.
   Preserve historical source identity, ranges and content digests. Live authority
   establishes identity/order; this policy supplies reader-disclosure permission.
2. **Reading query.** The effective resolver axis must be reading. Existing
   resolver fallback from auto to reading is allowed. A resolved story axis is
   unsupported; the diagnostic cannot reinterpret it as reading.
3. **Independent candidate decision.** Preserve the original Scope V2 and its
   digest, and keep S2 as the query. The historical-reference purpose verifies that
   exact(S1) identifies the assertion's validated Evidence source, with S1 before
   S2. It does not claim that the assertion holds at S2. Check the current immutable
   revision, its explicit approval and nonsecret disclosure separately from material
   permission. Unresolved constraints cannot be rescued by admissible materials.
4. **Explicit static classification.** Only the exact reviewed component contracts
   below are classified as static instructions without story-specific information.
   Check contents, version and digest together. A matching digest with no reviewed
   classification, an unknown version, or a name containing “static” is insufficient.

The initial supported candidate profile retains exact scene Scope. Audience may
be any or the explicit reader identity. Other identity axes require any when the
diagnostic has no authoritative matching identity. Unresolved constraints fail;
constrained axes without a supported evaluation remain unsupported, never any.
The diagnostic is not a general Scope V2 or ADR-002 resolver. `allowSecrets=false`.

## Static component classification

The full instruction and output-shape bytes were read in
`src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/contracts.json`.
Both are generic instructions/schema examples. Neither contains a scene's source
text, a project identity, or a story-specific claim. Placeholder values and enum
labels describe the output contract; dynamic context rows remain subject to the
complete material recipe. Classification does not exempt model output or Evidence.

| Stage                           | Contract and version                            | Reviewed content                                                                                       | Component contract digest                                                 |
| ------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `narrative_observation_extract` | `chronicle.observation-extraction.prompt` / `5` | Generic observation, citation-ID, modality and attribution instructions; placeholder JSON output shape | `sha256:c41c79347c0e96851e06e14de2c05d1519d1ad0e2a4f2e5ae886e94eb28e1c22` |
| `narrative_event_synthesize`    | `chronicle.event-synthesis.prompt` / `2`        | Generic cluster/observation reference rules; placeholder event-hypothesis output shape                 | `sha256:5e63b1a1c4c3a3aba76689732e3876deae5ea230f15d961d74932e16b3b876ff` |

A changed contract requires new content review and classification. No unknown
contract is disclosure-exempt. The existing TS/Native replay parity check remains
the source for byte parity, not a substitute for this content review.

## Actors and defenses

Trusted: the local backend/project binding, existing Native validation, the
verified immutable extraction provenance, and same-project live scope/order
authority read within one SQLite transaction. Renderer arguments, prose, model
outputs, caches and unverified identifiers remain untrusted inputs.

In scope: wrong-project references, missing or mismatched provenance/identities,
future or same-scene material disclosure, candidate constraints and missing
approval being bypassed by material permission, and unclassified static inputs.
Mandatory defenses are complete verified membership, exact project/source/query
binding, strict order for every material, explicit static classification, and
independent current-revision/approval/Scope checks. Unknowns do not admit.

Compromise of the OS/backend or an administrator resealing all database authority
is outside this diagnostic threat model. This does not weaken the existing
validators. Material changes to this boundary require explicit reconfirmation.

## Acceptance meaning and exclusions

Success means **historical-reference disclosure under this approved diagnostic
policy**, for the supported interpretation-root, citation-ID, one-window,
identity-merge, no-repair recipe. The two existing nonsecret Adapter revisions are
the positive fixtures. A diagnostic input transform before initial persistence
does not make the unchanged normal planner an E2E positive.

No canonical Freshness, eligibility-source writer coverage, index readiness,
search eligibility, runtime activation, new persistence, or independent product
acceptance is authorized or established. Human-derived child inheritance, Repair,
multiple windows and broader candidate constraint support remain separate scope.
The original no-policy precheck continues to report `admission: not-evaluated`.

For policy tests, distinguish read-only probes against real cold fixtures from
pure evaluator cases and negative-only modified copies. Never modify or reseal
the positive fixture to turn a negative into a positive.
