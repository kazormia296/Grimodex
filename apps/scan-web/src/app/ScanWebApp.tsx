import { useCallback, useMemo, useState } from "react";
import { parseEditorSeed, type EditorSeedV1 } from "@grimodex/scan-contract";
import {
  createMinimalJaBundle,
  createMinimalJaSeed,
} from "../fixtures/minimalJa";
import { ScanReport } from "../report/ScanReport";
import { ScanApiClient, type ScanHandle } from "../api/scanApiClient";
import { BrowserScanEditor } from "./BrowserScanEditor";
import { BrowserWorkspaceLauncher } from "./BrowserWorkspaceLauncher";
import { TurnstileWidget } from "./TurnstileWidget";

export interface ScanWebAppProps {
  /** Optional short-lived entitlement from the authenticated host. */
  fullAccessToken?: string;
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
      <BrowserScanEditor
        seed={seed}
        workspaceId={browserWorkspaceId}
        onBack={() => {
          setSeed(null);
          setBrowserWorkspaceId(undefined);
        }}
      />
    );
  }
  const openEditor = async () => {
    if (apiClient && scanHandle) {
      const editorSeed = await apiClient.getEditorSeed(scanHandle);
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
    setFeedback({});
    setTurnstileToken(undefined);
    setTurnstileResetKey((value) => value + 1);
    setScanState("running");
    setScanError(undefined);
    try {
      const handle = await apiClient.uploadSource(
        file,
        canUseFull ? scanMode : "quick",
      );
      setScanHandle(handle);
      setPublicReportId(undefined);
      const status = await apiClient.waitForCompletion(handle);
      if (status.status !== "completed")
        throw new Error(`Scan ended with ${status.status}`);
      setLiveBundle(await apiClient.getReport(handle));
      setScanState("idle");
    } catch (cause) {
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
    try {
      const published = await apiClient.publishPublicReport(scanHandle);
      setPublicReportId(published.publicReportId);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPublicReportBusy(false);
    }
  };
  const unpublishPublicReport = async () => {
    if (!apiClient || !scanHandle) return;
    setPublicReportBusy(true);
    try {
      await apiClient.unpublishPublicReport(scanHandle);
      setPublicReportId(undefined);
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPublicReportBusy(false);
    }
  };
  return (
    <>
      <BrowserWorkspaceLauncher
        onOpenSeed={(nextSeed, workspaceId) => {
          setLiveBundle(nextSeed.bundle);
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
            disabled={!canUpload || scanState === "running"}
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
        onOpenEditor={() => void openEditor()}
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
        onFeedback={(findingId, status) => {
          setFeedback((current) => ({ ...current, [findingId]: status }));
          if (apiClient && scanHandle)
            void apiClient
              .sendFindingFeedback(scanHandle, findingId, status)
              .catch((cause) => {
                setScanError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              });
        }}
      />
    </>
  );
}
