import type { ImportDiagnostic } from "../core/importDiagnostics";
import type { ImportSourcePackageDraft } from "../core/importSourcePackage";

interface Props {
  readonly draft: ImportSourcePackageDraft | null;
  readonly diagnostics: readonly ImportDiagnostic[];
}

export function ImportParsePreviewStep({ draft, diagnostics }: Props) {
  return (
    <section className="flex flex-col gap-3" data-testid="import-wizard-parse-preview-step">
      {!draft ? (
        <p className="text-sm text-muted-foreground">解析結果はまだありません。</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <dt className="text-muted-foreground">ノード</dt>
              <dd>{draft.nodes.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">ドキュメント</dt>
              <dd>{draft.documents.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Codex</dt>
              <dd>{draft.structure.codexEntries.length}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">スニペット</dt>
              <dd>{draft.structure.snippets.length}</dd>
            </div>
          </dl>
          {diagnostics.length > 0 && (
            <ul className="max-h-32 overflow-y-auto rounded border border-border p-2 text-xs">
              {diagnostics.map((d, index) => (
                <li key={`${d.code}-${index}`} className="text-muted-foreground">
                  [{d.severity}] {d.message}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
