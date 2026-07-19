import { describe, expect, it, vi } from "vitest";
import type { R2BucketLike, R2ObjectLike, ScanEnv } from "./env";
import type {
  ScanChunkRecord,
  ScanRepository,
  ScanSessionRecord,
} from "./repository";
import {
  applyAdjudicationDecisions,
  adjudicateScan,
  buildScanArtifacts,
  buildScanChunks,
  extractScanChunks,
  mergeScanExtractions,
  MAX_SCAN_CHUNKS,
  normalizeScanSource,
} from "./pipeline";
import {
  currentAiDataConsentIdentity,
  type AiDataConsentIdentity,
} from "./ai/aiDataDisclosure";
import { OPENROUTER_ACCOUNT_POLICY_ATTESTATION } from "./ai/openRouterPolicy";

class MemoryBucket implements R2BucketLike {
  private readonly values = new Map<
    string,
    {
      value: string;
      contentType?: string;
      customMetadata?: Record<string, string>;
    }
  >();
  private readonly putHistory: string[] = [];
  private putFailure: ((key: string) => boolean) | null = null;

  failNextPutWhere(predicate: (key: string) => boolean): void {
    this.putFailure = predicate;
  }

  keys(): string[] {
    return [...this.values.keys()];
  }

  putCount(key: string): number {
    return this.putHistory.filter((candidate) => candidate === key).length;
  }

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
    if (this.putFailure?.(key)) {
      this.putFailure = null;
      throw new Error("injected R2 PUT failure");
    }
    const text =
      typeof value === "string"
        ? value
        : new TextDecoder().decode(
            value instanceof Uint8Array
              ? value
              : new Uint8Array(value as ArrayBuffer),
          );
    this.values.set(key, {
      value: text,
      contentType: options?.httpMetadata?.contentType,
      customMetadata: options?.customMetadata,
    });
    this.putHistory.push(key);
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const value = this.values.get(key);
    if (!value) return null;
    return {
      body: new Response(value.value).body,
      size: new TextEncoder().encode(value.value).byteLength,
      httpMetadata: { contentType: value.contentType },
      customMetadata: value.customMetadata,
    };
  }

  async head(key: string): Promise<R2ObjectLike | null> {
    return this.get(key);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  readJson<T>(key: string): T {
    const value = this.values.get(key);
    if (!value) throw new Error(`missing object: ${key}`);
    return JSON.parse(value.value) as T;
  }
}

function createFixture() {
  const bucket = new MemoryBucket();
  const scanId = "scan-pipeline-test";
  const sourceKey = "incoming/upload-pipeline/source.txt";
  const scan = {
    id: scanId,
    uploadId: "upload-pipeline",
    mode: "quick" as const,
    status: "queued" as const,
    sourceHash: "sha256:source",
    privateBundleKey: null,
    privateReportKey: null,
    cancelRequestedAt: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    accessTokenHash: "token-hash",
    aiConsent: null as AiDataConsentIdentity | null,
  };
  const upload = {
    id: "upload-pipeline",
    tokenHash: "upload-token",
    filename: "pipeline.md",
    contentType: "text/markdown",
    expectedSize: 1,
    sourceKey,
    status: "consumed" as const,
    expiresAt: "2026-07-17T00:00:00.000Z",
    actualSize: 1,
    sourceHash: "sha256:source",
  };
  const adjudicationResults = new Map<
    string,
    {
      scanId: string;
      ambiguityId: string;
      resultJson: string;
      updatedAt: string;
    }
  >();
  let scanStatus: ScanSessionRecord["status"] = scan.status;
  const repository = {
    getScan: async () => ({ ...scan, status: scanStatus }),
    getUploadIntent: async () => upload,
    saveArtifact: async () => undefined,
    setPrivateArtifacts: async () => undefined,
    recordAiUsage: async () => undefined,
    getAdjudicationResult: async (resultScanId: string, ambiguityId: string) =>
      adjudicationResults.get(`${resultScanId}:${ambiguityId}`) ?? null,
    saveAdjudicationResult: async (
      resultScanId: string,
      ambiguityId: string,
      resultJson: string,
    ) => {
      const key = `${resultScanId}:${ambiguityId}`;
      const existing = adjudicationResults.get(key);
      if (existing) return existing;
      const record = {
        scanId: resultScanId,
        ambiguityId,
        resultJson,
        updatedAt: "2026-07-16T00:00:00.000Z",
      };
      adjudicationResults.set(key, record);
      return record;
    },
  } as unknown as ScanRepository;
  const env = { SCAN_BUCKET: bucket } as unknown as ScanEnv;
  return {
    adjudicationResults,
    bucket,
    env,
    repository,
    scanId,
    setScanStatus: (status: ScanSessionRecord["status"]) => {
      scanStatus = status;
    },
    setAiConsent: (identity: AiDataConsentIdentity | null) => {
      scan.aiConsent = identity;
    },
    sourceKey,
  };
}

