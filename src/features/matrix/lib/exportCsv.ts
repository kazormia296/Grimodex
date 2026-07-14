import type { MatrixRow } from "./deriveRows";
import type { MatrixColumnOrHeader } from "./deriveColumns";
import type { CellInfo } from "./deriveCells";

// Prevent CSV formula injection: spreadsheets execute leading =/+/-/@/\t/\r as formulas.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvEscape(value: string): string {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  if (
    safe.includes(",") ||
    safe.includes('"') ||
    safe.includes("\n") ||
    safe.includes("\r")
  ) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Build a CSV string from the current Matrix view.
 *
 * Columns: scene_id, scene_title, <codex name>...
 * Rows: scene rows only (folders skipped), section headers skipped.
 * Cell codes: S=semantic link, B=body, R=relation, M=beat-mention
 * (combined, e.g. "SBRM").
 * Empty cell → quoted empty string.
 */
export function buildCsvString(
  rows: MatrixRow[],
  columns: MatrixColumnOrHeader[],
  cellMap: Map<string, CellInfo>,
): string {
  const dataCols = columns.filter((c) => !c.isSectionHeader);

  const header = [
    "scene_id",
    "scene_title",
    ...dataCols.map((c) => csvEscape(c.entry!.name)),
  ].join(",");

  const dataRows = rows
    .filter((r) => !r.isFolder)
    .map((r) => {
      const cells = dataCols.map((col) => {
        const info = cellMap.get(`${r.node.id}::${col.entry!.id}`);
        if (!info) return '""';
        let code = "";
        if (info.sources.has("semantic")) code += "S";
        if (info.sources.has("body")) code += "B";
        if (info.sources.has("relation")) code += "R";
        if (info.sources.has("beat")) code += "M";
        return code || '""';
      });
      return [csvEscape(r.node.id), csvEscape(r.node.title), ...cells].join(
        ",",
      );
    });

  return [header, ...dataRows].join("\n");
}
