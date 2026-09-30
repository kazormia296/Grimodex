import { useTranslation } from "react-i18next";
import { listImportDecoders } from "../../decoders/registry";
import "../../decoders/registerDefaults";

interface Props {
  readonly selectedDecoderId: string | null;
  readonly onSelectDecoder: (decoderId: string) => void;
}

export function GenericDecoderPicker({
  selectedDecoderId,
  onSelectDecoder,
}: Props) {
  const { t } = useTranslation();
  const decoders = listImportDecoders();

  return (
    <section
      className="flex flex-col gap-2"
      data-testid="generic-import-decoder-picker"
    >
      <p className="text-sm text-muted-foreground">
        {t(
          "import.generic.decoderPickerHint",
          "デコーダーは拡張子とマジックバイトから自動選択されます（プレビュー）。",
        )}
      </p>
      <div className="flex flex-wrap gap-1">
        {decoders.map((decoder) => (
          <button
            key={`${decoder.id}@${decoder.version}`}
            type="button"
            data-testid={`generic-decoder-${decoder.id}`}
            onClick={() => onSelectDecoder(decoder.id)}
            className={`rounded px-2 py-1 text-xs ${
              selectedDecoderId === decoder.id
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent"
            }`}
          >
            {decoder.label}
          </button>
        ))}
      </div>
    </section>
  );
}
