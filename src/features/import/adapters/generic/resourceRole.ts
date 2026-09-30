/** Semantic role of a captured resource within a generic import package. */
export type GenericImportResourceRole =
  | "manuscript"
  | "outline"
  | "character-reference"
  | "world-reference"
  | "glossary"
  | "timeline-reference"
  | "plot-reference"
  | "snippet-library"
  | "chat-log"
  | "project-metadata"
  | "research-reference"
  | "attachment"
  | "ignore"
  | "unknown";

/** What to do with a classified resource during assembly / commit. */
export type ImportResourceDisposition =
  | "import-as-project-document"
  | "extract-structure-only"
  | "retain-source-only"
  | "import-and-extract"
  | "ignore";

export interface GenericResourceRoleAssignment {
  readonly resourceKey: string;
  readonly role: GenericImportResourceRole;
  readonly disposition: ImportResourceDisposition;
  readonly confidence: "rule" | "heuristic" | "manual" | "ai";
  readonly ruleId?: string;
}
