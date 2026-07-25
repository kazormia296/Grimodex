# Grimodex Privacy Notice

Last updated: 2026-07-25
Version: v1.7

This notice explains where the Grimodex desktop application and Web Editor trial store data and what is transmitted when the User configures AI. The Terms of Use control if this notice conflicts with them.

## 1. Scope of the service

The Web Editor is a trial for experiencing the editor and handing work off to Grimodex. It is not an AI subscription and does not include Developer-funded AI usage, a shared API key, or cloud manuscript analysis. To use AI, the User must expressly select a browser-local WebGPU model or configure an API key or endpoint under their control for a supported HTTP provider. CLI providers that require a native subprocess are not available in the Web Editor.

## 2. Storage locations

| Surface                                                 | Principal data                                                                                               | Storage                                      | Standard retention                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | --------------------------------------------- |
| Electron application                                    | Text, settings, chat history, editing metadata                                                               | SQLite on the User's device                  | Until the User deletes it                     |
| Web Editor trial                                        | Workspace, text, story-setting materials, chat history, AI responses                                         | IndexedDB in the current browser profile     | Until the workspace or site data is deleted   |
| Web Editor UI and AI configuration (excluding API keys) | Display preferences, selected provider and model, Ollama or OpenAI-compatible endpoint, and similar settings | Local Storage in the current browser profile | Until site data is deleted                    |
| Browser-local WebGPU model cache                        | Selected model weights, WebAssembly, and related runtime files                                               | Cache Storage in the current browser profile | Until site data or the model cache is deleted |
| AI data consent record                                  | Policy version, route, provider, actual destination, and acceptance time                                     | Local Storage in the current browser profile | Until site data is deleted                    |

The Web Editor's IndexedDB is not cloud synchronization or a backup. Deleting browser site data or a browser profile may make the data unrecoverable. The Web Editor does not upload or store manuscripts on the Developer's servers.

The handoff file created by “Continue in Grimodex” is generated in the browser and saved to a download location selected by the User. The User controls its storage, sharing, deletion, and backup after download.

A BYOK API key entered in the Web Editor is held only in the current page's runtime memory. It is not stored in IndexedDB, Local Storage, or the Developer's servers, and must be entered again after the page reloads or closes.

Model files obtained in browser-local WebGPU mode are stored in browser Cache Storage for reuse. The model cache does not contain the Grimodex workspace text, prompts, AI responses, or API keys.

## 3. Data sent to AI

The Web Editor does not enable AI automatically, process text with AI without a User action, or send text externally without a User action. In browser-local WebGPU mode, the following data is processed in the current browser and is not sent to a third-party inference API, a Grimodex server, or an unselected destination. In HTTP mode, only after the User configures AI, accepts the pre-request disclosure, and makes a request does the Web Editor send some or all of the following to the selected destination:

- the User's instruction, conversation history, and system instructions;
- text, scenes, Codex entries, settings, and other context selected for the request; and
- when the selected provider requires authentication, the User's own API key required to authenticate that request.

The pre-request disclosure enumerates the categories that will be sent. If the User declines, the applicable AI request is not transmitted.

## 4. AI processors, retention, and model training

### Browser-local WebGPU

When the User expressly selects browser-local WebGPU mode and a model, WebLLM downloads model files from that model's distribution host, stores them in Cache Storage, and processes prompts, conversation history, and selected text in the current browser and the device's GPU. It does not send that manuscript data to the model distribution host. The distribution host may record standard connection information such as the IP address, time, User-Agent, and requested model files during a download. Grimodex and third-party AI providers do not use browser-local inference data for model training.

### Ollama

Requests are sent to the Ollama endpoint configured by the User. A normal local configuration processes them on the User's device or User-managed network, but a remote Ollama endpoint also receives the data at the remote operator. Storage, retention, logging, and model-training use depend on the selected server, model, and operating configuration.

