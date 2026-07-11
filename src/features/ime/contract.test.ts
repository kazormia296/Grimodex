import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020, {
  type AnySchema,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

const contractRoot = join(process.cwd(), "ime-contract");

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(join(contractRoot, relativePath), "utf8"));
}

function compileSchema(
  name: "state" | "project" | "consumer",
): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(readJson(`schema/${name}-v1.schema.json`) as AnySchema);
}

describe("IME Protocol V1 contract fixtures", () => {
  const fixtureCases = [
    {
      schema: "state" as const,
      valid: ["valid/state-active.json", "valid/state-inactive.json"],
      invalid: [
        "invalid/state-unsupported-version.json",
        "malicious/state-path-traversal.json",
      ],
    },
    {
      schema: "project" as const,
      valid: [
        "valid/project-minimal.json",
        "valid/project-with-zenzai-context.json",
      ],
      invalid: [
        "invalid/project-unsupported-version.json",
        "invalid/project-unknown-category.json",
        "malicious/project-path-traversal.json",
        "malicious/project-control-character.json",
      ],
    },
    {
      schema: "consumer" as const,
      valid: ["valid/consumer-legacy.json", "valid/consumer-linux.json"],
      invalid: [
        "invalid/consumer-missing-name.json",
        "malicious/consumer-path-traversal.json",
      ],
    },
  ];

  it.each(fixtureCases)(
    "accepts valid and rejects invalid $schema fixtures",
    ({ schema, valid, invalid }) => {
      const validate = compileSchema(schema);
      for (const relativePath of valid) {
        const fixture = readJson(`fixtures/${relativePath}`);
        expect(
          validate(fixture),
          `${relativePath}: ${JSON.stringify(validate.errors)}`,
        ).toBe(true);
      }
      for (const relativePath of invalid) {
        const fixture = readJson(`fixtures/${relativePath}`);
        expect(validate(fixture), `${relativePath} must be rejected`).toBe(
          false,
        );
      }
    },
  );

  it("keeps V1 forward-compatible while enforcing defensive project limits", () => {
    const validate = compileSchema("project");
    const fixture = readJson(
      "fixtures/valid/project-with-zenzai-context.json",
    ) as {
      entries: unknown[];
      [key: string]: unknown;
    };

    expect(
      validate({ ...fixture, future_optional_field: { enabled: true } }),
    ).toBe(true);
    expect(
      validate({
        ...fixture,
        entries: Array.from({ length: 20_001 }, () => fixture.entries[0]),
      }),
    ).toBe(false);
  });

  it("rejects C0 and C1 control characters in protocol text", () => {
    const validateProject = compileSchema("project");
    const project = readJson("fixtures/valid/project-minimal.json") as Record<
      string,
      unknown
    >;
    expect(validateProject({ ...project, project_name: "C1\u0085text" })).toBe(
      false,
    );

    const validateConsumer = compileSchema("consumer");
    const consumer = readJson("fixtures/valid/consumer-linux.json") as Record<
      string,
      unknown
    >;
    expect(validateConsumer({ ...consumer, name: "C0\u0007text" })).toBe(false);
    expect(validateConsumer({ ...consumer, name: "C1\u009ftext" })).toBe(false);
    expect(validateConsumer({ ...consumer, name: "lone\ud800surrogate" })).toBe(
      false,
    );
  });

  it("publishes the byte, count, and string limits consumed by every OS", () => {
    expect(readJson("protocol-v1-limits.json")).toEqual({
      state_max_bytes: 65_536,
      project_max_bytes: 16_777_216,
      consumer_max_bytes: 65_536,
      project_max_entries: 20_000,
      project_id_max_chars: 128,
      project_name_max_chars: 256,
      entry_yomi_max_chars: 256,
      entry_surface_max_chars: 256,
      entry_id_max_chars: 128,
      profile_max_chars: 400,
      zenzai_topic_max_chars: 200,
      zenzai_style_max_chars: 200,
      zenzai_preference_max_chars: 200,
      consumer_id_max_chars: 128,
      consumer_name_max_chars: 128,
      consumer_version_max_chars: 64,
      consumer_platform_max_chars: 32,
      timestamp_max_chars: 64,
      consumer_heartbeat_seconds: 900,
      consumer_freshness_ttl_seconds: 2_700,
      consumer_future_skew_seconds: 300,
    });
  });

  it("fixes the initial AzooKey CID, MID, priority-score, and deduplication policy", () => {
    const mapping = readJson("expected/mapped-entries.json") as {
      policy: unknown;
      mapped_entries: Array<Record<string, unknown>>;
      deduplicated_entries: Array<Record<string, unknown>>;
    };

    expect(mapping.policy).toEqual({
      cid: { person: 1289, place: 1293, noun: 1288 },
      mid: 501,
      priority_base_score: { "1": -8, "2": -5, "3": -4 },
      category_score_adjustment: { person: 0, place: -1, noun: -1 },
    });
    expect(mapping.mapped_entries).toContainEqual({
      input: {
        yomi: "せつな",
        surface: "刹那",
        category: "person",
        priority: 2,
        entry_id: "entry-setsuna",
      },
      output: {
        ruby: "セツナ",
        word: "刹那",
        cid: 1289,
        mid: 501,
        value: -5,
      },
    });
    expect(mapping.deduplicated_entries).toHaveLength(3);
  });

  it("fixes the cross-OS Zenzai topic truncation policy", () => {
    expect(readJson("expected/zenzai-topic.json")).toEqual({
      policy: {
        consumer_max_scalars: 25,
        truncation: "unicode_scalar_prefix",
        append_ellipsis: false,
      },
      cases: [
        {
          wire_topic: "溶鉄の星・軍事SF",
          consumer_topic: "溶鉄の星・軍事SF",
        },
        {
          wire_topic: "1234567890123456789012345・後半は切り捨て",
          consumer_topic: "1234567890123456789012345",
        },
      ],
    });
  });

  it("describes an atomic project switch without adopting a mixed snapshot", () => {
    const sequence = readJson(
      "fixtures/update-sequences/project-switch.json",
    ) as {
      initial_active_project_id: string;
      steps: Array<{
        operation: string;
        expected_active_project_id: string;
        expected_generation: number;
      }>;
    };

    expect(sequence.initial_active_project_id).toBe("project-a");
    expect(sequence.steps).toEqual([
      {
        operation: "replace_project_b",
        expected_active_project_id: "project-a",
        expected_generation: 1,
      },
      {
        operation: "replace_state_with_project_b",
        expected_active_project_id: "project-b",
        expected_generation: 2,
      },
      {
        operation: "rewrite_identical_project_b",
        expected_active_project_id: "project-b",
        expected_generation: 2,
      },
    ]);
  });
});
