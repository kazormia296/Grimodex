/**
 * Whether the chat agent may ask for approved Chronicle IR (chat IR S1-B,
 * DR-CHATIR-S1-29〜32 in
 * `docs/plans/nir1-lane-decisions/chat-ir-s1-decisions.md`).
 *
 * While this is `false` no renderer code reaches the route: the wrapper
 * (`src/lib/chatIr.ts`) has no product caller, the executor does not take the
 * IR branch, and the chat tool list and prompt are unchanged. It is one of the
 * three closures of the route; Main's and Native's gates are the others.
 * Turning it on is the S3 change, under the approval of the contract, not a
 * technical decision of S1-B.
 *
 * A product source reads the constant itself (not through a function) and
 * loads the wrapper with `await import(...)` inside the branch, so that while
 * it is `false` the bundler drops the branch and the wrapper's chunk. Tests
 * replace the constant with `vi.mock` of this module.
 */
export const CHAT_AGENT_IR_ENABLED = false as const;
