import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));

import {
  MAINTENANCE_INBOX_CONSUMER_KINDS,
  narrativeMaintenanceInboxList,
  parseMaintenanceInbox,
} from "./nativeApi";

describe("MAINTENANCE_INBOX_CONSUMER_KINDS", () => {
  it("covers every consumer kind of the consumer contract, plus only the synthetic failure kind", () => {
    const repoRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../..",
    );
    const contract = JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          "policies/narrative/narrative-consumer-contract.json",
        ),
        "utf8",
      ),
    ) as { consumerKinds: { kind: string }[] };
    const contractKinds = contract.consumerKinds.map((entry) => entry.kind);
    expect(contractKinds).toHaveLength(11);
    expect([...MAINTENANCE_INBOX_CONSUMER_KINDS].sort()).toEqual(
      [...contractKinds, "narrative-maintenance-failure"].sort(),
    );
  });

  it("keeps a known but uncounted kind as itself, not 'unrecognized'", () => {
    const [entry] = parseMaintenanceInbox([
      {
        entry_kind: "consumer-freshness",
        consumer_kind: "extraction-artifact",
        evidence_freshness: "fresh",
      },
    ]);
    expect(entry?.consumerKind).toBe("extraction-artifact");
  });
});

describe("narrativeMaintenanceInboxList", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("sends only the project id under `payload`", async () => {
    invokeMock.mockResolvedValue([]);
    await expect(
      narrativeMaintenanceInboxList({ projectId: "project-1" }),
    ).resolves.toEqual([]);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(
      "narrative_maintenance_inbox_list",
      { payload: { projectId: "project-1" } },
    );
  });

  it("maps the snake_case wire onto the camelCase allow-list", async () => {
    invokeMock.mockResolvedValue([
      {
        entry_kind: "consumer-freshness",
        consumer_kind: "proposal-revision",
        consumer_key: "rev-1",
        evidence_freshness: "source-missing",
        build_action: "rebuild",
        finding_key: "proposal-revision:rev-1",
        latest_observation: null,
        attention: null,
        is_snoozed_and_active: false,
      },
      {
        entry_kind: "terminal-failure",
        consumer_kind: "narrative-maintenance-failure",
        consumer_key: "work-1",
        evidence_freshness: null,
        build_action: null,
        finding_key: "narrative-maintenance-failure:work-1",
        latest_observation: null,
        attention: null,
        is_snoozed_and_active: false,
      },
    ]);
    await expect(
      narrativeMaintenanceInboxList({ projectId: "p" }),
    ).resolves.toEqual([
      {
        entryKind: "consumer-freshness",
        consumerKind: "proposal-revision",
        evidenceFreshness: "source-missing",
      },
      {
        entryKind: "terminal-failure",
        consumerKind: "narrative-maintenance-failure",
        evidenceFreshness: null,
      },
    ]);
  });

  it("rejects a wire that is not an array", async () => {
    invokeMock.mockResolvedValue({ entries: [] });
    await expect(
      narrativeMaintenanceInboxList({ projectId: "p" }),
    ).rejects.toThrow(/expected an array/);
  });
});

describe("parseMaintenanceInbox", () => {
  it("never reads free text or identity fields (allow-list only)", () => {
    const secret = "SECRET-REASON-TEXT";
    const [entry] = parseMaintenanceInbox([
      {
        entry_kind: "consumer-freshness",
        consumer_kind: "proposal-revision",
        consumer_key: "rev-1",
        evidence_freshness: "stale",
        attention: {
          reason: secret,
          actor_id: "actor-9",
          request_id: "req-9",
          payload_digest: "digest-9",
        },
        latest_observation: { observation_digest: "d", run_id: "run-1" },
      },
    ]);
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "consumerKind",
      "entryKind",
      "evidenceFreshness",
    ]);
    expect(JSON.stringify(entry)).not.toContain(secret);
    expect(JSON.stringify(entry)).not.toContain("actor-9");
    expect(JSON.stringify(entry)).not.toContain("rev-1");
  });

  it("turns unknown or missing values into 'unrecognized' instead of guessing", () => {
    expect(
      parseMaintenanceInbox([
        {
          entry_kind: "something-new",
          consumer_kind: "proposal-revision",
          evidence_freshness: "stale",
        },
        {
          entry_kind: "consumer-freshness",
          consumer_kind: "a-new-consumer",
          evidence_freshness: "fresher-than-fresh",
        },
        {
          entry_kind: "consumer-freshness",
          consumer_kind: "proposal-revision",
        },
        {
          entry_kind: "consumer-freshness",
          consumer_kind: "proposal-revision",
          evidence_freshness: 3,
        },
        "not-an-object",
        null,
      ]),
    ).toEqual([
      {
        entryKind: "unrecognized",
        consumerKind: "proposal-revision",
        evidenceFreshness: "stale",
      },
      {
        entryKind: "consumer-freshness",
        consumerKind: "unrecognized",
        evidenceFreshness: "unrecognized",
      },
      {
        entryKind: "consumer-freshness",
        consumerKind: "proposal-revision",
        evidenceFreshness: "unrecognized",
      },
      {
        entryKind: "consumer-freshness",
        consumerKind: "proposal-revision",
        evidenceFreshness: "unrecognized",
      },
      {
        entryKind: "unrecognized",
        consumerKind: "unrecognized",
        evidenceFreshness: "unrecognized",
      },
      {
        entryKind: "unrecognized",
        consumerKind: "unrecognized",
        evidenceFreshness: "unrecognized",
      },
    ]);
  });

  it("ignores any freshness a terminal-failure row carries", () => {
    expect(
      parseMaintenanceInbox([
        {
          entry_kind: "terminal-failure",
          consumer_kind: "narrative-maintenance-failure",
          evidence_freshness: "stale",
        },
      ]),
    ).toEqual([
      {
        entryKind: "terminal-failure",
        consumerKind: "narrative-maintenance-failure",
        evidenceFreshness: null,
      },
    ]);
  });
});
