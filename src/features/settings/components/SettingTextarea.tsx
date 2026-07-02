import { useSettingRowA11y } from "./SettingRow";

interface SettingTextareaProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
}

export function SettingTextarea({
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 4,
}: SettingTextareaProps) {
  const rowA11y = useSettingRowA11y();

  return (
    <div className="w-full">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-labelledby={rowA11y?.labelId}
        aria-describedby={rowA11y?.descriptionId}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={rows}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-y focus:outline-none"
      />
      {maxLength !== undefined && (
        <div className="mt-0.5 text-right text-xs text-muted-foreground">
          {value.length} / {maxLength}
        </div>
      )}
    </div>
  );
}
