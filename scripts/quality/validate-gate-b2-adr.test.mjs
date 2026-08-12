import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_CHECKLIST_IDS,
  validateGateB2Adr,
} from "./validate-gate-b2-adr.mjs";

const DOMAINS = [
  "chronicle",
  "codex",
  "phase",
  "temporal",
  "plot",
  "foreshadow",
];

async function writePolicies(root, { checklist, classification }) {
  const policyDir = path.join(root, "policies/narrative");
  await mkdir(policyDir, { recursive: true });
  await writeFile(
    path.join(policyDir, "gate-b2-adr-checklist.json"),
    `${JSON.stringify(checklist, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(policyDir, "gate-b2-classification.json"),
    `${JSON.stringify(classification, null, 2)}\n`,
    "utf8",
  );
}

function validChecklist() {
  const checklist = {
    schemaVersion: 1,
    gateId: "gate-b2",
    items: REQUIRED_CHECKLIST_IDS.map((id) => ({
      id,
      section: "cross-cutting",
      text: `${id} contract`,
      status: "PASS",
      evidence: [
        {
          kind: "test",
          path: "proof/contract.test.ts",
          name: "contract boundary",
        },
      ],
    })),
  };
  Object.assign(
    checklist.items.find((item) => item.id === "B2-X02"),
    {
      status: "FAIL",
      reason: "Native Apply に read-set precondition がない",
      evidence: [],
    },
  );
  Object.assign(
    checklist.items.find((item) => item.id === "B2-X07"),
    {
      status: "OUT-OF-SCOPE",
      reason: "Maintenance ReStack で扱う",
      deferredTo: "#501",
      evidence: [],
    },
  );
  return checklist;
}

function validClassification() {
  return {
    schemaVersion: 1,
    gateId: "gate-b2",
    entries: DOMAINS.flatMap((domain) =>
      ["invariant", "strategy", "signal"].map((classification) => ({
        id: `${domain}-${classification}`,
        domain,
        classification,
        implementation: "proof/contract.test.ts",
        symbol: `${classification}${domain}`,
        tests: ["proof/contract.test.ts"],
      })),
    ),
  };
}

test("accepts complete checklist statuses, evidence, deferrals, and domains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-valid-"));
  try {
    await mkdir(path.join(root, "proof"), { recursive: true });
    await writeFile(path.join(root, "proof/contract.test.ts"), "export {};\n");
    await writePolicies(root, {
      checklist: validChecklist(),
      classification: validClassification(),
    });

    assert.deepEqual(await validateGateB2Adr({ repoRoot: root }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects missing or invalid checklist status and missing PASS evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-status-"));
  try {
    const checklist = validChecklist();
    checklist.items.find((item) => item.id === "B2-X08").status = "UNKNOWN";
    checklist.items.find((item) => item.id === "B2-X08").section = "unknown";
    delete checklist.items.find((item) => item.id === "B2-X02").status;
    checklist.items.find((item) => item.id === "B2-X04").evidence[0].path =
      "proof/missing.test.ts";
    await writePolicies(root, {
      checklist,
      classification: validClassification(),
    });

    const errors = await validateGateB2Adr({ repoRoot: root });
    assert.ok(errors.some((error) => /B2-X08.*invalid status/.test(error)));
    assert.ok(errors.some((error) => /B2-X08.*invalid section/.test(error)));
    assert.ok(errors.some((error) => /B2-X02.*missing status/.test(error)));
    assert.ok(
      errors.some((error) => /B2-X04.*evidence path does not exist/.test(error)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects PASS without evidence and FAIL/OUT-OF-SCOPE without rationale", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-reasons-"));
  try {
    const checklist = validChecklist();
    checklist.items.find((item) => item.id === "B2-X08").evidence = [];
    checklist.items.find((item) => item.id === "B2-X02").reason = "";
    checklist.items.find((item) => item.id === "B2-X07").reason = "";
    delete checklist.items.find((item) => item.id === "B2-X07").deferredTo;
    await writePolicies(root, {
      checklist,
      classification: validClassification(),
    });

    const errors = await validateGateB2Adr({ repoRoot: root });
    assert.ok(
      errors.some((error) => /B2-X08.*PASS requires evidence/.test(error)),
    );
    assert.ok(errors.some((error) => /B2-X02.*requires reason/.test(error)));
    assert.ok(errors.some((error) => /B2-X07.*requires reason/.test(error)));
    assert.ok(errors.some((error) => /B2-X07.*requires deferredTo/.test(error)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a checklist that omits a canonical ADR item", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-missing-"));
  try {
    await mkdir(path.join(root, "proof"), { recursive: true });
    await writeFile(path.join(root, "proof/contract.test.ts"), "export {};\n");
    const checklist = validChecklist();
    checklist.items = checklist.items.filter((item) => item.id !== "B2-X01");
    await writePolicies(root, {
      checklist,
      classification: validClassification(),
    });

    const errors = await validateGateB2Adr({ repoRoot: root });
    assert.ok(
      errors.some((error) => error === "checklist missing item: B2-X01"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects empty classifications and missing required domains", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-domains-"));
  try {
    await mkdir(path.join(root, "proof"), { recursive: true });
    await writeFile(path.join(root, "proof/contract.test.ts"), "export {};\n");
    await writePolicies(root, {
      checklist: validChecklist(),
      classification: {
        schemaVersion: 1,
        gateId: "gate-b2",
        entries: [],
      },
    });

    const emptyErrors = await validateGateB2Adr({ repoRoot: root });
    assert.ok(
      emptyErrors.some((error) => /classification entries must not be empty/.test(error)),
    );

    await writePolicies(root, {
      checklist: validChecklist(),
      classification: {
        schemaVersion: 1,
        gateId: "gate-b2",
        entries: [validClassification().entries[0]],
      },
    });
    const missingErrors = await validateGateB2Adr({ repoRoot: root });
    for (const domain of DOMAINS.slice(1)) {
      assert.ok(
        missingErrors.some(
          (error) => error === `classification missing domain: ${domain}`,
        ),
      );
    }
    assert.ok(
      missingErrors.some(
        (error) => error === "classification missing chronicle strategy",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects classification implementation and test paths that do not exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gate-b2-adr-paths-"));
  try {
    await mkdir(path.join(root, "proof"), { recursive: true });
    await writeFile(path.join(root, "proof/contract.test.ts"), "export {};\n");
    const classification = validClassification();
    classification.entries[0].implementation = "proof/missing.ts";
    classification.entries[1].tests = ["proof/missing.test.ts"];
    await writePolicies(root, {
      checklist: validChecklist(),
      classification,
    });

    const errors = await validateGateB2Adr({ repoRoot: root });
    assert.ok(
      errors.some((error) => /implementation path does not exist/.test(error)),
    );
    assert.ok(errors.some((error) => /test path does not exist/.test(error)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
