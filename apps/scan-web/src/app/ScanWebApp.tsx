import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildEditorHandoffUrl,
  type AiDataDisclosureV1,
} from "@grimodex/scan-contract";
import { createMinimalJaBundle } from "../fixtures/minimalJa";
import { ScanReport } from "../report/ScanReport";
import { ScanApiClient, type ScanHandle } from "../api/scanApiClient";
import { ScanAiConsentDialog } from "./ScanAiConsentDialog";
import { ScanDeleteDialog } from "./ScanDeleteDialog";
import {
  clearScanOwnership,
  currentScanOwnershipStorage,
  readScanOwnership,
  writeScanOwnership,
} from "./scanOwnershipStorage";
import { TurnstileWidget } from "./TurnstileWidget";
import { scanMessages } from "../i18n/scanMessages";
import {
  classifyScanError,
  scanErrorMessageForKind,
  type ScanErrorKind,
} from "../i18n/scanErrors";
import {
  currentBrowserLanguages,
  readScanLocalePreference,
  resolveScanLocale,
  writeScanLocalePreference,
  type ScanLocalePreference,
  type ScanWritingLanguagePreference,
} from "../i18n/scanLocale";

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
  const [localePreference, setLocalePreference] =
    useState<ScanLocalePreference>(() =>
      readScanLocalePreference(
        typeof localStorage === "undefined" ? null : localStorage,
      ),
    );
  const [browserLanguages, setBrowserLanguages] = useState(() =>
    currentBrowserLanguages(),
  );
  const locale = useMemo(
    () => resolveScanLocale(localePreference, browserLanguages),
    [browserLanguages, localePreference],
  );
  const copy = scanMessages(locale);
  const [writingLanguage, setWritingLanguage] =
    useState<ScanWritingLanguagePreference>("auto");
  const [reportWritingLanguageSource, setReportWritingLanguageSource] =
    useState<"detected" | "selected">("detected");

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (localePreference !== "auto") return;
    const handleLanguageChange = () =>
      setBrowserLanguages(currentBrowserLanguages());
    window.addEventListener("languagechange", handleLanguageChange);
    return () =>
      window.removeEventListener("languagechange", handleLanguageChange);
  }, [localePreference]);

  const changeLocalePreference = (preference: ScanLocalePreference) => {
    writeScanLocalePreference(
      preference,
      typeof localStorage === "undefined" ? null : localStorage,
    );
    if (preference === "auto") {
      setBrowserLanguages(currentBrowserLanguages());
    }
    setLocalePreference(preference);
  };
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
  const [scanHandle, setScanHandleState] = useState<ScanHandle | null>(() =>
    readScanOwnership(currentScanOwnershipStorage()),
  );
  const setScanHandle = useCallback((handle: ScanHandle | null) => {
    setScanHandleState(handle);
    const storage = currentScanOwnershipStorage();
    if (handle) writeScanOwnership(storage, handle);
    else clearScanOwnership(storage);
  }, []);
  const [scanMode, setScanMode] = useState<"quick" | "full">("quick");
  const [scanState, setScanState] = useState<"idle" | "running" | "error">(
    "idle",
  );
  const [scanError, setScanError] = useState<
    ScanErrorKind | "botVerification"
  >();
  const [publicReportId, setPublicReportId] = useState<string>();
  const [publicReportBusy, setPublicReportBusy] = useState(false);
  const [editorLaunchBusy, setEditorLaunchBusy] = useState(false);
  const [pendingUpload, setPendingUpload] = useState<File>();
  const [scanDisclosure, setScanDisclosure] = useState<AiDataDisclosureV1>();
  const [disclosureBusy, setDisclosureBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScanHandle | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteNotice, setDeleteNotice] = useState<"completed" | "pending">();
  const [feedback, setFeedback] = useState<
    Record<string, "intentional" | "rejected">
  >({});
  const remoteGenerationRef = useRef(0);
  const demoMode = apiClient === null;
  const canUseFull = Boolean(fullAccessToken?.trim());
  const canUpload =
    Boolean(apiClient) &&
    (!turnstileRequired || Boolean(turnstileToken)) &&
    !disclosureBusy &&
    !scanHandle &&
    !deleteTarget &&
    !deleteBusy;
  const scanErrorMessage = scanError
    ? scanError === "botVerification"
      ? copy.botVerificationRequired
      : scanErrorMessageForKind(scanError, locale)
    : undefined;
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
          buildEditorHandoffUrl(editorBaseUrl, editorToken.token, locale),
        );
        return;
      }
      window.location.assign(editorBaseUrl);
    } catch (cause) {
      setScanError(classifyScanError(cause));
    } finally {
      setEditorLaunchBusy(false);
    }
  };
  const requestScanConsent = (file: File) => {
    if (!apiClient || scanHandle || deleteTarget || deleteBusy) return;
    if (turnstileRequired && !turnstileToken) {
      setScanState("error");
      setScanError("botVerification");
      return;
    }
    setScanState("idle");
    setScanError(undefined);
    setScanDisclosure(undefined);
    setPendingUpload(file);
  };
  useEffect(() => {
    if (!apiClient || !pendingUpload) return;
    let active = true;
    setDisclosureBusy(true);
    setScanDisclosure(undefined);
    setScanError(undefined);
    void apiClient
      .getAiDisclosure("scan", locale)
      .then((disclosure) => {
        if (active) setScanDisclosure(disclosure);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setPendingUpload(undefined);
        setScanState("error");
        setScanError(classifyScanError(cause));
      })
      .finally(() => {
        if (active) setDisclosureBusy(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, locale, pendingUpload]);
  const startScan = async (file: File, consentId: string) => {
    if (!apiClient || scanHandle) return;
    const generation = remoteGenerationRef.current + 1;
    remoteGenerationRef.current = generation;
    setFeedback({});
    setScanHandle(null);
    setLiveBundle(null);
    setDeleteTarget(null);
    setDeleteBusy(false);
    setDeleteError(undefined);
    setDeleteNotice(undefined);
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
        writingLanguage,
      );
      if (generation !== remoteGenerationRef.current) return;
      // Retain ownership as soon as the Scan exists so users can delete an
      // in-progress or failed job instead of waiting for a report artifact.
      setScanHandle(handle);
      const status = await apiClient.waitForCompletion(handle);
      if (generation !== remoteGenerationRef.current) return;
      if (status.status !== "completed")
        throw new Error(
          locale === "ja"
            ? `Scanは ${status.status} で終了しました`
            : `Scan ended with ${status.status}`,
        );
      const nextBundle = await apiClient.getReport(handle);
      if (generation !== remoteGenerationRef.current) return;
      // Commit the report only after every required artifact is available.
      setLiveBundle(nextBundle);
      setReportWritingLanguageSource(
        writingLanguage === "auto" ? "detected" : "selected",
      );
      setScanState("idle");
    } catch (cause) {
      if (generation !== remoteGenerationRef.current) return;
      setScanState("error");
      setScanError(classifyScanError(cause));
    }
  };
  const requestDelete = () => {
    if (!apiClient || !scanHandle || editorLaunchBusy || deleteBusy) return;
    setPendingUpload(undefined);
    setScanDisclosure(undefined);
    setDisclosureBusy(false);
    setDeleteError(undefined);
    setDeleteTarget(scanHandle);
  };
  const confirmDelete = async () => {
    if (!apiClient || !deleteTarget || deleteBusy) return;
    const target = deleteTarget;
    const generation = remoteGenerationRef.current;
    setDeleteBusy(true);
    setDeleteError(undefined);
    try {
      const result = await apiClient.delete(target);
      if (generation !== remoteGenerationRef.current) return;

      // Invalidate polling, report fetches, publishing, Editor handoff, and
      // feedback work that still belongs to the deleted Scan.
      remoteGenerationRef.current = generation + 1;
      setFeedback({});
      setScanHandle(null);
      setLiveBundle(null);
      setPublicReportId(undefined);
      setPublicReportBusy(false);
      setEditorLaunchBusy(false);
      setPendingUpload(undefined);
      setScanDisclosure(undefined);
      setDisclosureBusy(false);
      setScanState("idle");
      setScanError(undefined);
      setDeleteTarget(null);
      setDeleteError(undefined);
      setDeleteNotice(result.cleanup);
    } catch {
      if (generation !== remoteGenerationRef.current) return;
      setDeleteError(copy.deletion.error);
    } finally {
      setDeleteBusy(false);
    }
  };
  const publishPublicReport = async () => {
    if (!apiClient || !scanHandle || !window.confirm(copy.publishConfirmation))
      return;
    setPublicReportBusy(true);
    const generation = remoteGenerationRef.current;
    try {
      const published = await apiClient.publishPublicReport(scanHandle);
      if (generation !== remoteGenerationRef.current) return;
      setPublicReportId(published.publicReportId);
    } catch (cause) {
      if (generation !== remoteGenerationRef.current) return;
      setScanError(classifyScanError(cause));
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
      setScanError(classifyScanError(cause));
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
        <nav aria-label={copy.productsNavigation}>
          <a className="scan-editor-link" href={editorBaseUrl}>
            {copy.openStandaloneEditor}
          </a>
        </nav>
      </header>
      <section className="scan-toolbar" aria-label={copy.workflow}>
        <label>
          {copy.interfaceLanguage}
          <select
            value={localePreference}
            onChange={(event) =>
              changeLocalePreference(event.target.value as ScanLocalePreference)
            }
          >
            <option value="auto">{copy.interfaceAuto}</option>
            <option value="ja">{copy.interfaceJapanese}</option>
            <option value="en">{copy.interfaceEnglish}</option>
          </select>
        </label>
        <label>
          {copy.writingLanguage}
          <select
            value={writingLanguage}
            onChange={(event) =>
              setWritingLanguage(
                event.target.value as ScanWritingLanguagePreference,
              )
            }
            disabled={scanState === "running"}
          >
            <option value="auto">{copy.writingAuto}</option>
            <option value="ja">{copy.writingJapanese}</option>
            <option value="en">{copy.writingEnglish}</option>
          </select>
        </label>
        {apiClient && turnstileSiteKey && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            resetKey={turnstileResetKey}
            locale={locale}
            onToken={handleTurnstileToken}
            onError={handleTurnstileError}
          />
        )}
        {apiClient && turnstileRequired && !turnstileSiteKey && (
          <span className="scan-error">{copy.turnstileMissing}</span>
        )}
        <label>
          {copy.scanMode}
          <select
            value={canUseFull ? scanMode : "quick"}
            onChange={(event) =>
              setScanMode(event.target.value as "quick" | "full")
            }
            disabled={scanState === "running"}
          >
            <option value="quick">{copy.quickMode}</option>
            {canUseFull && <option value="full">{copy.fullMode}</option>}
          </select>
        </label>
        <label className="scan-upload-control">
          {copy.upload}
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            disabled={!canUpload || scanState === "running" || publicReportBusy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) requestScanConsent(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        {!apiClient && <span className="scan-muted">{copy.demoFixture}</span>}
        {scanState === "running" && <span>{copy.running}</span>}
        {disclosureBusy && <span>{copy.policyLoading}</span>}
        {scanHandle && scanState !== "running" && (
          <span className="scan-muted">{copy.ownershipRetained}</span>
        )}
        {scanErrorMessage && (
          <span className="scan-error">{scanErrorMessage}</span>
        )}
      </section>
      {activeBundle ? (
        <ScanReport
          bundle={activeBundle}
          locale={locale}
          writingLanguageSource={reportWritingLanguageSource}
          reportMode={demoMode ? "demo" : "private"}
          onOpenEditor={
            scanState === "running" ||
            publicReportBusy ||
            deleteTarget ||
            deleteBusy
              ? undefined
              : () => void openEditor()
          }
          editorBusy={editorLaunchBusy}
          onPublishPublicReport={
            apiClient && scanHandle && !deleteTarget && !deleteBusy
              ? () => void publishPublicReport()
              : undefined
          }
          onUnpublishPublicReport={
            apiClient && scanHandle && !deleteTarget && !deleteBusy
              ? () => void unpublishPublicReport()
              : undefined
          }
          publicReportId={publicReportId}
          publicReportBusy={publicReportBusy}
          onDelete={
            apiClient &&
            scanHandle &&
            !editorLaunchBusy &&
            !deleteTarget
              ? requestDelete
              : undefined
          }
          deleteBusy={deleteBusy}
          onFeedback={
            scanState === "running" || Boolean(deleteTarget) || deleteBusy
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
                        setScanError(classifyScanError(cause));
                      });
                }
          }
        />
      ) : (
        <ScanReportState
          state={scanState}
          error={scanErrorMessage}
          locale={locale}
          notice={deleteNotice}
          onDelete={
            apiClient && scanHandle && !deleteTarget ? requestDelete : undefined
          }
          deleteBusy={deleteBusy}
        />
      )}
      {scanDisclosure && pendingUpload && (
        <ScanAiConsentDialog
          disclosure={scanDisclosure}
          locale={locale}
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
      {deleteTarget && (
        <ScanDeleteDialog
          locale={locale}
          busy={deleteBusy}
          error={deleteError}
          onCancel={() => {
            if (deleteBusy) return;
            setDeleteTarget(null);
            setDeleteError(undefined);
          }}
          onConfirm={() => void confirmDelete()}
        />
      )}
    </>
  );
}

function ScanReportState({
  state,
  error,
  locale,
  notice,
  onDelete,
  deleteBusy,
}: {
  state: "idle" | "running" | "error";
  error?: string;
  locale: "ja" | "en";
  notice?: "completed" | "pending";
  onDelete?: () => void;
  deleteBusy?: boolean;
}) {
  const copy = scanMessages(locale);
  const content =
    state === "running"
      ? copy.state.running
      : state === "error"
        ? {
            ...copy.state.error,
            description: error ?? copy.state.error.description,
          }
        : onDelete
          ? copy.state.owned
          : copy.state.idle;

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
        {notice && (
          <p className="scan-success" role="status">
            {notice === "completed"
              ? copy.deletion.successCompleted
              : copy.deletion.successPending}
          </p>
        )}
        {onDelete && (
          <button
            type="button"
            className="scan-danger"
            disabled={deleteBusy}
            onClick={onDelete}
          >
            {deleteBusy ? copy.deletion.deleting : copy.deletion.action}
          </button>
        )}
      </section>
    </main>
  );
}
