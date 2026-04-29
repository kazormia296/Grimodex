import { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";

type Variant = "compact" | "hero";

interface AliasesFieldProps {
  label: string;
  aliases: string[];
  onChange: (aliases: string[]) => void;
  fieldId?: string;
  /** "compact": label-above pill row (legacy). "hero": inline label + bordered chips (header). */
  variant?: Variant;
}

export function AliasesField({
  label,
  aliases,
  onChange,
  fieldId = "aliases",
  variant = "compact",
}: AliasesFieldProps) {
  const { t } = useTranslation();
  const [isAdding, setIsAdding] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAdd = () => {
    setIsAdding(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSubmit = () => {
    const trimmed = inputValue.trim();
    if (trimmed) {
      onChange([...aliases, trimmed]);
    }
    setInputValue("");
    setIsAdding(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "Escape") {
      setInputValue("");
      setIsAdding(false);
    }
  };

  const handleRemove = (index: number) => {
    onChange(aliases.filter((_, i) => i !== index));
  };

  if (variant === "hero") {
    const aliasChip = (alias: string, index: number) => (
      <span
        key={`alias-${index}`}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-muted/40 py-[3px] pl-[9px] pr-[4px] text-xs text-foreground"
      >
        {alias}
        <button
          type="button"
          data-testid={`${fieldId}-remove-${index}`}
          onClick={() => handleRemove(index)}
          className="rounded p-0.5 text-muted-foreground/70 transition-colors hover:text-destructive"
          aria-label={`Remove ${alias}`}
        >
          <X className="h-2.5 w-2.5" />
        </button>
      </span>
    );

    const labelEl = (
      <span className="text-[11px] tracking-[0.04em] text-muted-foreground/70">
        {label}
      </span>
    );

    // Keep the label glued to the first chip (or to the add-button when empty)
    // so the row never wraps with the label stranded on its own line.
    const firstChip = aliases.length > 0 ? aliasChip(aliases[0], 0) : null;

    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {labelEl}
          {firstChip}
        </span>
        {aliases.slice(1).map((alias, i) => aliasChip(alias, i + 1))}
        {isAdding ? (
          <input
            ref={inputRef}
            data-testid={`${fieldId}-input`}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSubmit}
            className="w-24 rounded border border-input bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            placeholder={t("codex.aliasPlaceholder")}
          />
        ) : (
          <button
            type="button"
            data-testid={`${fieldId}-add-button`}
            onClick={handleAdd}
            className="inline-flex items-center gap-1 rounded border border-dashed border-border bg-transparent px-2 py-[3px] text-xs text-muted-foreground/70 transition-colors hover:border-muted-foreground/60 hover:text-foreground"
          >
            <Plus className="h-2.5 w-2.5" />
            {t("codex.addAlias")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-1">
        {aliases.map((alias, index) => (
          <span
            key={index}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            {alias}
            <button
              type="button"
              data-testid={`${fieldId}-remove-${index}`}
              onClick={() => handleRemove(index)}
              className="ml-0.5 rounded-full hover:text-destructive"
              aria-label={`Remove ${alias}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </span>
        ))}
        {isAdding ? (
          <input
            ref={inputRef}
            data-testid={`${fieldId}-input`}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={handleSubmit}
            className="w-24 rounded border border-input bg-background px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
            placeholder={t("codex.aliasPlaceholder")}
          />
        ) : (
          <button
            type="button"
            data-testid={`${fieldId}-add-button`}
            onClick={handleAdd}
            className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    </div>
  );
}
