# Grimodex Composition Behavior Contract v1

This contract defines the OS-independent meaning of IME composition. It is
separate from the existing `protocol-v1` dictionary export contract and from
each platform's private wire transport (for example, Hazkey Internal Protocol
v2). It does not prescribe protobuf, XPC, named-pipe, or UI implementations.

Implementations consume the same semantic action scenarios and compare phase,
preedit spans, caret unit, candidate generation, effects, revision, and
learning decisions. Every scenario is a complete executable trace with one
status and snapshot per action plus exact final learning totals. OS-specific
key and text-system behavior is documented in `platform-mapping.md` and
`platform-exceptions.md`.

Each OS pins a copied fixture set by SHA-256 rather than reading an adjacent
checkout at test time.

Contract version: `composition-behavior-v1`.
