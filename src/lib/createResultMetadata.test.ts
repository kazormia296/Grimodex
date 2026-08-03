import { describe, expect, it } from "vitest";
import {
  attachCreateResultMetadata,
  getCreateResultMetadata,
  isCreateResultEntityPresent,
} from "./createResultMetadata";

describe("createResultMetadata", () => {
  it("keeps native replay metadata without changing the enumerable row shape", () => {
    const row = attachCreateResultMetadata(
      { id: "entity-1" },
      {
        id: "entity-1",
        __idempotency: { replayed: true, entityPresent: false },
      },
    );

    expect(getCreateResultMetadata(row)).toEqual({
      replayed: true,
      entityPresent: false,
    });
    expect(isCreateResultEntityPresent(row)).toBe(false);
    expect(Object.keys(row)).toEqual(["id"]);
    expect({ ...row }).toEqual({ id: "entity-1" });
  });

  it("treats legacy/browser rows and malformed metadata as present", () => {
    expect(isCreateResultEntityPresent({ id: "legacy" })).toBe(true);
    const malformed = attachCreateResultMetadata(
      { id: "malformed" },
      { __idempotency: { replayed: "yes", entityPresent: false } },
    );
    expect(getCreateResultMetadata(malformed)).toBeUndefined();
    expect(isCreateResultEntityPresent(malformed)).toBe(true);
  });
});
