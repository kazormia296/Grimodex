import {
  validateChunkExtraction,
  type ChunkExtractionV1,
} from "@grimodex/scan-contract";
import {
  buildAdjudicationPrompt,
  buildChunkExtractionPrompt,
  parseJsonOnce,
  quoteDocumentData,
  ScanProviderError,
  type AdjudicationInput,
  type AdjudicationResultV1,
  type ChunkExtractionInput,
  type ScanAiProvider,
  type ScanModelProfile,
} from "@grimodex/scan-prompts";

export interface WorkersAiBindingLike {
  run(
    model: string,
    input: { messages: Array<{ role: "system" | "user"; content: string }> },
  ): Promise<unknown>;
}

export interface ProviderCallHooks {
  beforeCall?: () => Promise<void>;
  afterCall?: () => Promise<void>;
}

export const PROVIDER_CALL_TIMEOUT_MS = 45_000;

function providerTimeoutError(): Error {
  const error = new Error("AI provider request timed out");
  error.name = "AbortError";
  return error;
}

/**
 * Applies one wall-clock deadline to the provider request and response body.
 * Workers AI does not currently accept an AbortSignal, so the signal also
 * drives a rejecting race that releases the Workflow step at the deadline.
 */
export async function withProviderCallTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PROVIDER_CALL_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let rejectTimeout: ((cause: Error) => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const onAbort = () => rejectTimeout?.(providerTimeoutError());
  controller.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return null;
  const choices = value.choices;
  if (Array.isArray(choices) && choices[0] && isRecord(choices[0])) {
    const message = choices[0].message;
    if (isRecord(message) && typeof message.content === "string")
      return message.content;
  }
  for (const key of ["response", "output_text", "text", "result"]) {
    const nested = value[key];
    if (typeof nested === "string") return nested;
    const nestedText = responseText(nested);
    if (nestedText) return nestedText;
  }
  return null;
}

function providerErrorFromCause(cause: unknown): ScanProviderError {
  const value = cause as { status?: unknown; name?: unknown };
  const status = typeof value.status === "number" ? value.status : undefined;
  if (status === 401 || status === 403) {
    return new ScanProviderError(
      "unavailable",
      "AI provider authorization failed",
      false,
    );
  }
  if (status === 408 || status === 504 || value.name === "AbortError") {
    return new ScanProviderError(
      "timeout",
      "Workers AI request timed out",
      true,
    );
  }
  if (status === 429) {
    return new ScanProviderError(
      "rate-limited",
      "Workers AI rate limit reached",
      true,
    );
  }
  return new ScanProviderError(
    "unavailable",
    `Workers AI request failed: ${String(cause)}`,
    true,
  );
}

function invalidProviderError(
  message: string,
  code: "invalid-json" | "schema-invalid" = "schema-invalid",
): ScanProviderError {
  return new ScanProviderError(code, message, false);
}

function validateAdjudicationResult(
  value: unknown,
  expectedAmbiguityId: string,
): AdjudicationResultV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidProviderError("adjudication output must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== "grimodex-scan/adjudication/1" ||
    record.ambiguityId !== expectedAmbiguityId ||
    (record.decision !== "merge" &&
      record.decision !== "keep-separate" &&
      record.decision !== "uncertain") ||
    typeof record.rationale !== "string" ||
    record.rationale.length === 0 ||
    record.rationale.length > 2_000
  ) {
    throw invalidProviderError(
      "adjudication output failed contract validation",
    );
  }
  return record as unknown as AdjudicationResultV1;
}

export function createWorkersAiProvider(
  binding: WorkersAiBindingLike,
  profile: ScanModelProfile,
  hooks: ProviderCallHooks = {},
): ScanAiProvider {
  const runProvider = async (
    input: Parameters<WorkersAiBindingLike["run"]>[1],
  ): Promise<unknown> => {
    await hooks.beforeCall?.();
    let result: unknown;
    let providerFailed = false;
    let providerFailure: unknown;
    try {
      result = await withProviderCallTimeout(() =>
        binding.run(profile.model, input),
      );
    } catch (cause) {
      providerFailed = true;
      providerFailure = cause;
    }
    // A cancellation detected here must take precedence over a provider
    // timeout/rate-limit so the pipeline cannot silently fall back and keep
    // processing after the user has stopped the scan.
    await hooks.afterCall?.();
    if (providerFailed) throw providerErrorFromCause(providerFailure);
    return result;
  };

  const invoke = async (
    input: ChunkExtractionInput,
    repair: boolean,
    repairContext?: { previousOutput: string; errors: string[] },
  ): Promise<ChunkExtractionV1> => {
    const inputCharacters = input.paragraphs.reduce(
      (total, paragraph) => total + paragraph.text.length,
      0,
    );
    if (inputCharacters > profile.maxInputCharacters) {
      throw invalidProviderError("chunk exceeds the model input limit");
    }
    const prompt = buildChunkExtractionPrompt(input);
    const repairInstruction = repair
      ? [
          "Repair the previous output. Return only one valid JSON object matching ChunkExtractionV1. Do not add prose.",
          `validationErrors=${JSON.stringify(repairContext?.errors ?? [])}`,
          quoteDocumentData(
            (repairContext?.previousOutput ?? "").slice(
              0,
              Math.max(1, profile.maxOutputCharacters),
            ),
          ),
        ].join("\n")
      : "";
    const raw = await runProvider({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: `${prompt.user}\n${repairInstruction}` },
      ],
    });
    const text = responseText(raw);
    if (!text)
      throw invalidProviderError("Workers AI response did not contain text");
    let parsed: unknown;
    try {
      parsed = parseJsonOnce(text);
    } catch {
      if (repair)
        throw invalidProviderError(
          "Workers AI returned invalid JSON twice",
          "invalid-json",
        );
      return invoke(input, true, {
        previousOutput: text,
        errors: ["provider returned invalid JSON"],
      });
    }
    const validation = validateChunkExtraction(parsed, {
      expectedChunkId: input.chunkId,
      expectedSourceFingerprint: input.sourceFingerprint,
      paragraphIds: input.paragraphIds,
      sectionIds: input.sectionIds,
      paragraphSectionIds: input.paragraphSectionIds,
    });
    if (!validation.ok) {
      if (!repair)
        return invoke(input, true, {
          previousOutput: text,
          errors: validation.errors.map(
            (item) => `${item.path}: ${item.message}`,
          ),
        });
      throw invalidProviderError(
        `Workers AI output failed contract validation: ${validation.errors[0]?.message ?? "invalid output"}`,
      );
    }
    return validation.value;
  };

  return {
    extractChunk: (input) => invoke(input, false),
    adjudicate: async (input: AdjudicationInput) => {
      const prompt = buildAdjudicationPrompt({
        ambiguityId: input.ambiguityId,
        candidateSummary: input.candidateSummary,
        evidence: input.evidenceParagraphs,
      });
      const raw = await runProvider({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      });
      const text = responseText(raw);
      if (!text)
        throw invalidProviderError(
          "Workers AI adjudication response did not contain text",
        );
      try {
        return validateAdjudicationResult(
          parseJsonOnce(text),
          input.ambiguityId,
        );
      } catch (cause) {
        if (cause instanceof ScanProviderError) throw cause;
        throw invalidProviderError(
          "Workers AI adjudication returned invalid JSON",
          "invalid-json",
        );
      }
    },
    writeReport: async () => {
      throw invalidProviderError(
        "Workers AI provider report writing is not enabled in the scaffold",
      );
    },
  };
}
