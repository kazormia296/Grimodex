# Platform exceptions

An exception must name the platform/API, reason, observable replacement,
affected scenario, and removal condition. A scenario may not be skipped or
deleted to hide a difference.

| Platform/API | Reason | Observable replacement | Scenarios | Removal condition |
|---|---|---|---|---|
| Linux/Fcitx5 client without `Preedit` capability | frontend cannot render client preedit | identical spans are rendered through input-panel preedit | all rendering scenarios | retain while the minimum supported Fcitx permits capability absence |
| macOS/InputMethodKit | Cocoa exposes marked-text ranges rather than a UTF-8 byte caret | Core adapter validates semantic boundaries; native range tests validate Cocoa units | `cursor-editing`, `unicode-caret` | no removal; this is a permanent adapter-unit difference |
| macOS hosted CI | no logged-in interactive input-source lifecycle | Core/XPC/process tests are required; GUI typing is a machine-test gate | lifecycle/manual matrix | interactive macOS runner becomes available |
| macOS/InputMethodKit selected-text reconversion | the current native controller has selected-text AI transforms but no Japanese reconversion action equivalent to Linux `reconvert` | the action is explicitly recorded as a macOS gap and is not counted as conforming by the contract audit | `reconvert` (not currently used by the nine P0 traces) | a native selected-range reconversion adapter and replacement-range tests pass |
| Windows/TSF current architecture | preview, suffix, and candidate state are split between Rust client and server | every scenario is SHA-pinned with an explicit `partial`/`gap` entry and migration slice | all nine v1 scenarios | server-owned CompositionSession and TSF semantic adapter are complete |
| Windows/TSF range API | TSF ACP ranges use UTF-16 and COM edit sessions can re-enter | future adapter converts only at the edit-session boundary | `cursor-editing`, `unicode-caret`, recovery | overhaul slice 4 and x64/x86 reentrancy tests pass |

Any unlisted user-visible difference is a bug or requires a new contract
version and migration period.
