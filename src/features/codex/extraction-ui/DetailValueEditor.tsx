import { useState } from "react";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";

export interface DetailValueEditorProps {
  readonly value: ProjectedDetailValue;
  readonly onChange?: (value: ProjectedDetailValue) => void;
  readonly disabled?: boolean;
}

/**
 * Minimal editor for projected Detail values (text / enum / entity / clear).
 */
export function DetailValueEditor({
  value,
  onChange,
  disabled = false,
}: DetailValueEditorProps) {
  const [kind, setKind] = useState<ProjectedDetailValue["kind"]>(value.kind);

  const textValue = value.kind === "text" ? value.text : "";
  const enumValue = value.kind === "enum" ? value.optionRef : "";
  const entityValue = value.kind === "entity" ? value.entityId : "";

  return (
    <div className="flex flex-col gap-1.5" data-testid="detail-value-editor">
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">値の種類</span>
        <select
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={kind}
          disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as ProjectedDetailValue["kind"];
            setKind(next);
            if (next === "clear") onChange?.({ kind: "clear" });
            else if (next === "text") onChange?.({ kind: "text", text: "" });
            else if (next === "enum")
              onChange?.({ kind: "enum", optionRef: "" });
            else onChange?.({ kind: "entity", entityId: "" });
          }}
          data-testid="detail-value-kind"
        >
          <option value="text">text</option>
          <option value="enum">enum</option>
          <option value="entity">entity</option>
          <option value="clear">clear</option>
        </select>
      </label>
      {kind === "text" && (
        <input
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={textValue}
          disabled={disabled}
          onChange={(event) =>
            onChange?.({ kind: "text", text: event.target.value })
          }
          data-testid="detail-value-text"
        />
      )}
      {kind === "enum" && (
        <input
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={enumValue}
          disabled={disabled}
          onChange={(event) =>
            onChange?.({ kind: "enum", optionRef: event.target.value })
          }
          data-testid="detail-value-enum"
        />
      )}
      {kind === "entity" && (
        <input
          className="rounded border border-input bg-background px-2 py-1 text-sm"
          value={entityValue}
          disabled={disabled}
          onChange={(event) =>
            onChange?.({ kind: "entity", entityId: event.target.value })
          }
          data-testid="detail-value-entity"
        />
      )}
    </div>
  );
}
