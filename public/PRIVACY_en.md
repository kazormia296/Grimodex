# Grimodex Privacy Notice

Last updated: 2026-07-19
Version: v1.1

This notice explains where each Grimodex surface stores data and what is transmitted when AI is used. The Terms of Use control if this notice conflicts with them. Because the processor, retention, and training status can vary by configuration, also review the route-specific disclosure shown immediately before an actual request.

## 1. Storage locations

| Surface                   | Principal data                                                                             | Storage                                  | Standard retention                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Electron application      | Text, settings, chat history, editing metadata                                             | SQLite on the User's device              | Until the User deletes it                                                                                                     |
| Hosted Editor             | Workspace, text, settings, chat history, AI responses                                      | IndexedDB in the current browser profile | Until the workspace or site data is deleted                                                                                   |
| Scan / Hosted AI          | Manuscript source, private reports, Editor seed, AI responses, and related artifacts       | Cloudflare R2                            | Production defaults: 60 minutes for incomplete uploads, one day for sources, and 30 days for private artifacts / AI responses |
| Scan operational metadata | Job state, token hashes, usage, retention deadlines, idempotency data, and similar records | Cloudflare D1                            | Subject to Scan session retention and deletion processing and applicable operational or legal requirements                    |

Hosted Editor's IndexedDB is not a cloud backup. Deleting browser site data or a browser profile may make the data unrecoverable. Grimodex does not guarantee a particular country of storage or processing for R2 or D1.

The short-lived session token used when moving from Scan to Editor remains in that tab's Session Storage until it expires and is removed when the tab closes. D1 stores only a verification hash, not the token itself.

The Scan deletion capability (Scan ID, access token, and mode) is stored in that tab's Session Storage so the User can still delete the Scan after reloading the same tab. The record contains no manuscript text or analysis result. It is removed when deletion completes or the tab closes. The server stores only a verification hash of the access token, not the token itself.

A Scan report that the User expressly publishes may remain accessible until the public report or its source Scan is deleted and is not governed in the same way as private artifacts. Staging environments, security records, abuse prevention, backups, and legal preservation obligations may use different periods.

## 2. Data sent to AI

Depending on the request, an AI feature sends some or all of the following:

- Scan: the complete uploaded manuscript, file information, and metadata needed for analysis;
- Chat / Inline AI: the User's instruction, conversation history, system instructions, and selected text;
- Context-aware features: selected scenes, Codex entries, settings, structure, and related text; and
- BYOK: the data above plus the API key required to authenticate to the selected provider.

The pre-request disclosure enumerates the categories that will be sent. If the User declines, the applicable AI request is not transmitted.

## 3. Processors, retention, and model training

### Hosted Scan / Hosted Editor

The standard route uses Cloudflare Workers, Workers AI, R2, and D1. Depending on the selected Scan mode and runtime configuration, the route may also use Cloudflare AI Gateway and the upstream AI provider identified in the disclosure. Cloudflare states that Workers AI Customer Content is not used to train AI models or improve its services without explicit consent.

- [Cloudflare Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)
- [How Cloudflare R2 works](https://developers.cloudflare.com/r2/how-r2-works/)
- [Cloudflare D1 API](https://developers.cloudflare.com/api/resources/d1/)
- [Cloudflare Privacy Policy](https://www.cloudflare.com/privacypolicy/)

If an upstream AI provider is used, that provider's retention and training policies also apply. If Grimodex cannot disclose every processor used by a route, it should fail closed and treat that route as unavailable.

### Browser BYOK

The production browser Editor sends requests to the AI provider selected by the User. The API key is held only in the current page's runtime memory and is not written to IndexedDB, Local Storage, R2, or D1. It must be entered again after the page reloads or closes.

Provider-side retention and training use vary with the account, contract, settings, model, and routing. When Grimodex cannot determine the status, the disclosure states that it depends on the provider. Representative references include:

- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [How OpenAI uses data to improve model performance](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/)
- [Anthropic model-training policy](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training)
- [Anthropic retention](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
- [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection)
- [OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr)

## 4. Explicit consent

Under quality requirement `GDX-AI-CONSENT-001`, Grimodex displays the following before transmitting data to an external AI:

1. the data that will be sent;
2. the AI provider, processing purpose, and destinations;
3. application-side and provider-side storage and retention;
4. whether the data is used for model training; and
5. links to the applicable usage and privacy policies.

Consent is bound to the combination of policy version, route (Scan, Hosted Editor, or BYOK), and provider. Grimodex asks again if any of them changes. Missing consent or an unavailable disclosure fails before a provider call.

The browser may store only the policy version, route, provider, and acceptance timestamp in Local Storage as a consent record. That record contains no manuscript, prompt, AI response, or API key. Scan API requests include an opaque consent identifier representing the current disclosure.

## 5. Non-AI communications

The Electron application may connect to external services for license validation, update checks, and semantic-search model downloads. Those communications do not include the manuscript text, although the destination may log connection information such as IP address, time, and User-Agent.

## 6. User choices and deletion

- Declining an AI disclosure prevents use of that AI route.
- Hosted Editor data can be removed by deleting the workspace or browser site data.
- Selecting “Delete manuscript and Scan data” on the Scan results screen stops an in-progress Scan and immediately revokes access. Grimodex starts removing the manuscript, private analysis results, and Editor handoff data stored in R2 and unpublishes any public report. Even if stored-file cleanup continues in the background, the Scan, public report, and new Editor handoffs are inaccessible after the deletion request is accepted.
- Content-free file and operational metadata, consent and usage records, hashes, backups, security or abuse-prevention records, and data subject to legal obligations may remain under applicable retention requirements. Data already sent to an AI processing provider remains subject to that provider's retention policy.
- Copies already imported into Hosted Editor or the local Grimodex application are not deleted. Remove those copies separately from each storage location.

## 7. Contact

For questions about this notice, use an Issue in the [Grimodex GitHub repository](https://github.com/kazormia296/Grimodex). Do not paste manuscripts, API keys, or access tokens into an Issue.
