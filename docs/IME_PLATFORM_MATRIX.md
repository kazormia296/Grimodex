# IME Composition Behavior platform matrix

The shared semantic contract is `ime-contract/composition-behavior-v1`.
Dictionary/Zenzai publication remains the separate `ime-contract/protocol-v1`
contract. Platform transports are intentionally private.

| Capability | Linux/Fcitx5 | macOS/InputMethodKit | Windows/TSF |
|---|---|---|---|
| shared fixture lock | all 9 scenarios, SHA-256 verified | all 9 scenarios bundled in CoreTests, SHA-256 verified | all 9 scenarios, SHA-256 verified by `cargo test -p shared` |
| composing cursor | conforming; input-element editor + UTF-8 renderer tests | native `InputState`; Cocoa range adapter exception | gap: server cursor/UTF-16 adapter planned |
| segment editing | conforming; Shift+Left/Right and regenerated candidates | native transition/reference tests | gap: procedural `ShrinkText` |
| partial commit | conforming; effect + remaining composition + one learning update | native `SegmentsManager`/XPC evidence | gap: split ownership |
| stale candidate | generation + revision rejection tested | composition epoch/generation tests; audit mapping | gap: generation/revision planned in slice 2 |
| no-input-loss recovery | checkpoint, journal, retry, effect ledger, process E2E | native XPC/session recovery evidence | gap: request IDs/checkpoint replay planned |
| secure input | context, Zenzai, learning, and persistence disabled | secure scope/generation tests | partial: flag exists; epoch pinning remains |
| selected-text reconversion | conforming; surrounding range deletion is an idempotent effect | gap: selected-text AI transform exists, Japanese reconversion adapter does not | gap: planned with server-owned composition |
| user dictionary/P1 | persistent CRUD/import/export + settings UI | existing Core dictionary implementation | separate overhaul scope |
| native UI/manual gate | GTK/Qt/Electron/terminal matrix is recorded in `docs/linux-release-evidence.md` in the Linux hazkey repository | interactive IMK activation remains machine-only | x64/x86 TSF gate belongs to Windows EPIC |

## Scenario status

| Scenario | Linux | macOS | Windows |
|---|---|---|---|
| composing-basic | conforming | reference + action audit | partial |
| cursor-editing | conforming | reference with Cocoa-range exception | gap |
| escape-backspace | conforming | reference + action audit | partial |
| partial-commit | conforming | reference/XPC evidence | gap |
| secure-input | conforming | secure generation evidence | partial |
| segment-editing | conforming | native transition evidence | gap |
| server-failure | conforming in transport/fault tests | platform process evidence | gap |
| stale-candidate | conforming | generation audit | gap |
| unicode-caret | conforming | Cocoa-range exception | gap |

Windows's detailed reasons and target slices live in
`azooKey-Windows/tests/composition-behavior-v1/gap-matrix.json`. These statuses
make differences visible; macOS/Windows follow-up work does not block the Linux
release gate.
