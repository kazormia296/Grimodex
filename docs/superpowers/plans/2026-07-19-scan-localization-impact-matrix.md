# Scan localization and Editor language handoff impact matrix

| ID | Flow / variant | Owner / producer | Boundary, contract, transform, validation | Consumer / sink | Preserved invariant | Compatibility / fallback | Verification | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | Scan UI locale, automatic | Browser locale | `navigator.languages` -> `auto` resolver -> `ja` or `en` | Scan UI and `<html lang>` | Only `ja` and `en` reach renderers | Unsupported browser locales fall back to Japanese | Locale unit tests and local/deployed browser QA | verified |
| P2 | Scan UI locale, manual | Scan language selector | `auto | ja | en` allowlist and Local Storage preference | Scan UI and future Scan visits | Manual choice wins over browser changes | Missing or invalid stored values use `auto` | Locale unit, render, and browser tests | verified |
| P3 | Manuscript language, automatic or manual | Scan upload control | `auto | ja | en` request header -> Worker allowlist -> source normalization and fingerprint | Scan bundle and Editor seed | Bundle and source languages remain identical | `auto` detects manuscript; inconclusive text falls back to Japanese | API, router, pipeline, and import tests | verified |
| P4 | Localized data disclosure | Scan resolved UI locale | `?locale=ja|en` / `Accept-Language` allowlist -> localized disclosure strings and policy URL | Consent dialog | Consent identity remains bound to policy version, route, and actual processor chain, not translation | Old clients without locale receive English | Worker contract tests in both locales and staging API smoke | verified |
| P5 | AI-disabled Quick Scan disclosure | Worker feature flags | Enabled-provider inventory -> deterministic/local or hosted processing disclosure | Consent dialog and stored consent identity | No processor or AI training claim is invented | Missing flags are treated as disabled | Disclosure and consent-identity tests | verified |
| P6 | Policy links | Disclosure fields | URL dedupe plus processor/topic-specific localized labels | Consent dialog links | Every current policy URL remains reachable | Duplicate provider URLs collapse to one descriptive link | Dialog render tests | verified |
| P7 | Scan -> Editor UI locale | Scan resolved UI locale | Optional `ui-language` in scrubbed URL fragment -> strict `ja/en` parser | Hosted Editor global UI setting and i18next | One-time token never enters query, referrer, or history after consume | Old handoff URLs preserve Editor's saved UI language; invalid locale is ignored | Contract, consumer, browser runtime, and deployed Editor tests | verified |
| P8 | Scan -> Editor writing language | Worker normalized source | Existing Editor seed `source.language` -> import plan -> `projects.language` | Editor project defaults and writing behavior | UI locale and manuscript language remain independent | Legacy seeds remain valid | Existing and focused import tests | verified unchanged |
| P9 | Long deterministic evidence | Worker deterministic extractor and provider boundary | Exact source substring capped to contract limit -> provider validation -> merge -> Editor seed validation | Quick Scan artifacts | Evidence excerpts always occur in the referenced paragraph | Long excerpts truncate without synthetic characters; translated or paraphrased excerpts are repaired once and then rejected | Contract, provider, and pipeline regression tests | verified |
| P10 | Standalone Editor | Direct Editor link | No Scan token or locale handoff | Hosted Editor | Editor remains independently launchable | Existing persisted Editor UI language is unchanged | Browser runtime test and local/deployed browser QA | verified |
| P11 | Cloudflare staging deploy | Validated build | Staging config -> D1 migrations -> Worker -> Scan Pages -> Editor Pages | Staging URLs | Production placeholders and traffic remain untouched | Staging remains paused and all hosted AI flags remain disabled | Wrangler remote check, dry run, deploy output, canonical smoke, and browser QA | deployed to paused staging |

Implementation proceeds as focused vertical slices: exact-evidence repair, locale primitives and UI, localized disclosure and policy links, writing-language override, Editor UI handoff, then local and staging verification.

## Staging deployment evidence

- Worker: `https://grimodex-scan-staging.kazormia296.workers.dev` (version `243ef9dd-0ab8-4ac3-ad23-3c1be0da9cda`)
- Scan Pages: `https://grimodex-scan-staging.pages.dev`
- Editor Pages: `https://grimodex-try-staging.pages.dev/editor`
- D1 migrations `0013_editor_sessions.sql` and `0014_scan_ai_consent_identity.sql` applied successfully.
- Canonical smoke passed with `SCAN_ACCEPTING_NEW_JOBS=false`; production was not changed.
