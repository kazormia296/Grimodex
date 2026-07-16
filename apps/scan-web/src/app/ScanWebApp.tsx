import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { parseEditorSeed, type EditorSeedV1 } from "@grimodex/scan-contract";
import {
  createMinimalJaBundle,
  createMinimalJaSeed,
} from "../fixtures/minimalJa";
import { ScanReport } from "../report/ScanReport";
import { ScanApiClient, type ScanHandle } from "../api/scanApiClient";
import { BrowserWorkspaceLauncher } from "./BrowserWorkspaceLauncher";
import { TurnstileWidget } from "./TurnstileWidget";

const BrowserScanEditor = lazy(() =>
  import("./BrowserScanEditor").then((module) => ({
    default: module.BrowserScanEditor,
  })),
);

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
  const bundle = useMemo(() => createMinimalJaBundle(), []);
  const turnstileSiteKey =
    import.meta.env.VITE_SCAN_TURNSTILE_SITE_KEY?.trim() ?? "";
  const turnstileRequired =
    (import.meta.env.VITE_SCAN_TURNSTILE_REQUIRED ??
      (import.meta.env.PROD ? "true" : "false")) === "true";
  const [turnstileToken, setTurnstileToken] = useState<string>();
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const [browserWorkspaceId, setBrowserWorkspaceId] = useState<string>();
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
  const [seed, setSeed] = useState<EditorSeedV1 | null>(null);
  const [liveBundle, setLiveBundle] = useState<typeof bundle | null>(null);
  const [scanHandle, setScanHandle] = useState<ScanHandle | null>(null);
  const [scanMode, setScanMode] = useState<"quick" | "full">("quick");
  const [scanState, setScanState] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [scanError, setScanError] = useState<string>();
  const [publicReportId, setPublicReportId] = useState<string>();
  const [publicReportBusy, setPublicReportBusy] = useState(false);
  const [feedback, setFeedback] = useState<
    Record<string, "intentional" | "rejected">
  >({});
  const remoteGenerationRef = useRef(0);
  const canUseFull = Boolean(fullAccessToken?.trim());
  const canUpload =
    Boolean(apiClient) && (!turnstileRequired || Boolean(turnstileToken));
  const activeBundle = useMemo(() => {
    const source = liveBundle ?? bundle;
    if (Object.keys(feedback).length === 0) return source;
    return {
      ...source,
      findings: source.findings.map((finding) => ({
        ...finding,
        status: feedback[finding.id] ?? finding.status,
      })),
    };
  }, [bundle, feedback, liveBundle]);
  const handleTurnstileToken = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);
  const handleTurnstileError = useCallback(() => {
    setTurnstileToken(undefined);
  }, []);
  if (seed) {
    return (
      <Suspense
        fallback={
          <main className="scan-browser-workspace">
            <p className="scan-muted">Browser workspace を読み込んでいます…</p>
          </main>
        }
      >
        <BrowserScanEditor
          seed={seed}
          workspaceId={browserWorkspaceId}
          onBack={() => {
            setSeed(null);
            setBrowserWorkspaceId(undefined);
          }}
        />
      </Suspense>
    );
  }
  const openEditor = async () => {
    if (apiClient && scanHandle) {
      const generation = remoteGenerationRef.current;
      const editorSeed = await apiClient.getEditorSeed(scanHandle);
      if (generation !== remoteGenerationRef.current) return;
      setBrowserWorkspaceId(undefined);
      setSeed(editorSeed);
      return;
    }
    const parsed = parseEditorSeed(createMinimalJaSeed());
    if (parsed.ok) setSeed(parsed.value);
  };
  const startScan = async (file: File) => {
    if (!apiClient) return;
    if (turnstileRequired && !turnstileToken) {
      setScanState("error");
      setScanError("Bot verification is required before scanning.");
      return;
    }
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
      <BrowserWorkspaceLauncher
        onOpenSeed={(nextSeed, workspaceId) => {
          remoteGenerationRef.current += 1;
          setScanHandle(null);
          setLiveBundle(nextSeed.bundle);
          setPublicReportId(undefined);
          setPublicReportBusy(false);
          setFeedback({});
          setBrowserWorkspaceId(workspaceId);
          setSeed(nextSeed);
        }}
      />
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
              if (file) void startScan(file);
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
        {scanError && <span className="scan-error">{scanError}</span>}
      </section>
      <ScanReport
        bundle={activeBundle}
        onOpenEditor={
          scanState === "running" || publicReportBusy
            ? undefined
            : () => void openEditor()
        }
        onPublishPublicReport={
          apiClient && scanHandle ? () => void publishPublicReport() : undefined
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
                setFeedback((current) => ({ ...current, [findingId]: status }));
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
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    });
              }
        }
      />
    </>
  );
}
