# State machine

The domain owner is one `CompositionSession` per input context. The client
does not infer the phase from candidate-panel focus.

| Phase | Meaning | Main transitions |
|---|---|---|
| `idle` | no uncommitted composition | `insert_text` -> `composing` |
| `composing` | editable reading/input elements | conversion -> `previewing`; cancel -> `idle` |
| `previewing` | first conversion result is displayed | candidate navigation -> `selecting`; Escape -> `composing` |
| `selecting` | candidate or segment is focused | commit/cancel/resize |
| `reconverting` | selected surrounding text is being converted | conversion/commit/cancel |
| `unicode_input` | optional code-point input mode | commit/cancel |

The composition cursor is an input-element boundary. Display caret values are
UTF-8 byte offsets. A candidate is valid only with the generation that created
it. A partial commit removes exactly the selected candidate's consuming prefix;
the already committed prefix is never restored by Escape.

Every mutating action advances `revision`. A request with an old
`expected_revision` changes no state. Repeating a `request_id` returns the
cached result. Effects have monotonic `effect_id` values and are applied once.

Secure input immediately removes surrounding context, Zenzai, learning, and
recovery persistence. Separate input contexts never share composition,
candidates, request caches, or effects.
