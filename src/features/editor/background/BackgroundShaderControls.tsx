import { Switch } from "@/components/ui/switch";
import {
  SettingRow,
  useSettingRowA11y,
} from "@/features/settings/components/SettingRow";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  getPaperShaderDefinition,
  type PaperShaderControl,
  type PaperShaderProperty,
  type PaperShaderId,
} from "../zen/paperShaderCatalog";
import { useZenShaderConfig } from "../zen/useZenShaderConfig";

const PROPS_KEY = "editor.zenBackground.shaderProps";

function readAll(
  raw: string,
): Record<string, Record<string, PaperShaderProperty>> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, Record<string, PaperShaderProperty>>)
      : {};
  } catch {
    return {};
  }
}

function usePropertyWriter(shader: PaperShaderId) {
  const set = useSettingsStore((state) => state.set);
  return (key: string, value: PaperShaderProperty) => {
    const state = useSettingsStore.getState();
    const all = readAll(state.get(PROPS_KEY, "{}"));
    set(
      PROPS_KEY,
      JSON.stringify({
        ...all,
        [shader]: { ...all[shader], [key]: value },
      }),
    );
  };
}

function valueLabel(
  control: Extract<PaperShaderControl, { type: "slider" }>,
  value: number,
) {
  if (control.min === 0 && control.max === 1)
    return `${Math.round(value * 100)}%`;
  return Number.isInteger(control.step) ? String(value) : value.toFixed(2);
}

function PropertySlider({
  control,
  value,
  onChange,
}: {
  control: Extract<PaperShaderControl, { type: "slider" }>;
  value: number;
  onChange: (value: number) => void;
}) {
  const a11y = useSettingRowA11y();
  return (
    <div className="flex items-center gap-2">
      <input
        type="range"
        min={control.min}
        max={control.max}
        step={control.step}
        value={value}
        aria-labelledby={a11y?.labelId}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
      />
      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
        {valueLabel(control, value)}
      </span>
    </div>
  );
}

function PropertySelect({
  control,
  value,
  onChange,
}: {
  control: Extract<PaperShaderControl, { type: "select" }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const a11y = useSettingRowA11y();
  return (
    <select
      value={value}
      aria-labelledby={a11y?.labelId}
      onChange={(event) => onChange(event.target.value)}
      className="max-w-36 rounded-md border border-input bg-background px-2 py-1 text-sm"
    >
      {control.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function BackgroundShaderControls() {
  const config = useZenShaderConfig();
  const definition = getPaperShaderDefinition(config.shader);
  const write = usePropertyWriter(config.shader);
  const current = config.shaderProps[config.shader] ?? {};

  return (
    <>
      {definition.controls.map((control) => {
        const fallback = definition.defaults[control.key];
        const value = current[control.key] ?? fallback;
        return (
          <SettingRow key={control.key} label={control.label}>
            {control.type === "slider" ? (
              <PropertySlider
                control={control}
                value={typeof value === "number" ? value : control.min}
                onChange={(next) => write(control.key, next)}
              />
            ) : control.type === "select" ? (
              <PropertySelect
                control={control}
                value={typeof value === "string" ? value : control.options[0]!}
                onChange={(next) => write(control.key, next)}
              />
            ) : (
              <Switch
                size="sm"
                checked={typeof value === "boolean" ? value : false}
                onCheckedChange={(next) => write(control.key, next)}
              />
            )}
          </SettingRow>
        );
      })}
    </>
  );
}
