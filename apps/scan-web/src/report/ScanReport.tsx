import { useState } from "react";
import type {
  FindingStatus,
  ScanBundleV1,
  ScanFinding,
} from "@grimodex/scan-contract";

interface Props {
  bundle: ScanBundleV1;
  onOpenEditor?: () => void;
  onFeedback?: (
    findingId: string,
    status: Extract<FindingStatus, "intentional" | "rejected">,
  ) => void;
  onPublishPublicReport?: () => void;
  onUnpublishPublicReport?: () => void;
  publicReportId?: string;
  publicReportBusy?: boolean;
}

function statusLabel(status: FindingStatus): string {
  switch (status) {
    case "candidate":
      return "要確認";
    case "confirmed":
      return "確認済み";
    case "rejected":
      return "誤り";
    case "intentional":
      return "意図的";
  }
}

function EvidenceList({ finding }: { finding: ScanFinding }) {
  return (
    <details className="scan-evidence">
      <summary>根拠 {finding.evidence.length}件</summary>
      <ul>
        {finding.evidence.map((evidence) => (
          <li key={`${evidence.sectionId}:${evidence.paragraphId}`}>
            <code>{evidence.paragraphId}</code>
            {evidence.excerpt && <q>{evidence.excerpt}</q>}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ScanReport({
  bundle,
  onOpenEditor,
  onFeedback,
  onPublishPublicReport,
  onUnpublishPublicReport,
  publicReportId,
  publicReportBusy,
}: Props) {
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  return (
    <main className="scan-report" data-testid="scan-report">
      <header className="scan-report__header">
        <div>
          <p className="scan-eyebrow">Grimodex Scan · Private report</p>
          <h1>{bundle.source.title}</h1>
          <p className="scan-muted">
            {bundle.source.characterCount.toLocaleString()}文字 ·{" "}
            {bundle.source.sectionCount}章 · {bundle.source.paragraphCount}段落
          </p>
        </div>
        <div className="scan-report__actions">
          {onOpenEditor && (
            <button
              type="button"
              className="scan-primary"
              onClick={onOpenEditor}
            >
              この作品を編集する
            </button>
          )}
          {onPublishPublicReport && !publicReportId && (
            <button
              type="button"
              className="scan-secondary"
              onClick={onPublishPublicReport}
              disabled={publicReportBusy}
            >
              {publicReportBusy ? "公開処理中…" : "公開レポートを作成"}
            </button>
          )}
          {publicReportId && onUnpublishPublicReport && (
            <button
              type="button"
              className="scan-secondary"
              onClick={onUnpublishPublicReport}
              disabled={publicReportBusy}
            >
              {publicReportBusy ? "更新中…" : "公開を停止"}
            </button>
          )}
        </div>
      </header>
      {publicReportId && (
        <p className="scan-muted">
          公開レポートID: <code>{publicReportId}</code>
        </p>
      )}

      <section
        className="scan-card scan-overview"
        aria-labelledby="scan-overview-title"
      >
        <h2 id="scan-overview-title">概要</h2>
        {bundle.summary.premise && <p>{bundle.summary.premise}</p>}
        <div className="scan-chip-row">
          {bundle.summary.genreCandidates.map((genre) => (
            <span className="scan-chip" key={genre.value}>
              {genre.value}
            </span>
          ))}
        </div>
      </section>

      <div className="scan-report__grid">
        <section className="scan-card" aria-labelledby="scan-entities-title">
          <h2 id="scan-entities-title">登場人物・舞台</h2>
          <div className="scan-entity-list">
            {bundle.entities.map((entity) => (
              <article
                className="scan-entity"
                key={entity.id}
                data-testid="scan-entity-card"
              >
                <div>
                  <strong>{entity.name}</strong>
                  <span>{entity.type}</span>
                </div>
                {entity.summary && <p>{entity.summary}</p>}
                {entity.aliases.length > 0 && (
                  <small>別名: {entity.aliases.join("、")}</small>
                )}
              </article>
            ))}
          </div>
        </section>

        <section className="scan-card" aria-labelledby="scan-relations-title">
          <h2 id="scan-relations-title">関係</h2>
          <ul className="scan-list" data-testid="scan-relation-list">
            {bundle.relations.map((relation) => {
              const from =
                bundle.entities.find(
                  (entity) => entity.id === relation.fromEntityId,
                )?.name ?? relation.fromEntityId;
              const to =
                bundle.entities.find(
                  (entity) => entity.id === relation.toEntityId,
                )?.name ?? relation.toEntityId;
              return (
                <li key={relation.id}>
                  <strong>{from}</strong> → <strong>{to}</strong>
                  <span>{relation.label ?? relation.type}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <section className="scan-card" aria-labelledby="scan-phases-title">
        <h2 id="scan-phases-title">Phase候補</h2>
        <ol className="scan-phase-list">
          {bundle.phases.map((phase) => (
            <li key={phase.id}>
              <div>
                <strong>{phase.title}</strong>
                <span>{Math.round(phase.confidence * 100)}%</span>
              </div>
              {phase.summary && <p>{phase.summary}</p>}
              <small>根拠段落 {phase.anchors.length}件</small>
            </li>
          ))}
        </ol>
      </section>

      <section className="scan-card" aria-labelledby="scan-findings-title">
        <h2 id="scan-findings-title">設定・時系列の指摘</h2>
        <div className="scan-finding-list">
          {bundle.findings.map((finding) => (
            <article
              className={`scan-finding scan-finding--${finding.status}`}
              key={finding.id}
              data-testid="scan-finding"
            >
              <button
                type="button"
                className="scan-finding__toggle"
                onClick={() =>
                  setActiveFinding(
                    activeFinding === finding.id ? null : finding.id,
                  )
                }
              >
                <span className="scan-finding__status">
                  {statusLabel(finding.status)}
                </span>
                <strong>{finding.title}</strong>
                <span aria-hidden="true">
                  {activeFinding === finding.id ? "−" : "+"}
                </span>
              </button>
              {activeFinding === finding.id && (
                <div className="scan-finding__body">
                  <p>{finding.summary}</p>
                  <EvidenceList finding={finding} />
                  {finding.status === "candidate" && (
                    <div className="scan-finding__actions">
                      <button
                        type="button"
                        onClick={() => onFeedback?.(finding.id, "intentional")}
                      >
                        意図的として扱う
                      </button>
                      <button
                        type="button"
                        onClick={() => onFeedback?.(finding.id, "rejected")}
                      >
                        誤りとして扱う
                      </button>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
