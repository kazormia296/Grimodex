import { useTranslation } from "react-i18next";
import type { ImportAdapterDescriptor } from "../adapters/adapterTypes";

interface Props {
  readonly adapters: readonly ImportAdapterDescriptor[];
  readonly selectedAdapterId: string | null;
  readonly onSelectAdapter: (adapterId: string) => void;
}

export function ImportSourceStep({
  adapters,
  selectedAdapterId,
  onSelectAdapter,
}: Props) {
  const { t } = useTranslation();

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="import-wizard-source-step"
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "import.wizard.sourceHint",
          "インポート元の形式を選びます（プレビュー）。",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {adapters.map((adapter) => (
          <button
            key={`${adapter.id}@${adapter.version}`}
            type="button"
            data-testid={`import-wizard-adapter-${adapter.id}`}
            onClick={() => onSelectAdapter(adapter.id)}
            className={`rounded px-3 py-1.5 text-xs ${
              selectedAdapterId === adapter.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {adapter.label}
          </button>
        ))}
      </div>
    </section>
  );
}
