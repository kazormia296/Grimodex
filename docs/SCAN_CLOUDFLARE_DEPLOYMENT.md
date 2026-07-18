# Grimodex Scan Cloudflare deployment

Grimodex Scan is deployed as two independently reversible targets:

- `grimodex-scan-<environment>`: Worker, Workflow, D1, R2, Workers AI
- `grimodex-try-<environment>`: Vite/PWA output on Cloudflare Pages

Production is always prepared from a paused Worker. Do not enable
`SCAN_ACCEPTING_NEW_JOBS` until staging migration, health, CORS, upload, and AI
smoke checks have passed.

The deployment CLI deliberately refuses `SCAN_ACCEPTING_NEW_JOBS=true` in
staging. Use a separate reviewed activation workflow if staging traffic is
needed later.

## One-time account bootstrap

Authenticate and create isolated staging resources first:

```bash
pnpm exec wrangler login
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

Wrangler prints the `workers.dev` URL. Build and deploy the PWA with that URL:

```bash
pnpm scan:cloudflare -- web-deploy staging \
  --api-base-url https://<staging-worker>.workers.dev
```

The Pages origin must exactly match `ALLOWED_ORIGIN` in the Worker config.

## Smoke checks

```bash
pnpm scan:cloudflare -- smoke staging \
  --api-base-url https://<staging-worker>.workers.dev
```

The smoke command asserts all of the following instead of only checking that
URLs return a response:

- health reports `acceptingNewJobs: false`
- the canonical Pages origin receives the exact CORS header
- a hostile origin receives no CORS grant
- an upload intent fails with `503 scan_paused`
- the Pages shell, manifest, and stamped service worker are available from the
  production branch of the staging Pages project

This paused smoke does not exercise AI inference. Keep all staging AI feature
flags disabled until credentials, payload logging, and a disposable-text AI
smoke are reviewed separately.

Production mutation commands require `--allow-production`. This flag is an
operator acknowledgement, not approval to enable traffic. A production Worker
whose config accepts new jobs additionally requires the separate
`--allow-production-traffic` flag.

Production HTTP deployment is currently blocked even with those flags because
`wrangler.production.jsonc` has `workers_dev: false` and no custom Worker route.
Before unblocking `worker-deploy`, `web-build`, or `web-deploy`, configure and
test the production route, replace every production placeholder, and update the
CLI contract tests. Production D1 migration and Worker dry-run remain available
behind their existing safeguards.
