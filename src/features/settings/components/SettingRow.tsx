import { createContext, useContext, useId, useMemo } from "react";

/**
 * SettingRow が行内の control へ label/description の要素 id を渡すための
 * context。control 側は {@link useSettingRowA11y} で受け取り、
 * aria-labelledby / aria-describedby として自身に付与する。
 * SettingRow の外で使われた control では null になる（付与しない）。
 */
interface SettingRowA11y {
  labelId: string;
  descriptionId?: string;
}

const SettingRowA11yContext = createContext<SettingRowA11y | null>(null);

export function useSettingRowA11y(): SettingRowA11y | null {
  return useContext(SettingRowA11yContext);
}

interface SettingRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
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
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = description ? `${id}-description` : undefined;
  const a11y = useMemo(
    () => ({ labelId, descriptionId }),
    [labelId, descriptionId],
  );

  return (
    <div className="flex min-h-[36px] items-start justify-between gap-4 rounded px-1 py-1.5">
      <div className={`flex-1 min-w-0 ${disabled ? "opacity-50" : ""}`}>
        <div id={labelId} className="text-sm text-foreground">
          {label}
        </div>
        {description && (
          <div
            id={descriptionId}
            className="mt-0.5 text-xs text-muted-foreground"
          >
            {description}
          </div>
        )}
      </div>
      <div className="flex-shrink-0">
        <SettingRowA11yContext.Provider value={a11y}>
          {children}
        </SettingRowA11yContext.Provider>
      </div>
    </div>
  );
}
