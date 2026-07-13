# Platform mapping

This table maps native events and text-system units to the shared semantic
contract. It is not a shared wire protocol.

| Contract meaning | Linux/Fcitx5 | macOS/InputMethodKit | Windows/TSF |
|---|---|---|---|
| phase owner | Swift `CompositionSession` | Core `InputState` + server `SegmentsManager` | currently split; server-owned rewrite is planned |
| semantic transport | Hazkey Internal Protocol v2 over Unix socket | Codable XPC request/snapshot | named-pipe gRPC, later Windows semantic DTO |
| composition cursor | input-element boundary | marked-text/Core input boundary | future server boundary converted by TSF adapter |
| rendered caret/range | UTF-8 byte offset in `fcitx::Text` | Cocoa `NSRange`/NSString UTF-16 range | TSF UTF-16 edit range |
| surrounding anchor | Fcitx character index normalized to Unicode-scalar offset | Cocoa selected/marked range | TSF ACP UTF-16 range |
| preedit | `TextFormatFlag` spans; client or panel preedit | marked-text attributes | TSF composition range/properties |
| candidate identity | `candidate_id + generation` | candidate presentation + composition epoch | missing; required in overhaul slice 2 |
| commit side effect | monotonic `effect_id` | XPC effect applied by IMK client | future idempotent TSF edit-session effect |
| secure transition | Fcitx sensitive capability replaces the session | secure text-field policy revokes the epoch | TSF secure context; pinning audit remains |
| recovery | confirmed snapshot + in-memory action journal | XPC process/session recovery | missing; required in overhaul slice 2 |

## Physical key mapping

| Meaning | Linux/Fcitx5 | macOS/InputMethodKit | Windows/TSF |
|---|---|---|---|
| start conversion | Space / Henkan | Space | Space / Convert |
| candidate next/previous | Down/Up, Space/Shift+Space | Down/Up, Space/Shift+Space | candidate action mapper |
| candidate page | PageDown/PageUp | page key/candidate UI | candidate-window command |
| resize segment | Shift+Right/Shift+Left | `editSegment(+1/-1)` | current `ShrinkText`; semantic action planned |
| partial commit | Right or Enter in selecting | `submitSelectedCandidate` | not conforming yet |
| transforms | F6-F10 and JIS mode keys | F6-F10/IME actions | TSF key mapper |
| normal space | configured width | configured width | configured width |
| shifted space | inverse width except candidate navigation | inverse width except candidate navigation | target contract |

JIS/US keycodes, Fcitx capabilities, Cocoa ranges, TSF edit sessions, and UI
objects stay in platform adapters. Shared tests compare the resulting semantic
action, snapshot meaning, and effect—not physical keycodes or serialization.
