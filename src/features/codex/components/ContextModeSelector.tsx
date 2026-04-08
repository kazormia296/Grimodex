import type { CodexContextMode } from "@/db/schema";

const CONTEXT_MODE_OPTIONS: {
  value: CodexContextMode;
  label: string;
  description: string;
}[] = [
  {
    value: "always",
    label: "Always include",
    description: "Always inject into AI context",
  },
  {
    value: "mentioned",
    label: "When mentioned",
    description: "Inject when detected in scene",
  },
  {
    value: "suppress",
    label: "Manual only",
    description: "Only via manual pin",
  },
  {
    value: "hidden",
    label: "Exclude from AI",
    description: "Never inject into AI context",
  },
];

interface ContextModeSelectorProps {
  value: CodexContextMode;
  onChange: (value: CodexContextMode) => void;
}

export function ContextModeSelector({
  value,
  onChange,
}: ContextModeSelectorProps) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        Context
      </label>
      <select
        data-testid="context-mode-selector"
        value={value}
        onChange={(e) => onChange(e.target.value as CodexContextMode)}
        className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
      >
        {CONTEXT_MODE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label} — {opt.description}
          </option>
        ))}
      </select>
    </div>
  );
}
