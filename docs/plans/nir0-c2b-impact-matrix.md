# NIR-0 C2B material-basis impact matrix

This slice defines the Native-only, pure typed material-resolution seam for a
Human-derived child revision. It is intentionally dormant: it does not write
SQLite rows, publish a declaration head, update `current_revision_id`,
initialize V1 Edge State or Consumer Freshness, expose Electron IPC, or enable
renderer activation.

| Boundary | Current authority | C2B contract change | Proof in this slice |
| --- | --- | --- | --- |
| Effective material input | `effectiveMaterialBasis` in the validated parent Envelope | Parse source/evidence/dependency fields through typed `serde` structs with camelCase and unknown-field rejection; validate nested selectors through the shared typed round-trip contract, including unknown/non-canonical field rejection | Selector round-trip RED tests |
| Projection-only derivation | Parent material basis | Preserve all three sets and both parent digests exactly; reject forged digest values and client-added material fields; hash quote bytes exactly as supplied, including whitespace/newlines/Unicode | Positive, forged-digest, exact-UTF-8-quote, and typed-rejection RED tests |
| Scope override derivation | Parent material basis plus Native resolver result | Require a complete Native-only trusted final set bound to project/parent CAS/scene/document; preserve Evidence and non-scope dependencies exactly, add the supported resolved Source, replace only ScopeResolution material, and recompute the dependent digest | Missing-sidecar, projection-sidecar, and scope-override RED tests |
| Scope source identity | `canonical_source_object_identity` | Accept only the existing supported source-kind grammar; reject unknown `scope-registry` and `order-oracle` source kinds | Fail-closed identity RED test |
| D1 declaration projection | Shared `DependencyDeclaration` / selector canonicalizer | Derive every child declaration, including `direct-evidence` and `component-contract`, from the resolved dependency set; parent parity must hold a verified `ActiveDependencyDeclarationSet`, while child projection authority remains separate | Declaration and child-authority RED tests |
| V1 compatibility projection | `SourceBasisRow` and `DependencyEdge` | Derive typed source-only expectations from `sourceBasis` as one-token arrays; compare persisted `read_set_json` through typed `Vec<String>` parsing with exact project/Consumer/owning-Run/current-transaction authority; never use D1 or Envelope digests as V1 identity | Object-shaped, multi-token, owner, foreign-source-row, and generated-transaction RED tests |
| Parent authority parity | Persisted `SourceBasisRow`s, verified active D1, V1 edges, and the parent CAS | Bind one typed parent bundle to `HumanMaterialResolutionContext`: exact project, `proposal-revision` Consumer, parent revision key, expected owning Run, envelope digest, source rows, verified active D1 head/set, and one-token V1 edge per source with the expected owning Run | Current-parent positive plus wrong project/Consumer/run/source-row/head-state and synchronized parent/edge-run RED tests |

The typed Native sidecar is not `Deserialize`; only the client-shaped material
basis and the existing `CreateHumanDerivedRevisionRequest` are deserializable.
No manual `serde_json::Value` interpreter or control-flow analysis is
introduced. The resolver/D1/V1 symbols are intentionally future API imports:
this commit is compile-RED and adds no production module, persistence, or
activation.
