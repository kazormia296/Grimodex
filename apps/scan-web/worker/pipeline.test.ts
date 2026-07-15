import { describe, expect, it } from "vitest";
import type { R2BucketLike, R2ObjectLike, ScanEnv } from "./env";
import type { ScanRepository } from "./repository";
import {
  applyAdjudicationDecisions,
  buildScanArtifacts,
  buildScanChunks,
  extractScanChunks,
  mergeScanExtractions,
  normalizeScanSource,
} from "./pipeline";

class MemoryBucket implements R2BucketLike {
  private readonly values = new Map<
    string,
    {
      value: string;
      contentType?: string;
      customMetadata?: Record<string, string>;
    }
  >();

  async put(
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<void> {
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
  const repository = {
    getScan: async () => scan,
    getUploadIntent: async () => upload,
    saveArtifact: async () => undefined,
    setPrivateArtifacts: async () => undefined,
    recordAiUsage: async () => undefined,
  } as unknown as ScanRepository;
  const env = { SCAN_BUCKET: bucket } as unknown as ScanEnv;
  return { bucket, env, repository, scanId, sourceKey };
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
});