- [Ollama Privacy Policy](https://ollama.com/privacy)

### OpenAI-compatible endpoints

Requests are sent to the actual Base URL configured by the User. If an API key is required, it is held only in the current page's runtime memory. Storage, retention, logging, model-training use, processing location, and CORS support depend on the endpoint operator and model. Before transmitting data, Grimodex displays the normalized Base URL and asks again for consent if the destination changes.

### OpenAI / Anthropic BYOK

Requests are sent to the provider selected by the User and authenticated with the User's own API key. Grimodex does not pay the AI usage charges; usage, contracts, and billing are governed by the relationship between the User and each provider.

Provider-side storage, retention, and model-training use vary by account, contract, settings, model, and the provider's current policies. Grimodex does not make a universal guarantee about them. Review the pre-request disclosure and the following policies before sending data.

- [OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
- [How OpenAI uses data for model improvement](https://openai.com/policies/how-your-data-is-used-to-improve-model-performance/)
- [Anthropic model-training policy](https://privacy.anthropic.com/en/articles/7996868-is-my-data-used-for-model-training)
- [Anthropic retention periods](https://privacy.anthropic.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)

### OpenRouter BYOK

Requests are sent to OpenRouter using the User's own API key and may then be processed by downstream inference providers selected by the model and the User's routing settings. Storage, retention, and model-training use depend on OpenRouter and the selected downstream provider's settings and current policies.

- [OpenRouter data collection and privacy](https://openrouter.ai/docs/guides/privacy/data-collection)

### Sakana BYOK

Requests are sent to the Sakana AI API using the User's own API key. Available models, downstream processors, storage, retention, and model-training use depend on the account settings and Sakana AI's current policies. Grimodex does not provide a production relay server that receives the manuscript or API key.

- [Sakana AI Privacy Policy](https://console.sakana.ai/privacy-policy)

### AI Novelist BYOK

Requests are sent to the AI Novelist (Bit192) API using the User's own API key. Request formats and capabilities differ between its legacy and v1 APIs and by model. Storage, retention, and model-training use depend on the service's current policies.

- [AI Novelist API documentation](https://ai-novel.com/account_api_help.php)
- [AI Novelist Terms of Use](https://ai-novel.com/terms_of_use.html)

## 5. Explicit consent

Under quality requirement `GDX-AI-CONSENT-001`, Grimodex displays the following before processing data with browser-local WebGPU or transmitting data to an external AI provider or configured Ollama endpoint:

1. the data that will be sent;
2. the AI provider, processing purpose, and destination;
3. application-side and destination-side storage and retention;
4. whether the data is used for model training; and
5. links to the relevant usage and privacy policies.

Consent is bound to the policy version, route, provider, and actual destination (`browser://local` for browser-local WebGPU, or the configured endpoint for Ollama or an OpenAI-compatible provider). If any of them changes, the Web Editor asks again. If the User declines, processing stops before browser-local inference or a provider call.

The browser consent record does not include manuscripts, prompts, AI responses, or API keys. Once data has been sent, the selected destination's retention and deletion policies apply.

## 6. Non-AI communications

When the static Web Editor page is requested, its hosting provider may record standard connection information such as IP address, time, and User-Agent. The Web Editor does not send manuscript text to deliver the page.

When a browser-local WebGPU model is first used or its cache is refreshed, model files are downloaded from the model distribution host. That request does not include manuscript text, prompts, AI responses, or an API key.

The Electron application may connect to external services for license verification, update checks, and semantic-search model downloads. These communications do not transmit manuscript text, although the destination may record standard connection information.

## 7. User choices and deletion

- If the User declines the AI consent dialog, that AI request is not sent.
- Web Editor data can be erased by deleting the workspace or the browser's site data.
- A browser-local WebGPU model cache can be erased by deleting browser site data or Cache Storage.
- A downloaded handoff file must be deleted from the device or storage location where the User saved it.
- Reloading or closing the page removes a BYOK API key held in the Web Editor's runtime memory.
- Data already sent to a configured destination is governed by that destination's retention and deletion policy.

## 8. Contact

For questions about this notice, use an Issue in the [Grimodex GitHub repository](https://github.com/kazormia296/Grimodex). Do not paste a manuscript or API key into an Issue.
