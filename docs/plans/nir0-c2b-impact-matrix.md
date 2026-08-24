# NIR-0 C2B material-basis impact matrix

This slice defines the Native-only, pure typed material-resolution seam for a
Human-derived child revision. It is intentionally dormant: it does not write
SQLite rows, publish a declaration head, update `current_revision_id`,
initialize V1 Edge State or Consumer Freshness, expose Electron IPC, or enable
renderer activation.

| Boundary | Current authority | C2B contract change | Proof in this slice |
| --- | --- | --- | --- |
| Effective material input | `effectiveMaterialBasis` in the validated parent Envelope | Parse source/evidence/dependency fields through typed `serde` structs with camelCase and unknown-field rejection | Rust typed deserialization tests |
| Projection-only derivation | Parent material basis | Preserve all three sets and both parent digests exactly; reject forged digest values and client-added material fields | Positive, forged-digest, and typed-rejection RED tests |
| Scope override derivation | Parent material basis plus Native resolver result | Preserve Evidence and non-scope dependencies/sources exactly; replace only ScopeResolution material and recompute the dependent digest | Scope-override RED test |
| Scope source identity | `canonical_source_object_identity` | Accept only the existing supported source-kind grammar; reject unknown `scope-registry` and `order-oracle` source kinds | Fail-closed identity RED test |
| D1 declaration projection | Shared `DependencyDeclaration` / selector canonicalizer | Derive every declaration, including `direct-evidence` and `component-contract`, from the exact resolved dependency set; enforce parent producer generation | Declaration and missing/wrong-generation parity RED tests |
| V1 compatibility projection | `SourceBasisRow` and `DependencyEdge` | Derive source-only expectations from `sourceBasis` as one-token arrays; never use D1 or Envelope digests as V1 identity | Object-shaped, multi-token, and owner-drift RED tests |
| Parent authority parity | Persisted source rows, verified active D1, V1 edges | Require exact source rows, exact D1 producer/role/selector set, and one-token V1 edge per source with the expected owning Run | Positive and forged/missing/extra regression RED tests |

The typed Native sidecar is not `Deserialize`; only the client-shaped material
basis and the existing `CreateHumanDerivedRevisionRequest` are deserializable.
No manual `serde_json::Value` interpreter or control-flow analysis is
introduced. The resolver/D1/V1 symbols are intentionally future API imports:
this commit is compile-RED and adds no production module, persistence, or
activation.
