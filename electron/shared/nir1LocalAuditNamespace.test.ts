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

  it("TS は Rust より広く拒否してよい（U+FEFF は TS だけが空白とみなす）", () => {
    // db の判定が最終。広い側に倒れても、派生 ID と完全一致しない限り先回りには使えない。
    expect(isNir1LocalAuditReservedId("\uFEFFnir1-local-generation:x")).toBe(
      true,
    );
  });

  it("途中に長い空白列を持つ入力でも線形時間で判定する（O(n^2) の回帰）", () => {
    const hostile = `x${" ".repeat(200_000)}x`;
    const started = performance.now();
    expect(isNir1LocalAuditReservedId(hostile)).toBe(false);
    expect(isNir1LocalAuditReservedPathId(hostile)).toBe(false);
    expect(
      nir1LocalAuditReservedField({
        eventId: hostile,
        executionId: hostile,
        operationId: hostile,
        parentExecutionId: hostile,
        pathId: hostile,
      }),
    ).toBeNull();
    // 空白だけの巨大な値、予約の前に巨大な空白があるが接頭辞が続く値も正しく判定する。
    const blank = " ".repeat(200_000);
    expect(isNir1LocalAuditReservedId(blank)).toBe(false);
    expect(
      isNir1LocalAuditReservedId(`${blank}nir1-local-generation:x${blank}`),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
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
