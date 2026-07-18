# Grimodex Scan / hosted Editor Cloudflare deployment

Grimodex Scan and the hosted Editor are deployed as three independently
reversible targets. Scan and Editor must never share a Pages project or build
output.

| Target                         | Staging                 | Production                 | Canonical origin                                                        |
| ------------------------------ | ----------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Scan API, Workflow, D1, R2, AI | `grimodex-scan-staging` | `grimodex-scan-production` | Worker route                                                            |
| Scan Pages                     | `grimodex-scan-staging` | `grimodex-scan`            | `https://grimodex-scan-staging.pages.dev` / `https://scan.grimodex.app` |
| Editor Pages                   | `grimodex-try-staging`  | `grimodex-try`             | `https://grimodex-try-staging.pages.dev` / `https://try.grimodex.app`   |

The Worker CORS allowlist is an exact, ordered, comma-separated pair. Wildcards,
extra preview origins, duplicates, and reversed order fail deployment
validation:

```text
# staging
https://grimodex-scan-staging.pages.dev,https://grimodex-try-staging.pages.dev

# production
https://scan.grimodex.app,https://try.grimodex.app
```

Production is always prepared from a paused Worker. Do not enable
`SCAN_ACCEPTING_NEW_JOBS` until staging migration, health, CORS, upload, and AI
smoke checks have passed.

The deployment CLI deliberately refuses `SCAN_ACCEPTING_NEW_JOBS=true` in
staging. Use a separate reviewed activation workflow if staging traffic is
needed later.

## Local pre-deploy verification

Run the complete production-built web app and Worker stack locally before
creating or changing any Cloudflare resource:

```bash
pnpm scan:local
```

The command builds and stamps the PWA, applies all D1 migrations to a local
database, then starts the following fixed origins:

- web/PWA preview: `http://127.0.0.1:4173`
- Worker API: `http://127.0.0.1:8787`

Open the web URL and upload a disposable `.txt` or `.md` file. Quick Scan runs
through locally simulated D1, R2, Rate Limiting, and Workflow bindings. The
local configuration disables Turnstile and every hosted AI path, so extraction
uses the deterministic fallback and does not require a Cloudflare account,
credentials, deployment, or billable inference. Stop both processes with
`Ctrl+C`. Local state is preserved under `.wrangler/scan-local` for the next
manual run.

For a fresh, non-interactive preflight, run:

```bash
pnpm scan:local:smoke
```

This uses temporary state, reapplies every migration, starts both origins,
uploads a disposable Japanese fixture, waits for the local Workflow to finish,
validates the `grimodex-scan/1` report, deletes the scan, and exits. It covers
the credentials-free Quick Scan path; Turnstile, Full Scan, Workers AI, and
external AI providers still require a separate staging check.

The hosted Editor is the root Grimodex application, not the Scan web bundle.
Run it independently with:

```bash
pnpm dev
```

Then open `http://localhost:1430/editor`. The local Scan handoff and standalone
Editor entry point both use that same Editor implementation. The local Scan
build points its CTA at this URL, the development Editor defaults its handoff
API to `http://127.0.0.1:8787`, and the local Worker allowlist includes both
the Scan preview and Editor origins. Start `pnpm dev` before consuming a local
one-time Editor token.

## One-time account bootstrap

Authenticate and create isolated staging resources first:

```bash
pnpm exec wrangler login
pnpm exec wrangler pages project create grimodex-scan-staging \
  --production-branch master
pnpm exec wrangler pages project create grimodex-try-staging \
  --production-branch master
pnpm exec wrangler d1 create grimodex-scan-staging
pnpm exec wrangler r2 bucket create grimodex-scan-staging
```

Copy the D1 UUID into `apps/scan-web/wrangler.staging.jsonc`. R2 must be
enabled once in the Cloudflare Dashboard before Wrangler can create a bucket.
The account also needs a `workers.dev` subdomain before the first Worker can be
published; complete the one-time Workers & Pages onboarding if Wrangler asks.

Apply staging-only retention guardrails after creating the bucket:

```bash
pnpm exec wrangler r2 bucket lifecycle add grimodex-scan-staging \
  staging-incoming-expiry incoming/ --expire-days 2 --force
pnpm exec wrangler r2 bucket lifecycle add grimodex-scan-staging \
  staging-artifacts-expiry artifacts/ --expire-days 8 --force
pnpm exec wrangler r2 bucket lifecycle add grimodex-scan-staging \
  staging-public-expiry public/ --expire-days 8 --force
pnpm exec wrangler r2 bucket lifecycle list grimodex-scan-staging
```

These rules irreversibly delete staging objects after the stated retention
period. They are defense in depth for the Worker's hourly retention job, not
production retention policy.

