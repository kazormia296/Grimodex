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
): ScanAiProvider {
  const invoke = async (
    input: ChunkExtractionInput,
    repair: boolean,
    repairContext?: { previousOutput: string; errors: string[] },
  ): Promise<ChunkExtractionV1> => {
    if (input.text.length > profile.maxInputCharacters) {
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
    let raw: unknown;
    try {
      raw = await binding.run(profile.model, {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: `${prompt.user}\n${repairInstruction}` },
        ],
      });
    } catch (cause) {
      throw providerErrorFromCause(cause);
    }
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
      let raw: unknown;
      try {
        raw = await binding.run(profile.model, {
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        });
      } catch (cause) {
        throw providerErrorFromCause(cause);
      }
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
