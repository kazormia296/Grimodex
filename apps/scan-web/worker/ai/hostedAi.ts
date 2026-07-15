import type { ScanEnv } from "../env";

export class HostedAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HostedAiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const choices = value.choices;
  if (Array.isArray(choices) && choices[0]) {
    const first = choices[0];
    if (isRecord(first)) {
      const message = first.message;
      if (isRecord(message) && typeof message.content === "string")
        return message.content;
    }
  }
  for (const key of ["response", "output_text", "text", "result"]) {
    const nested = responseText(value[key]);
    if (nested) return nested;
  }
  return null;
}

async function openAiCompatible(
  url: string,
  token: string,
  model: string,
  prompt: string,
  context: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are Grimodex Hosted AI. Give concise editor assistance. Do not claim to have written to the workspace.",
        },
        {
          role: "user",
          content: `${context ? `Context:\n${context}\n\n` : ""}${prompt}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 2_000,
    }),
  });
  if (!response.ok)
    throw new HostedAiError(
      response.status,
      "hosted AI provider request failed",
    );
  const text = responseText(await response.json());
  if (!text)
    throw new HostedAiError(502, "hosted AI provider returned no text");
  return text;
}

export async function runHostedAi(
  env: ScanEnv,
  input: { prompt: string; context?: string },
): Promise<{ response: string; provider: string; model: string }> {
  const provider =
    env.SCAN_AI_PROVIDER ?? (env.AI ? "workers-ai" : "ai-gateway");
  const model = env.SCAN_AI_MODEL ?? "@cf/meta/llama-3.1-8b-instruct";
  if (provider === "workers-ai") {
    if (!env.AI) throw new HostedAiError(503, "Workers AI is not configured");
    const raw = await env.AI.run(model, {
      messages: [
        {
          role: "system",
          content:
            "You are Grimodex Hosted AI. Give concise editor assistance. Do not claim to have written to the workspace.",
        },
        {
          role: "user",
          content: `${input.context ? `Context:\n${input.context}\n\n` : ""}${input.prompt}`,
        },
      ],
    });
    const text = responseText(raw);
    if (!text) throw new HostedAiError(502, "Workers AI returned no text");
    return { response: text, provider, model };
  }
  if (provider === "ai-gateway") {
    if (!env.SCAN_AI_GATEWAY_URL || !env.AI_GATEWAY_TOKEN) {
      throw new HostedAiError(503, "AI Gateway is not configured");
    }
    return {
      response: await openAiCompatible(
        env.SCAN_AI_GATEWAY_URL,
        env.AI_GATEWAY_TOKEN,
        model,
        input.prompt,
        input.context,
      ),
      provider,
      model,
    };
  }
  if (provider === "openrouter") {
    if (!env.OPENROUTER_URL || !env.OPENROUTER_API_KEY) {
      throw new HostedAiError(503, "OpenRouter is not configured");
    }
    return {
      response: await openAiCompatible(
        env.OPENROUTER_URL,
        env.OPENROUTER_API_KEY,
        model,
        input.prompt,
        input.context,
        { "x-title": "Grimodex Hosted AI" },
      ),
      provider,
      model,
    };
  }
  throw new HostedAiError(503, "hosted AI provider is invalid");
}
