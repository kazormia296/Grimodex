import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { AliasesField } from "./AliasesField";

interface AliasesChipProps {
  aliases: string[];
  onChange: (aliases: string[]) => void;
}

export function AliasesChip({ aliases, onChange }: AliasesChipProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-transparent px-2 py-[3px] text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="text-[11px] tracking-[0.04em]">
          {t("codex.aliasesLabel")}
        </span>
        <span className="rounded bg-muted/60 px-1 text-[10px] tabular-nums">
          {aliases.length}
        </span>
        <ChevronDown className="h-2.5 w-2.5 text-muted-foreground/70" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 min-w-[260px] rounded-lg border border-border bg-popover p-3 shadow-lg">
          <AliasesField
            label={t("codex.aliasesLabel")}
            aliases={aliases}
            onChange={onChange}
            variant="hero"
          />
        </div>
      )}
    </div>
  );
}
