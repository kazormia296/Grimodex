import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { MarkdownDoc } from "./MarkdownDoc";

interface Props {
  title: string;
  description?: string;
  /** public/ 直下のファイル名 */
  src: string;
  defaultOpen?: boolean;
}

export function CollapsibleDocSection({
  title,
  description,
  src,
  defaultOpen = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="mb-4 rounded-md border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40"
        aria-expanded={open}
      >
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description && (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <ChevronRight
          className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${
            open ? "rotate-90" : ""
          }`}
        />
      </button>
      {open && (
        <div className="max-h-96 overflow-y-auto border-t border-border px-4 py-3">
          <MarkdownDoc src={src} />
        </div>
      )}
    </section>
  );
}