async function prepareFrontierAdjudication(
  fixture: ReturnType<typeof createFixture>,
) {
  await fixture.bucket.put(
    `artifacts/${fixture.scanId}/merge.json`,
    JSON.stringify({
      sourceFingerprint: "sha256:source",
      entities: [],
      relations: [],
      events: [],
      phases: [],
      unresolvedRelations: [],
      unresolvedEvents: [],
      unresolvedPhases: [],
      ambiguities: [],
      ambiguityEntityIds: { "ambiguity:1": [] },
      ambiguityInputs: [
        {
          ambiguityId: "ambiguity:1",
          candidateSummary: "葵 / アオイ",
          evidenceParagraphs: [
            { paragraphId: "paragraph:1", text: "葵は港にいた。" },
          ],
        },
      ],
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  const run = vi.fn(async () => ({
    response: JSON.stringify({
      schemaVersion: "grimodex-scan/adjudication/1",
      ambiguityId: "ambiguity:1",
      decision: "keep-separate",
      rationale: "証拠が足りない",
    }),
  }));
  Object.assign(fixture.env, {
    AI: { run },
    SCAN_FRONTIER_ENABLED: "true",
    SCAN_FRONTIER_PROVIDER: "workers-ai",
    SCAN_FRONTIER_MODEL: "frontier-test",
  });
  fixture.setAiConsent(await currentAiDataConsentIdentity(fixture.env, "scan"));
  return run;
}

describe("scan pipeline", () => {
  it("applies an explicit Full adjudication merge to downstream references", () => {
    const result = applyAdjudicationDecisions(
      {
        entities: [
          {
            id: "entity:a",
            type: "character",
            name: "葵",
            aliases: [],
            confidence: 0.8,
            evidence: [],
          },
          {
            id: "entity:b",
            type: "character",
            name: "アオイ",
            aliases: [],
            confidence: 0.9,
            evidence: [],
          },
          {
            id: "entity:c",
            type: "place",
            name: "灯台",
            aliases: [],
            confidence: 0.9,
            evidence: [],
          },
        ],
        relations: [
          {
            id: "relation:r",
            fromEntityId: "entity:b",
            toEntityId: "entity:c",
            type: "visits",
            confidence: 0.8,
            evidence: [],
          },
        ],
        phases: [
          {
            id: "phase:p",
            title: "到着",
            entityIds: ["entity:b"],
            anchors: [],
            confidence: 0.8,
          },
        ],
        events: [
          {
            id: "event:e",
            title: "到着",
            sectionId: "section:0",
            paragraphIds: [],
            entityIds: ["entity:a", "entity:b"],
            order: 0,
            evidence: [],
          },
        ],
      },
      [
        {
          ambiguityId: "ambiguity:a",
          entityIds: ["entity:a", "entity:b"],
          decision: "merge",
          rationale: "same character",
          provider: "deterministic-fallback",
          model: "test",
        },
      ],
    );

    expect(result.entities.map((entity) => entity.id)).toEqual([
      "entity:a",
      "entity:c",
    ]);
    expect(result.relations[0]).toMatchObject({ fromEntityId: "entity:a" });
    expect(result.phases[0]?.entityIds).toEqual(["entity:a"]);
    expect(result.events[0]?.entityIds).toEqual(["entity:a"]);
  });

  it("runs the deterministic Quick path through source, chunks, extraction, merge and private artifacts", async () => {
    const fixture = createFixture();
    const source = "# 灯台\n\n葵は灯台へ向かった。\n\n# 港\n\n葵は港で待った。";
    await fixture.bucket.put(fixture.sourceKey, source, {
      httpMetadata: { contentType: "text/markdown" },
    });
    const sourceResult = await normalizeScanSource(
      fixture.env,
      fixture.repository,
      fixture.scanId,
    );
    expect(sourceResult.fingerprint).toMatch(/^sha256:/);
    const chunks = await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    expect(chunks.count).toBeGreaterThan(0);
    const extractions = await extractScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
    );
    expect(extractions.count).toBe(chunks.count);
    expect(extractions.fallbackCount).toBe(0);
    const merged = await mergeScanExtractions(
      fixture.env,
      fixture.repository,
      fixture.scanId,
    );
    expect(merged.entityCount).toBeGreaterThan(0);
    const artifacts = await buildScanArtifacts(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    expect(artifacts.bundle.schemaVersion).toBe("grimodex-scan/1");
    expect(artifacts.editorSeed.bundle.source.fingerprint).toBe(
      artifacts.bundle.source.fingerprint,
    );
    expect(await fixture.bucket.get(artifacts.bundleKey)).not.toBeNull();
    expect(await fixture.bucket.get(artifacts.reportKey)).not.toBeNull();
  });

  it("keeps long deterministic evidence as exact source substrings through Quick artifact generation", async () => {
    const fixture = createFixture();
    const paragraph = "Alice walks across the harbor while the storm gathers. "
      .repeat(6)
      .trim();
    const source = `# Chapter One\n\n${paragraph}`;
    await fixture.bucket.put(fixture.sourceKey, source, {
      httpMetadata: { contentType: "text/markdown" },
    });

    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    await extractScanChunks(fixture.env, fixture.repository, fixture.scanId);
    await mergeScanExtractions(fixture.env, fixture.repository, fixture.scanId);

    const artifacts = await buildScanArtifacts(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    const evidenceExcerpts: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (typeof value !== "object" || value === null) return;
      const record = value as Record<string, unknown>;
      if (
        typeof record.paragraphId === "string" &&
        typeof record.excerpt === "string"
      ) {
        evidenceExcerpts.push(record.excerpt);
      }
      Object.values(record).forEach(visit);
    };
    visit(artifacts.bundle);

    expect(evidenceExcerpts.length).toBeGreaterThan(0);
    expect(
      evidenceExcerpts.every(
        (excerpt) => paragraph.includes(excerpt) && !excerpt.endsWith("…"),
      ),
    ).toBe(true);
    expect(artifacts.editorSeed.bundle.source.language).toBe("en");
  });

  it("uses the validated R2 source-language override during normalization", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(
      fixture.sourceKey,
      "# 第一章\n\n葵は灯台へ向かった。",
      {
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: { sourceLanguage: "en" },
      },
    );

    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);

    const document = fixture.bucket.readJson<{
      source: { language: string };
    }>(`artifacts/${fixture.scanId}/source-document.json`);
    expect(document.source.language).toBe("en");
  });

  it("builds deterministic English artifacts without fixed Japanese report text", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(
      fixture.sourceKey,
      "# Chapter One\n\nAlice crossed the harbor before dawn.",
      { httpMetadata: { contentType: "text/markdown" } },
    );

    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    await extractScanChunks(fixture.env, fixture.repository, fixture.scanId);
    await mergeScanExtractions(fixture.env, fixture.repository, fixture.scanId);
    const artifacts = await buildScanArtifacts(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );

    expect(artifacts.bundle.source.language).toBe("en");
    expect(artifacts.bundle.summary?.strengths[0]).toMatchObject({
      title: "Structured manuscript",
      summary: "Detected 1 section.",
    });
    expect(JSON.stringify(artifacts.bundle)).not.toMatch(
      /[\u3040-\u30ff\u3400-\u9fff]/u,
    );
  });

  it("uses fenced D1 results as checkpoints and repairs a missing usage ledger on recovery", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(fixture.sourceKey, "葵は灯台へ向かった。", {
      httpMetadata: { contentType: "text/plain" },
    });
    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    const chunks = new Map<string, ScanChunkRecord>();
    const recordAiUsage = vi.fn(
      async (_input: Parameters<ScanRepository["recordAiUsage"]>[0]) =>
        undefined,
    );
    Object.assign(fixture.repository, {
      ensureScanChunks: async (
        scanId: string,
        inputs: readonly {
          chunkHash: string;
          pipelineVersion: string;
          inputKey: string;
        }[],
      ) => {
        for (const input of inputs) {
          const key = `${input.chunkHash}:${input.pipelineVersion}`;
          if (!chunks.has(key)) {
            chunks.set(key, {
              scanId,
              chunkHash: input.chunkHash,
              pipelineVersion: input.pipelineVersion,
              inputKey: input.inputKey,
              extractionKey: null,
              extractionJson: null,
              status: "queued",
              attempt: 0,
              updatedAt: "2026-07-16T00:00:00.000Z",
            });
          }
        }
      },
      getScanChunk: async (
        _scanId: string,
        chunkHash: string,
        pipelineVersion: string,
      ) => chunks.get(`${chunkHash}:${pipelineVersion}`) ?? null,
      claimScanChunk: async (
        _scanId: string,
        chunkHash: string,
        pipelineVersion: string,
      ) => {
        const key = `${chunkHash}:${pipelineVersion}`;
        const current = chunks.get(key);
        if (!current || current.status === "completed") return null;
        const claimed: ScanChunkRecord = {
          ...current,
          status: "running",
          attempt: current.attempt + 1,
        };
        chunks.set(key, claimed);
        return claimed;
      },
      saveScanChunkResult: async (
        _scanId: string,
        chunkHash: string,
        pipelineVersion: string,
        attempt: number,
        extractionJson: string,
      ) => {
        const key = `${chunkHash}:${pipelineVersion}`;
        const current = chunks.get(key);
        if (!current || current.attempt !== attempt)
          throw new Error("superseded");
        chunks.set(key, { ...current, extractionJson });
      },
      completeScanChunk: async (
        _scanId: string,
        chunkHash: string,
        pipelineVersion: string,
        attempt: number,
        extractionKey: string,
      ) => {
        const key = `${chunkHash}:${pipelineVersion}`;
        const current = chunks.get(key);
        if (!current || current.attempt !== attempt)
          throw new Error("superseded");
        chunks.set(key, {
          ...current,
          status: "completed",
          extractionKey,
        });
      },
      failScanChunk: async () => true,
      recordAiUsage,
    });

    await extractScanChunks(fixture.env, fixture.repository, fixture.scanId);

    const aggregateKey = `artifacts/${fixture.scanId}/chunk-extractions.json`;
    expect(fixture.bucket.putCount(aggregateKey)).toBe(1);
    expect(recordAiUsage).toHaveBeenCalledOnce();

    // Simulate a lost ledger write: a retry must recreate it from the fenced
    // completed chunk without repeating extraction.
    recordAiUsage.mockClear();
    await extractScanChunks(fixture.env, fixture.repository, fixture.scanId);
    expect(recordAiUsage).toHaveBeenCalledOnce();
    expect(recordAiUsage.mock.calls[0]?.[0]).toMatchObject({
      operationId: expect.stringMatching(/:extract$/),
      status: "completed",
    });
  });

  it("accepts the per-step chunk boundary and rejects one extra chunk before provider calls", async () => {
    const fixture = createFixture();
    const documentFor = (count: number) => {
      const paragraphs = Array.from({ length: count }, (_, index) => ({
        id: `paragraph:${index}`,
        sectionId: "section:0",
        sectionOrdinal: 0,
        ordinal: index,
        text: String(index).padStart(4, "0") + "x".repeat(3_994),
      }));
      return {
        title: "Chunk budget",
        text: paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
        source: {
          title: "Chunk budget",
          language: "en",
          fingerprint: `sha256:${count}`,
          characterCount: paragraphs.reduce(
            (total, paragraph) => total + paragraph.text.length,
            0,
          ),
          paragraphCount: count,
          sectionCount: 1,
        },
        sections: [
          {
            id: "section:0",
            ordinal: 0,
            title: "Chunk budget",
            paragraphIds: paragraphs.map((paragraph) => paragraph.id),
            paragraphs,
          },
        ],
        paragraphs,
      };
    };
    const sourceDocumentKey = `artifacts/${fixture.scanId}/source-document.json`;
    await fixture.bucket.put(
      sourceDocumentKey,
      JSON.stringify(documentFor(MAX_SCAN_CHUNKS)),
    );

    await expect(
      buildScanChunks(fixture.env, fixture.repository, fixture.scanId, "full"),
    ).resolves.toMatchObject({ count: MAX_SCAN_CHUNKS });

    await fixture.bucket.put(
      sourceDocumentKey,
      JSON.stringify(documentFor(MAX_SCAN_CHUNKS + 1)),
    );
    await expect(
      buildScanChunks(fixture.env, fixture.repository, fixture.scanId, "full"),
    ).rejects.toThrow(`maximum ${MAX_SCAN_CHUNKS}`);

    const run = vi.fn(async () => ({ response: "{}" }));
    Object.assign(fixture.env, {
      AI: { run },
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_AI_MODEL: "test-model",
    });
    fixture.setAiConsent(
      await currentAiDataConsentIdentity(fixture.env, "scan"),
    );
    await fixture.bucket.put(
      `artifacts/${fixture.scanId}/chunks.json`,
      JSON.stringify({
        sourceFingerprint: `sha256:${MAX_SCAN_CHUNKS + 1}`,
        chunks: Array.from({ length: MAX_SCAN_CHUNKS + 1 }, (_, index) => ({
          id: `chunk:${index}`,
          text: "x",
          paragraphIds: [`paragraph:${index}`],
          sectionIds: ["section:0"],
        })),
      }),
    );
    await expect(
      extractScanChunks(fixture.env, fixture.repository, fixture.scanId),
    ).rejects.toThrow(`maximum ${MAX_SCAN_CHUNKS}`);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops after a billable extraction when cancellation wins during the call", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(fixture.sourceKey, "葵は灯台へ向かった。", {
      httpMetadata: { contentType: "text/plain" },
    });
    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    const run = vi.fn(async () => {
      fixture.setScanStatus("cancel_requested");
      return { response: "{}" };
    });
    Object.assign(fixture.env, {
      AI: { run },
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_AI_MODEL: "test-model",
    });
    fixture.setAiConsent(
      await currentAiDataConsentIdentity(fixture.env, "scan"),
    );

    await expect(
      extractScanChunks(fixture.env, fixture.repository, fixture.scanId),
    ).rejects.toThrow("scan is not active for an AI request: cancel_requested");
    expect(run).toHaveBeenCalledOnce();
    expect(
      fixture.bucket.keys().some((key) => key.includes("chunk-extractions")),
    ).toBe(false);
  });

  it("fails closed before a retried provider call when the accepted Scan provider changes", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(fixture.sourceKey, "葵は灯台へ向かった。", {
      httpMetadata: { contentType: "text/plain" },
    });
    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    Object.assign(fixture.env, {
      AI: { run: vi.fn(async () => ({ response: "unused" })) },
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_AI_MODEL: "test-model",
    });
    fixture.setAiConsent(
      await currentAiDataConsentIdentity(fixture.env, "scan"),
    );
    Object.assign(fixture.env, {
      SCAN_AI_PROVIDER: "openrouter",
      OPENROUTER_URL: "https://openrouter.ai/api/v1/chat/completions",
      OPENROUTER_API_KEY: "server-only",
      OPENROUTER_ACCOUNT_POLICY_ATTESTATION,
    });
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    try {
      await expect(
        extractScanChunks(fixture.env, fixture.repository, fixture.scanId),
      ).rejects.toThrow(/AI data consent/i);
      expect(providerFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not issue a billable extraction after cancellation was requested", async () => {
    const fixture = createFixture();
    await fixture.bucket.put(fixture.sourceKey, "葵は灯台へ向かった。", {
      httpMetadata: { contentType: "text/plain" },
    });
    await normalizeScanSource(fixture.env, fixture.repository, fixture.scanId);
    await buildScanChunks(
      fixture.env,
      fixture.repository,
      fixture.scanId,
      "quick",
    );
    fixture.setScanStatus("cancel_requested");
    const run = vi.fn(async () => ({ response: "{}" }));
    Object.assign(fixture.env, {
      AI: { run },
      SCAN_WORKERS_AI_ENABLED: "true",
      SCAN_AI_PROVIDER: "workers-ai",
      SCAN_AI_MODEL: "test-model",
    });

    await expect(
      extractScanChunks(fixture.env, fixture.repository, fixture.scanId),
    ).rejects.toThrow("scan is not active for an AI request: cancel_requested");
    expect(run).not.toHaveBeenCalled();
  });

  it("reuses a durable adjudication result when a workflow step is retried", async () => {
    const fixture = createFixture();
    const run = await prepareFrontierAdjudication(fixture);

    await adjudicateScan(fixture.env, fixture.repository, fixture.scanId);
    await adjudicateScan(fixture.env, fixture.repository, fixture.scanId);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("repairs a failed adjudication R2 PUT from D1 without repeating the paid provider call", async () => {
    const fixture = createFixture();
    const run = await prepareFrontierAdjudication(fixture);
    fixture.bucket.failNextPutWhere((key) =>
      key.includes("/adjudication-results/"),
    );

    await expect(
      adjudicateScan(fixture.env, fixture.repository, fixture.scanId),
    ).rejects.toThrow("injected R2 PUT failure");
    expect(run).toHaveBeenCalledTimes(1);
    expect(fixture.adjudicationResults.size).toBe(1);
    expect(
      fixture.bucket
        .keys()
        .some((key) => key.includes("/adjudication-results/")),
    ).toBe(false);

    await adjudicateScan(fixture.env, fixture.repository, fixture.scanId);

    expect(run).toHaveBeenCalledTimes(1);
    expect(
      fixture.bucket
        .keys()
        .some((key) => key.includes("/adjudication-results/")),
    ).toBe(true);
  });
});
