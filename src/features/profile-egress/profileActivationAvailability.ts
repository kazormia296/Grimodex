/**
 * Whether the profile activation UI and the profile egress status display
 * exist for the product (NIR-1 DA-2 ST3; DR-DA2-29 and DR-DA2-30 in
 * `docs/plans/nir1-lane-decisions/da2-decisions.md`).
 *
 * While this is `false` the renderer creates no element of the settings item,
 * the Related Scenes `profile-not-restricted` guidance or the status display,
 * requests none of their lazy chunks and makes no call of
 * `get_profile_egress_status` or `request_profile_activation` (D-1 (a), D-13
 * (a)). Turning it on is a Session C-1 / PUB-G change: the disclosure text and
 * these strings are approved together, and Native's
 * `PrePublicationEntry::ProfileActivation` is opened for the product under the
 * same approval. Native's gate is the second, independent lock: with this on
 * and the gate closed Main answers every request with `not-activated` and
 * shows no dialog (A-1).
 *
 * The mount points read the constant itself (not through a function) and mark
 * their `lazy()` pure, so that while it is `false` the bundler drops the closed
 * branches, the lazy imports and the chunks from the build: the startup JS
 * graph carries nothing of them (DR-DA2-30). Tests replace the constant with
 * `vi.mock` of this module.
 */
export const PROFILE_ACTIVATION_UI_ENABLED = false as const;
