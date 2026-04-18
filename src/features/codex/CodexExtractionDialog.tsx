import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useGSAP } from "@gsap/react";
import type { CodexEntryType } from "./api";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { celebrationBurst } from "@/lib/gsap";

interface CodexExtractionFormData {
  type: CodexEntryType;
  name: string;
  summary: string;
  tags: string;
  sourceChatMessageId: string;
}

interface CodexExtractionDialogProps {
  open: boolean;
  messageId: string;
  initialContent: string;
  messageRole?: "user" | "assistant";
  onSave: (data: CodexExtractionFormData) => void;
  onClose: () => void;
}

export function CodexExtractionDialog({
  open,
  messageId,
  initialContent,
  onSave,
  onClose,
}: CodexExtractionDialogProps) {
  const { t } = useTranslation();
  const [type, setType] = useState<CodexEntryType>("character");
  const [name, setName] = useState("");
  const [summary, setSummary] = useState(initialContent);
  const [tags, setTags] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { contextSafe } = useGSAP();

  const TYPE_OPTIONS: { value: CodexEntryType; label: string }[] = [
    { value: "character", label: t("codex.character") },
    { value: "location", label: t("codex.location") },
    { value: "item", label: t("codex.item") },
    { value: "lore", label: t("codex.lore") },
  ];

  useEffect(() => {
    if (open) {
      setType("character");
      setName("");
      setSummary(initialContent);
      setTags("");
    }
  }, [open, initialContent]);

  const handleSave = contextSafe(() => {
    if (!name.trim()) return;
    if (headingRef.current) celebrationBurst(headingRef.current);
    onSave({
      type,
      name: name.trim(),
      summary,
      tags,
      sourceChatMessageId: messageId,
    });
  });

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="w-full max-w-lg rounded-lg border border-border bg-background p-6 shadow-xl"
      testId="codex-extraction-dialog"
    >
      <h2 ref={headingRef} className="mb-4 text-lg font-semibold">
        {t("codex.extraction.title")}
      </h2>

      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium">
          {t("codex.extraction.type")}
        </label>
        <select
          data-testid="codex-type-select"
          value={type}
          onChange={(e) => setType(e.target.value as CodexEntryType)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        >
          {TYPE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium">
          {t("codex.extraction.name")}
        </label>
        <input
          data-testid="codex-name-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("codex.extraction.namePlaceholder")}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="mb-3">
        <label className="mb-1 block text-sm font-medium">
          {t("codex.extraction.summary")}
        </label>
        <textarea
          data-testid="codex-summary-textarea"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          rows={5}
          className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="mb-4">
        <label className="mb-1 block text-sm font-medium">
          {t("codex.extraction.tags")}
        </label>
        <input
          data-testid="codex-tags-input"
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder={t("codex.extraction.tagsPlaceholder")}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          data-testid="codex-cancel-button"
          onClick={onClose}
          className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          data-testid="codex-save-button"
          onClick={handleSave}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
        >
          {t("common.save")}
        </button>
      </div>
    </AnimatedOverlay>
  );
}
