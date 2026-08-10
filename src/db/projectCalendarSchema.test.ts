import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import contractJson from "./generated/schema-contract.json";
import { projectCalendar } from "./schema";

describe("projectCalendar.version schema", () => {
  it("maps the OCC token to an integer version column with a zero default", () => {
    const version = getTableColumns(projectCalendar).version;

    expect(version).toBeDefined();
    expect(version.name).toBe("version");
    expect(version.notNull).toBe(true);
    expect(version.default).toBe(0);
  });

  it("advances the physical schema contract to v5", () => {
    expect(contractJson.schemaVersion).toBe(5);
    expect(contractJson.tables.project_calendar.columns.version).toMatchObject({
      declaredType: "INTEGER",
      notNull: true,
      default: "0",
    });
  });
});
