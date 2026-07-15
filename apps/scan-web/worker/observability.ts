import type { WorkerExecutionContextLike } from "./env";

export type ScanObservationName =
  | "request_rejected"
  | "request_failed"
  | "workflow_started"
  | "workflow_completed"
  | "workflow_failed"
  | "funnel"
  | "retention_completed";

export interface ContentFreeObservation {
  event: ScanObservationName;
  route?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  scanIdHash?: string;
}

export type ScanFunnelStep =
  | "upload_intent_issued"
  | "source_uploaded"
  | "source_verified"
  | "scan_queued"
  | "scan_status_viewed"
  | "private_report_viewed"
  | "editor_token_issued"
  | "public_report_viewed"
  | "public_report_published"
  | "public_report_unpublished"
  | "scan_cancelled"
  | "scan_deleted";

/** Emits only operational fields; request bodies, filenames, titles and source text never enter logs. */
export function emitContentFreeObservation(
  context: WorkerExecutionContextLike | undefined,
  observation: ContentFreeObservation,
): void {
  const payload = {
    service: "grimodex-scan",
    timestamp: new Date().toISOString(),
    ...observation,
  } satisfies ContentFreeObservation & { service: string; timestamp: string };
  console.info(JSON.stringify(payload));
  context?.waitUntil(Promise.resolve());
}
