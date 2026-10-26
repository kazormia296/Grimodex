/**
 * Whether the NIR-1 local generation UI (DD-1c) exists for the product: the
 * generation screen in the chat panel, the conversations of the route, the
 * disclosure placements 1 to 3 and 5 (K5/3 "開示") and the AI usage policy's
 * hide／disable of the route.
 *
 * While this is `false` the renderer creates no element of them, requests none
 * of their lazy chunks and makes no call of the six `nir1_local_*` commands
 * (DR-DD1C-1, DR-DD1C-2 in
 * `docs/plans/nir1-lane-decisions/dd1c-decisions.md`). Turning it on is the
 * PUB-L change (Session C-2): the disclosure wording is approved with it, and
 * Main's and Native's gates (DD-1a／DD-1b) are opened under the same approval.
 *
 * The mount points read the constant itself (not through a function) and mark
 * their `lazy()` pure, so that while it is `false` the bundler drops the closed
 * branches and the lazy imports. Tests replace the constant with `vi.mock` of
 * this module.
 */
export const NIR1_LOCAL_GENERATION_UI_ENABLED = false as const;
