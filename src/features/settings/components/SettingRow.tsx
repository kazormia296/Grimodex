interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  /**
   * When true the row's label/description are visually dimmed to signal
   * that the contained control is inert (e.g. a sub-setting whose master
   * toggle is OFF). The control itself is responsible for being `disabled`.
   */
  disabled?: boolean;
}

export function SettingRow({
  label,
  description,
  children,
  disabled = false,
}: SettingRowProps) {
  return (
    <div className="flex min-h-[36px] items-start justify-between gap-4 rounded px-1 py-1.5">
      <div
        className={`flex-1 min-w-0 ${disabled ? "opacity-50" : ""}`}
      >
        <div className="text-sm text-foreground">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