Set secrets interactively; never put their values in a Wrangler config or a
`VITE_` variable:

```bash
pnpm exec wrangler secret put UPLOAD_TOKEN_SECRET \
  --config apps/scan-web/wrangler.staging.jsonc
```

Production additionally requires `TURNSTILE_SECRET_KEY`,
`SCAN_FULL_ACCESS_SECRET`, and the configured upstream AI credential. The
current provider adapter sends `AI_GATEWAY_TOKEN` as the upstream
`Authorization` bearer token. Authenticated AI Gateway needs separate
`cf-aig-authorization` support before it is enabled.

Disable AI Gateway payload logging before any manuscript is submitted.

## Cost guardrails

Cloudflare does not provide a hard dollar cap for usage-based R2 or Workers
charges. Configure an account-wide Budget Alert under **Manage Account >
Billing > Billable usage**, but treat it as an email notification only. The
current account alert is `Grimodex spend warning` at USD 15.

The deploy configuration therefore keeps the initial Worker paused, disables
all staging AI features, limits staging jobs, and uses the R2 lifecycle rules
above. A Budget Alert must never be used as authorization to turn
`SCAN_ACCEPTING_NEW_JOBS` on.

## Staging deployment

Validate both the local configuration and the exact remote D1/R2 identities,
migrate D1, and deploy the paused Worker:

```bash
pnpm scan:cloudflare -- check staging
pnpm scan:cloudflare -- remote-check staging
pnpm scan:cloudflare -- worker-dry-run staging
pnpm scan:cloudflare -- migrate staging
pnpm scan:cloudflare -- worker-deploy staging
```

Wrangler prints the `workers.dev` URL. Build and deploy the Scan PWA with that
URL. The Scan build receives both `VITE_SCAN_API_BASE_URL` and the canonical
`VITE_EDITOR_BASE_URL=https://grimodex-try-staging.pages.dev/editor`:

```bash
pnpm scan:cloudflare -- web-deploy staging \
  --api-base-url https://<staging-worker>.workers.dev
```

Deploy the hosted Editor independently from the root `dist` output. Staging
uses the canonical staging Worker URL by default:

```bash
pnpm editor:cloudflare -- web-deploy staging
```

This second command targets `grimodex-try-staging`; it never uploads the Scan
bundle. The Editor build receives `VITE_SCAN_API_BASE_URL` so a Scan handoff can
use its scoped hosted-AI session. Opening `/editor` without a handoff remains a
standalone Editor session.

The Worker `ALLOWED_ORIGINS` value must exactly match both canonical Pages
origins shown above.

## Smoke checks

```bash
pnpm scan:cloudflare -- smoke staging \
  --api-base-url https://<staging-worker>.workers.dev
```

The smoke command asserts all of the following instead of only checking that
URLs return a response:

- health reports `acceptingNewJobs: false`
- both canonical Scan and Editor origins receive their own exact CORS header
- a hostile origin receives no CORS grant
- an upload intent fails with `503 scan_paused`
- the Scan shell, manifest, and stamped service worker are available from the
  production branch of the staging Scan Pages project

The deploy-contract tests also verify that the hosted Editor uses the root
application build, the `grimodex-try[-staging]` projects, the `/editor` SPA
fallback, and a service worker that does not cache private API or handoff data:

```bash
pnpm test:cloudflare-scan-deploy
pnpm test:cloudflare-editor-deploy
```

This paused smoke does not exercise AI inference. Keep all staging AI feature
flags disabled until credentials, payload logging, and a disposable-text AI
smoke are reviewed separately.

Production Scan mutation commands require `--allow-production`. This flag is an
operator acknowledgement, not approval to enable traffic. A production Worker
whose config accepts new jobs additionally requires the separate
`--allow-production-traffic` flag.

Production HTTP deployment is currently blocked even with those flags because
`wrangler.production.jsonc` has `workers_dev: false` and no custom Worker route.
Before unblocking `worker-deploy`, configure and test the production route and
replace every production placeholder. The Editor `web-build` and `web-deploy`
actions are also hard-blocked until that exact reviewed Worker origin is
recorded as canonical repository configuration and the CLI contract tests are
updated. There is currently no production Editor build or deploy command.

The only hosted Editor deployment path currently supported by this repository
is staging. Its API origin must exactly match
`https://grimodex-scan-staging.kazormia296.workers.dev`; arbitrary HTTPS,
third-party, and alternate staging origins are rejected.

Production D1 migration and Worker dry-run remain available behind their
existing safeguards. Do not use an Editor deployment as a workaround for the
blocked production Worker/Scan rollout; its API origin must resolve to the
reviewed production Worker route first.
