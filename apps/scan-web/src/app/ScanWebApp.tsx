import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildEditorHandoffUrl,
  type AiDataDisclosureV1,
} from "@grimodex/scan-contract";
import { createMinimalJaBundle } from "../fixtures/minimalJa";
import { ScanReport } from "../report/ScanReport";
import { ScanApiClient, type ScanHandle } from "../api/scanApiClient";
import { ScanAiConsentDialog } from "./ScanAiConsentDialog";
import { TurnstileWidget } from "./TurnstileWidget";

export interface ScanWebAppProps {
  /** Optional short-lived entitlement from the authenticated host. */
  fullAccessToken?: string;
}

export function rollbackFeedbackOverride(
  current: Record<string, "intentional" | "rejected">,
  findingId: string,
  failedStatus: "intentional" | "rejected",
  previousStatus: "intentional" | "rejected" | undefined,
): Record<string, "intentional" | "rejected"> {
  if (current[findingId] !== failedStatus) return current;
  const next = { ...current };
  if (previousStatus) next[findingId] = previousStatus;
  else delete next[findingId];
  return next;
}

export function ScanWebApp({ fullAccessToken }: ScanWebAppProps = {}) {
  const demoBundle = useMemo(() => createMinimalJaBundle(), []);
  const turnstileSiteKey =
    import.meta.env.VITE_SCAN_TURNSTILE_SITE_KEY?.trim() ?? "";
  const turnstileRequired =
    (import.meta.env.VITE_SCAN_TURNSTILE_REQUIRED ??
      (import.meta.env.PROD ? "true" : "false")) === "true";
  const editorBaseUrl =
    import.meta.env.VITE_EDITOR_BASE_URL?.trim() ||
    (import.meta.env.DEV
      ? "http://localhost:1430/editor"
      : "https://try.grimodex.app/editor");
  const [turnstileToken, setTurnstileToken] = useState<string>();
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const apiClient = useMemo(
    () =>
      import.meta.env.VITE_SCAN_API_BASE_URL
        ? new ScanApiClient({
            baseUrl: import.meta.env.VITE_SCAN_API_BASE_URL,
            turnstileToken,
            fullAccessToken,
          })
        : null,
    [fullAccessToken, turnstileToken],
  );
  const [liveBundle, setLiveBundle] = useState<typeof demoBundle | null>(null);
  const [scanHandle, setScanHandle] = useState<ScanHandle | null>(null);
  const [scanMode, setScanMode] = useState<"quick" | "full">("quick");
  const [scanState, setScanState] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [scanError, setScanError] = useState<string>();
  const [publicReportId, setPublicReportId] = useState<string>();
  const [publicReportBusy, setPublicReportBusy] = useState(false);
  const [editorLaunchBusy, setEditorLaunchBusy] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File>();
  const [scanDisclosure, setScanDisclosure] = useState<AiDataDisclosureV1>();
  const [disclosureBusy, setDisclosureBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    Record<string, "intentional" | "rejected">
  >({});
  const remoteGenerationRef = useRef(0);
  const demoMode = apiClient === null;
  const canUseFull = Boolean(fullAccessToken?.trim());
  const canUpload =
    Boolean(apiClient) &&
    (!turnstileRequired || Boolean(turnstileToken)) &&
    !disclosureBusy;
  const activeBundle = useMemo(() => {
    const source = liveBundle ?? (demoMode ? demoBundle : null);
    if (!source) return null;
    if (Object.keys(feedback).length === 0) return source;
    return {
      ...source,
      findings: source.findings.map((finding) => ({
        ...finding,
        status: feedback[finding.id] ?? finding.status,
      })),
    };
  }, [demoBundle, demoMode, feedback, liveBundle]);
  const handleTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);
  const handleTurnstileError = useCallback(() => {
    setTurnstileToken(undefined);
  }, []);
  const openEditor = async () => {
    setEditorLaunchBusy(true);
    setScanError(undefined);
    try {
      if (apiClient && scanHandle) {
        const generation = remoteGenerationRef.current;
        const editorToken = await apiClient.createEditorToken(scanHandle);
        if (generation !== remoteGenerationRef.current) return;
        window.location.assign(
          buildEditorHandoffUrl(editorBaseUrl, editorToken.token),
        );
        return;
      }
      window.location.assign(editorBaseUrl);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setEditorLaunchBusy(false);
    }
  };
  const requestScanConsent = async (file: File) => {
    if (!apiClient) return;
    if (turnstileRequired && !turnstileToken) {
      setScanState("error");
      setScanError("Bot verification is required before scanning.");
      return;
    }
    setDisclosureBusy(true);
    setScanError(undefined);
    try {
      const disclosure = await apiClient.getAiDisclosure("scan");
      setPendingUpload(file);
      setScanDisclosure(disclosure);
    } catch (cause) {
      setScanState("error");
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDisclosureBusy(false);
    }
  };
  const startScan = async (file: File, consentId: string) => {
    if (!apiClient) return;
    const generation = remoteGenerationRef.current + 1;
    remoteGenerationRef.current = generation;
    setFeedback({});
    setScanHandle(null);
    setLiveBundle(null);
    setPublicReportId(undefined);
    setPublicReportBusy(false);
    setTurnstileToken(undefined);
    setTurnstileResetKey((value) => value + 1);
    setScanState("running");
    setScanError(undefined);
    try {
      const handle = await apiClient.uploadSource(
        file,
        canUseFull ? scanMode : "quick",
        consentId,
      );
      if (generation !== remoteGenerationRef.current) return;
      const status = await apiClient.waitForCompletion(handle);
      if (generation !== remoteGenerationRef.current) return;
      if (status.status !== "completed")
        throw new Error(`Scan ended with ${status.status}`);
      const nextBundle = await apiClient.getReport(handle);
      if (generation !== remoteGenerationRef.current) return;
      // Commit remote ownership as one render state only after every required
      // artifact is available. A failed replacement scan must not mix its
      // handle with the prior report (or the demo fixture).
      setLiveBundle(nextBundle);
      setScanHandle(handle);
      setScanState("idle");
    } catch (cause) {
      if (generation !== remoteGenerationRef.current) return;
      setScanState("error");
      setScanError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const publishPublicReport = async () => {
    if (
      !apiClient ||
      !scanHandle ||
      !window.confirm(
        "本文の根拠と非公開メタデータを除いたレポートを公開しますか？",
      )
    )
      return;
    setPublicReportBusy(true);
    const generation = remoteGenerationRef.current;
    try {
      const published = await apiClient.publishPublicReport(scanHandle);
      if (generation !== remoteGenerationRef.current) return;
      setPublicReportId(published.publicReportId);
    } catch (cause) {
      if (generation !== remoteGenerationRef.current) return;
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === remoteGenerationRef.current)
        setPublicReportBusy(false);
    }
  };
  const unpublishPublicReport = async () => {
    if (!apiClient || !scanHandle) return;
    setPublicReportBusy(true);
    const generation = remoteGenerationRef.current;
    try {
      await apiClient.unpublishPublicReport(scanHandle);
      if (generation !== remoteGenerationRef.current) return;
      setPublicReportId(undefined);
    } catch (cause) {
      if (generation !== remoteGenerationRef.current) return;
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === remoteGenerationRef.current)
        setPublicReportBusy(false);
    }
  };
  return (
    <>
      <header className="scan-app-header">
        <a className="scan-brand" href="/" aria-label="Grimodex Scan">
          <img src="/icons/grimodex-scan.svg" alt="" />
          <span className="scan-brand__wordmark">Grimodex</span>
          <span className="scan-brand__product">Scan</span>
        </a>
        <nav aria-label="Grimodex products">
          <a className="scan-editor-link" href={editorBaseUrl}>
            Editorを単体で開く
          </a>
        </nav>
      </header>
      <section className="scan-toolbar" aria-label="Scan workflow">
        {apiClient && turnstileSiteKey && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            resetKey={turnstileResetKey}
            onToken={handleTurnstileToken}
            onError={handleTurnstileError}
          />
        )}
        {apiClient && turnstileRequired && !turnstileSiteKey && (
          <span className="scan-error">
            Turnstile site key is not configured.
          </span>
        )}
        <label>
          Scan mode
          <select
            value={canUseFull ? scanMode : "quick"}
            onChange={(event) =>
              setScanMode(event.target.value as "quick" | "full")
            }
            disabled={scanState === "running"}
          >
            <option value="quick">Quick</option>
            {canUseFull && <option value="full">Full</option>}
          </select>
        </label>
        <label className="scan-upload-control">
          Upload .txt / .md
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            disabled={!canUpload || scanState === "running" || publicReportBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void requestScanConsent(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {!apiClient && (
          <span className="scan-muted">
            Demo fixture（VITE_SCAN_API_BASE_URL未設定）
          </span>
        )}
        {scanState === "running" && <span>Scan実行中…</span>}
        {disclosureBusy && <span>AI利用ポリシーを確認中…</span>}
        {scanError && <span className="scan-error">{scanError}</span>}
      </section>
      {activeBundle ? (
        <ScanReport
          bundle={activeBundle}
          reportMode={demoMode ? "demo" : "private"}
          onOpenEditor={
            scanState === "running" || publicReportBusy
              ? undefined
              : () => void openEditor()
          }
          editorBusy={editorLaunchBusy}
          onPublishPublicReport={
            apiClient && scanHandle
              ? () => void publishPublicReport()
              : undefined
          }
          onUnpublishPublicReport={
            apiClient && scanHandle
              ? () => void unpublishPublicReport()
              : undefined
          }
          publicReportId={publicReportId}
          publicReportBusy={publicReportBusy}
          onFeedback={
            scanState === "running"
              ? undefined
              : (findingId, status) => {
                  const previousStatus = feedback[findingId];
                  const generation = remoteGenerationRef.current;
                  setFeedback((current) => ({
                    ...current,
                    [findingId]: status,
                  }));
                  if (apiClient && scanHandle)
                    void apiClient
                      .sendFindingFeedback(scanHandle, findingId, status)
                      .catch((cause) => {
                        if (generation !== remoteGenerationRef.current) return;
                        setFeedback((current) =>
                          rollbackFeedbackOverride(
                            current,
                            findingId,
                            status,
                            previousStatus,
                          ),
                        );
                        setScanError(
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                        );
                      });
                }
          }
        />
      ) : (
        <ScanReportState state={scanState} error={scanError} />
      )}
      {scanDisclosure && pendingUpload && (
        <ScanAiConsentDialog
          disclosure={scanDisclosure}
          onAccept={(consentId) => {
            const file = pendingUpload;
            setPendingUpload(undefined);
            setScanDisclosure(undefined);
            void startScan(file, consentId);
          }}
          onDecline={() => {
            setPendingUpload(undefined);
            setScanDisclosure(undefined);
          }}
        />
      )}
    </>
  );
}

function ScanReportState({
  state,
  error,
}: {
  state: "idle" | "running" | "error";
  error?: string;
}) {
  const content =
    state === "running"
      ? {
          label: "解析中",
          title: "原稿を解析しています…",
          description:
            "解析が完了するまで、この画面を開いたままお待ちください。",
        }
      : state === "error"
        ? {
            label: "エラー",
            title: "Scanを完了できませんでした",
            description:
              error ??
              "解析結果は作成されていません。内容を確認して、もう一度お試しください。",
          }
        : {
            label: "準備完了",
            title: "原稿をアップロードしてください",
            description:
              "まだ解析結果はありません。.txt または .md の原稿を選ぶとScanを開始できます。",
          };

  return (
    <main
      className="scan-report scan-report--state"
      data-testid="scan-report-state"
      aria-live={state === "error" ? "assertive" : "polite"}
    >
      <section className="scan-card scan-report-state">
        <p className="scan-eyebrow">Grimodex Scan · {content.label}</p>
        <h1>{content.title}</h1>
        <p className={state === "error" ? "scan-error" : "scan-muted"}>
          {content.description}
        </p>
      </section>
    </main>
  );
}
