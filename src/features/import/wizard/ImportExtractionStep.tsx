interface Props {
  readonly codexCount: number;
  readonly snippetCount: number;
}

export function ImportExtractionStep({ codexCount, snippetCount }: Props) {
  return (
    <section className="flex flex-col gap-2" data-testid="import-wizard-extraction-step">
      <p className="text-xs text-muted-foreground">
        ナラティブ抽出（プレビュー）— AI 解析は未接続です。
      </p>
      <dl className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <dt className="text-muted-foreground">Codex 候補</dt>
          <dd>{codexCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">スニペット</dt>
          <dd>{snippetCount}</dd>
        </div>
      </dl>
    </section>
  );
}
