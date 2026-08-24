# NIR-0 C2B material-basis impact matrix

This slice defines the Native-only, pure typed material-resolution seam for a
Human-derived child revision. It is intentionally dormant: it does not write
SQLite rows, publish a declaration head, update `current_revision_id`,
initialize V1 Edge State or Consumer Freshness, expose Electron IPC, or enable
renderer activation.

| Boundary | Current authority | C2B contract change | Proof in this slice |
| --- | --- | --- | --- |
| Effective material input | `effectiveMaterialBasis` in the validated parent Envelope | Parse source/evidence/dependency fields through typed `serde` structs with camelCase and unknown-field rejection | Rust typed deserialization tests |
| Projection-only derivation | Parent material basis | Clone all three sets; recompute quote, dependency-set, and material-basis digests; reject trusted sidecar | Pure resolver tests |
| Scope override derivation | Parent material basis plus Native resolver result | Preserve Evidence and non-scope dependencies/sources exactly; replace only ScopeResolution material from a complete trusted final set | Pure resolver tests |
| Scope source identity | `canonical_source_object_identity` | Accept only the existing supported source-kind grammar; reject unknown Registry/Order Oracle-like identities | Fail-closed identity tests |
| D1 declaration projection | Shared `DependencyDeclaration` / selector canonicalizer | Derive every declaration, including `component-contract`, from the exact resolved dependency set | Declaration parity tests |
| V1 compatibility projection | `SourceBasisRow` and `DependencyEdge` | Derive source-only expectations from `sourceBasis`; never use D1 or Envelope digests as V1 identity | V1 expectation tests |
| Parent authority parity | Persisted source rows, verified active D1, V1 edges | Require exact source rows, exact D1 producer/role/selector set, and one-token V1 edge per source with the expected owning Run | Positive and forged/missing/extra regression tests |

The typed sidecar is not `Deserialize`; only the client-shaped material basis
is deserializable. No manual `serde_json::Value` interpreter or control-flow
analysis is introduced.
