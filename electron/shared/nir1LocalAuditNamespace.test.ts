import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NIR1_LOCAL_AUDIT_ID_PREFIX,
  NIR1_LOCAL_AUDIT_PATH_IDS,
  NIR1_LOCAL_REVIEW_PATH_ID,
  NIR1_LOCAL_WRITING_PATH_ID,
  isNir1LocalAuditReservedId,
  isNir1LocalAuditReservedPathId,
  nir1LocalAuditReservedField,
} from "./nir1LocalAuditNamespace.js";

const here = dirname(fileURLToPath(import.meta.url));
const rustSource = readFileSync(
  join(
    here,
    "..",
    "..",
    "src-tauri",
    "crates",
    "grimodex-db",
    "src",
    "nir1_local_audit.rs",
  ),
  "utf8",
);

function rustConst(name: string): string {
  const match = new RegExp(`pub const ${name}: &str =\\s*"([^"]*)";`, "u").exec(
    rustSource,
  );
  if (match === null) {
    throw new Error(`Rust const ${name} not found in nir1_local_audit.rs`);
  }
  return match[1];
}

describe("NIR-1 local audit namespace", () => {
  it("TS の定数が Rust の定数と一致する（drift 検出）", () => {
    expect(NIR1_LOCAL_AUDIT_ID_PREFIX).toBe(
      rustConst("NIR1_LOCAL_AUDIT_ID_PREFIX"),
    );
    expect(NIR1_LOCAL_WRITING_PATH_ID).toBe(
      rustConst("NIR1_LOCAL_WRITING_PATH_ID"),
    );
    expect(NIR1_LOCAL_REVIEW_PATH_ID).toBe(
      rustConst("NIR1_LOCAL_REVIEW_PATH_ID"),
    );
    expect(NIR1_LOCAL_AUDIT_PATH_IDS).toEqual([
      NIR1_LOCAL_WRITING_PATH_ID,
      NIR1_LOCAL_REVIEW_PATH_ID,
    ]);
    // Rust の path 配列も同じ 2 件だけ。
    expect(rustSource).toMatch(
      /NIR1_LOCAL_AUDIT_PATH_IDS: \[&str; 2\] =\s*\[NIR1_LOCAL_WRITING_PATH_ID, NIR1_LOCAL_REVIEW_PATH_ID\];/u,
    );
  });

  it("前後の空白と ASCII の大文字小文字で予約を迂回できない", () => {
    for (const value of [
      "nir1-local-generation:x",
      "NIR1-LOCAL-GENERATION:x",
      "  nir1-local-generation:x",
      "\u0085nir1-local-generation:x",
      " nir1-local-generation:x\n",
    ]) {
      expect(isNir1LocalAuditReservedId(value), JSON.stringify(value)).toBe(
        true,
      );
    }
    for (const value of [
      "",
      "nir1-local-generation",
      "xnir1-local-generation:x",
      "nir1-local-gen:x",
      "execution-1",
      // 非 ASCII の case folding で一致させない。
      "NİR1-local-generation:x",
    ]) {
      expect(isNir1LocalAuditReservedId(value), JSON.stringify(value)).toBe(
        false,
      );
    }
    expect(
      isNir1LocalAuditReservedPathId(" NIR1_LOCAL_GENERATION_WRITING "),
    ).toBe(true);
    expect(
      isNir1LocalAuditReservedPathId("nir1_local_generation_writing2"),
    ).toBe(false);
  });

  it("4種の ID と path ID のどれが予約かを報告する", () => {
    const reserved = `${NIR1_LOCAL_AUDIT_ID_PREFIX}execution:a`;
    expect(
      nir1LocalAuditReservedField({ pathId: NIR1_LOCAL_REVIEW_PATH_ID }),
    ).toBe("pathId");
    expect(nir1LocalAuditReservedField({ eventId: reserved })).toBe("eventId");
    expect(nir1LocalAuditReservedField({ executionId: reserved })).toBe(
      "executionId",
    );
    expect(nir1LocalAuditReservedField({ operationId: reserved })).toBe(
      "operationId",
    );
    expect(nir1LocalAuditReservedField({ parentExecutionId: reserved })).toBe(
      "parentExecutionId",
    );
    expect(
      nir1LocalAuditReservedField({
        eventId: "e",
        executionId: "x",
        operationId: "o",
        parentExecutionId: null,
        pathId: "chat.direct",
      }),
    ).toBeNull();
  });
});
