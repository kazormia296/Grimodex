import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MutableRefObject, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { isNir1LocalTurnTerminal } from "@/application/chat/nir1LocalGenerationTurn";
import type { Nir1LocalTurnSnapshot } from "@/application/chat/nir1LocalGenerationTurn";
import {
  createNir1LocalConversation,
  listNir1LocalConversations,
  nir1LocalPurposeOfConversation,
  NIR1_LOCAL_READ_PAGE_ROWS,
  readNir1LocalConversation,
  type Nir1LocalConversationRow,
  type Nir1LocalConversationView,
  type Nir1LocalIpcError,
  type Nir1LocalPurpose,
  type Nir1LocalReason,
} from "./nir1LocalGenerationApi";
import {
  cancelNir1LocalGenerationOf,
  dispatchNir1LocalGeneration,
  useNir1LocalNotice,
  useNir1LocalTurn,
} from "./nir1LocalGenerationStore";
import {
  currentNir1LocalPurposeGate,
  useNir1LocalPurposeGate,
} from "./nir1LocalPolicyGate";
import { ensureNir1LocalGenerationTranslations } from "./nir1LocalGenerationTranslations";
import Nir1LocalDisclosure from "./Nir1LocalDisclosure";

ensureNir1LocalGenerationTranslations();

/** What ChatPanel hands over when a send is accepted (DR-DD1C-7). */
export interface Nir1LocalAcceptedSend {
  readonly conversationId: string;
  readonly sceneId: string;
}

export type Nir1LocalAcceptedHandler = (send: Nir1LocalAcceptedSend) => void;

export interface Nir1LocalGenerationPanelProps {
  /** The chat panel's active conversation. */
  readonly conversationId: string | null;
  /** The chat panel's scene. */
  readonly sceneId: string | null;
  /** The receiver ChatPanel calls after a send is accepted. */
  readonly acceptedRef: MutableRefObject<Nir1LocalAcceptedHandler | null>;
  /** Open a conversation in the chat panel (an ID Native returned). */
  readonly onOpenConversation: (conversationId: string) => void;
}

const PURPOSES: readonly Nir1LocalPurpose[] = ["writing", "review"];

type Outcome =
  | { readonly kind: "reason"; readonly reason: Nir1LocalReason }
  | { readonly kind: "ipc"; readonly error: Nir1LocalIpcError }
  | { readonly kind: "unknown" };

function outcomeOf(
  result:
    | { readonly status: "refused"; readonly reason: Nir1LocalReason }
    | { readonly status: "error"; readonly error: Nir1LocalIpcError }
    | { readonly status: "unknown" },
): Outcome {
  if (result.status === "refused") {
    return { kind: "reason", reason: result.reason };
  }
  if (result.status === "error") return { kind: "ipc", error: result.error };
  return { kind: "unknown" };
}

function OutcomeText({ outcome }: { readonly outcome: Outcome }) {
  const { t } = useTranslation();
  const text =
    outcome.kind === "reason"
      ? t(`nir1Local.reason.${outcome.reason}`)
      : outcome.kind === "ipc"
        ? t(`nir1Local.panel.ipc.${outcome.error}`)
        : t("nir1Local.panel.unknownAnswer");
  return (
    <p
      role="status"
      data-testid="nir1-local-outcome"
      data-nir1-local-reason={
        outcome.kind === "reason"
          ? outcome.reason
          : outcome.kind === "ipc"
            ? outcome.error
            : "unknown"
      }
      className="break-words text-destructive"
    >
      {text}
    </p>
  );
}

/**
 * The NIR-1 local generation screen in the chat panel (DD-1c): the
 * disclosure's placement 3, the route's conversations (create／list／read),
 * the generation of the active local conversation and its stop, and the
 * typed refusal reasons. A lazy chunk mounted only while
 * `NIR1_LOCAL_GENERATION_UI_ENABLED` is on.
 */
export default function Nir1LocalGenerationPanel({
  conversationId,
  sceneId,
  acceptedRef,
  onOpenConversation,
}: Nir1LocalGenerationPanelProps): ReactElement | null {
  const { t } = useTranslation();
  const activePurpose = nir1LocalPurposeOfConversation(conversationId);
  const localConversationId = activePurpose === null ? null : conversationId;

  // The receiver of accepted sends. One accepted send starts at most one
  // generation (DR-DD1C-6).
  const handled = useRef(new WeakSet<Nir1LocalAcceptedSend>());
  useEffect(() => {
    const receiver: Nir1LocalAcceptedHandler = (send) => {
      if (handled.current.has(send)) return;
      handled.current.add(send);
      const purpose = nir1LocalPurposeOfConversation(send.conversationId);
      if (purpose === null) return;
      dispatchNir1LocalGeneration(
        { purpose, conversationId: send.conversationId, sceneId: send.sceneId },
        currentNir1LocalPurposeGate(purpose),
      );
    };
    acceptedRef.current = receiver;
    return () => {
      if (acceptedRef.current === receiver) acceptedRef.current = null;
    };
  }, [acceptedRef]);

  const turn = useNir1LocalTurn(localConversationId);
  const notice = useNir1LocalNotice(localConversationId);
  const titleId = useId();

  return (
    <section
      aria-labelledby={titleId}
      data-testid="nir1-local-generation"
      className="space-y-2 px-3 pb-2 text-xs"
    >
      {localConversationId !== null && activePurpose !== null && (
        <>
          <Nir1LocalDisclosure placement={3} purpose={activePurpose} />
          <ActivePurposeGate purpose={activePurpose} />
          {turn && <TurnView turn={turn} />}
          {notice !== null && (
            <OutcomeText outcome={{ kind: "reason", reason: notice }} />
          )}
          <ConversationRows
            conversationId={localConversationId}
            refreshKey={
              turn && isNir1LocalTurnTerminal(turn.phase) ? turn : null
            }
          />
        </>
      )}
      <Conversations
        sceneId={sceneId}
        onOpenConversation={onOpenConversation}
      />
      <span id={titleId} className="sr-only">
        {t("nir1Local.panel.title")}
      </span>
    </section>
  );
}

function ActivePurposeGate({
  purpose,
}: {
  readonly purpose: Nir1LocalPurpose;
}) {
  const gate = useNir1LocalPurposeGate(purpose);
  if (gate.presentation === "hidden" || gate.presentation === "disabled") {
    return <OutcomeText outcome={{ kind: "reason", reason: gate.reason }} />;
  }
  return null;
}

function TurnView({ turn }: { readonly turn: Nir1LocalTurnSnapshot }) {
  const { t } = useTranslation();
  // The stop disappears once pressed; the focus moves to the state line.
  const status = useRef<HTMLParagraphElement>(null);
  return (
    <div
      data-testid="nir1-local-turn"
      data-nir1-local-phase={turn.phase}
      data-nir1-local-terminal-code={turn.terminalCode ?? undefined}
      className="space-y-1 rounded-md border border-border px-2 py-1.5"
    >
      <div className="flex items-center justify-between gap-2">
        <p
          ref={status}
          role="status"
          tabIndex={-1}
          data-testid="nir1-local-turn-status"
        >
          {t(`nir1Local.panel.phase.${turn.phase}`)}
        </p>
        {turn.canCancel && (
          <button
            type="button"
            data-testid="nir1-local-cancel"
            onClick={() => {
              status.current?.focus();
              cancelNir1LocalGenerationOf(turn.conversationId);
            }}
            className="shrink-0 rounded border border-border px-2 py-0.5 hover:bg-muted"
          >
            {t("nir1Local.panel.cancel")}
          </button>
        )}
      </div>
      {turn.reason !== null && (
        <OutcomeText outcome={{ kind: "reason", reason: turn.reason }} />
      )}
      {turn.ipcError !== null && (
        <OutcomeText outcome={{ kind: "ipc", error: turn.ipcError }} />
      )}
      {turn.text.length > 0 && (
        <p
          data-testid="nir1-local-turn-text"
          className="whitespace-pre-wrap break-words"
        >
          {turn.text}
        </p>
      )}
    </div>
  );
}

function ConversationRows({
  conversationId,
  refreshKey,
}: {
  readonly conversationId: string;
  readonly refreshKey: unknown;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<readonly Nir1LocalConversationRow[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const request = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const token = ++request.current;
      const result = await readNir1LocalConversation({
        conversationId,
        offset,
        limit: NIR1_LOCAL_READ_PAGE_ROWS,
      });
      // A read for another conversation or an older request is dropped.
      if (token !== request.current) return;
      if (result.status !== "ok") {
        setOutcome(outcomeOf(result));
        return;
      }
      setOutcome(null);
      setRows((previous) =>
        offset === 0 ? result.rows : [...previous, ...result.rows],
      );
      setTotal(result.total);
      setTruncated(result.truncated);
    },
    [conversationId],
  );

  useEffect(() => {
    setRows([]);
    setTotal(0);
    setTruncated(false);
    void load(0);
    return () => {
      request.current += 1;
    };
  }, [load, refreshKey]);

  return (
    <div data-testid="nir1-local-rows" className="space-y-1">
      <p className="text-muted-foreground">
        {t("nir1Local.panel.rows", { shown: rows.length, total })}
      </p>
      {outcome && <OutcomeText outcome={outcome} />}
      <ol className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.messageId}
            data-nir1-local-row-kind={row.kind}
            data-nir1-local-attempt-status={row.attemptStatus ?? undefined}
            data-nir1-local-unavailable={row.unavailable ?? undefined}
            className="rounded border border-border/60 px-2 py-1"
          >
            <span className="font-medium">
              {t(`nir1Local.panel.rowKind.${row.kind}`)}
            </span>
            {row.text === null ? (
              <p className="text-muted-foreground">
                {t("nir1Local.panel.unavailableRow")}
              </p>
            ) : (
              <p className="whitespace-pre-wrap break-words">{row.text}</p>
            )}
            {row.thinkingCount > 0 && (
              <p className="text-muted-foreground">
                {t("nir1Local.panel.thinkingCount", {
                  count: row.thinkingCount,
                })}
              </p>
            )}
          </li>
        ))}
      </ol>
      {(truncated || rows.length < total) && rows.length > 0 && (
        <button
          type="button"
          data-testid="nir1-local-load-more"
          onClick={() => void load(rows.length)}
          className="text-primary underline-offset-2 hover:underline"
        >
          {t("nir1Local.panel.loadMore")}
        </button>
      )}
    </div>
  );
}

function CreateButton({
  purpose,
  sceneId,
  busy,
  onCreate,
}: {
  readonly purpose: Nir1LocalPurpose;
  readonly sceneId: string | null;
  readonly busy: boolean;
  readonly onCreate: (purpose: Nir1LocalPurpose) => void;
}) {
  const { t } = useTranslation();
  const gate = useNir1LocalPurposeGate(purpose);
  // A purpose the policy turned off is hidden (deriveAiGate's "policy").
  if (gate.presentation === "hidden") return null;
  return (
    <span className="inline-flex flex-col gap-0.5">
      <button
        type="button"
        data-testid={`nir1-local-create-${purpose}`}
        disabled={gate.presentation !== "enabled" || sceneId === null || busy}
        onClick={() => onCreate(purpose)}
        className="rounded border border-border px-2 py-0.5 hover:bg-muted disabled:opacity-50"
      >
        {t(
          busy
            ? "nir1Local.panel.creating"
            : `nir1Local.panel.create.${purpose}`,
        )}
      </button>
      {gate.presentation === "disabled" && (
        <OutcomeText outcome={{ kind: "reason", reason: gate.reason }} />
      )}
    </span>
  );
}

function Conversations({
  sceneId,
  onOpenConversation,
}: {
  readonly sceneId: string | null;
  readonly onOpenConversation: (conversationId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [list, setList] = useState<{
    readonly conversations: readonly Nir1LocalConversationView[];
    readonly truncated: boolean;
  } | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [creating, setCreating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    // Set again on setup: React's development double effect runs the
    // cleanup once before the real mount (StrictMode).
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await listNir1LocalConversations();
    if (!mounted.current) return;
    if (result.status !== "ok") {
      setOutcome(outcomeOf(result));
      return;
    }
    setOutcome(null);
    setList({
      conversations: result.conversations,
      truncated: result.truncated,
    });
  }, []);

  const create = useCallback(
    async (purpose: Nir1LocalPurpose) => {
      if (sceneId === null || creating) return;
      setCreating(true);
      const result = await createNir1LocalConversation({ purpose, sceneId });
      if (!mounted.current) return;
      setCreating(false);
      if (result.status !== "created") {
        setOutcome(outcomeOf(result));
        return;
      }
      setOutcome(null);
      // The conversation ID comes from Native's answer only.
      onOpenConversation(result.conversation.conversationId);
      if (expanded) void refresh();
    },
    [creating, expanded, onOpenConversation, refresh, sceneId],
  );

  return (
    <div data-testid="nir1-local-conversations" className="space-y-1">
      <div className="flex flex-wrap items-start gap-1.5">
        {PURPOSES.map((purpose) => (
          <CreateButton
            key={purpose}
            purpose={purpose}
            sceneId={sceneId}
            busy={creating}
            onCreate={(value) => void create(value)}
          />
        ))}
        <button
          type="button"
          aria-expanded={expanded}
          data-testid="nir1-local-show-conversations"
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            if (next) void refresh();
          }}
          className="text-primary underline-offset-2 hover:underline"
        >
          {t("nir1Local.panel.showConversations")}
        </button>
      </div>
      {outcome && <OutcomeText outcome={outcome} />}
      {expanded && list && (
        <div>
          <p className="font-medium">{t("nir1Local.panel.conversations")}</p>
          {list.conversations.length === 0 ? (
            <p className="text-muted-foreground">
              {t("nir1Local.panel.noConversations")}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {list.conversations.map((conversation) => (
                <li
                  key={conversation.conversationId}
                  data-nir1-local-conversation={conversation.conversationId}
                  className="flex items-center justify-between gap-2"
                >
                  <span>
                    {t(`nir1Local.panel.purpose.${conversation.purpose}`)}{" "}
                    <span className="text-muted-foreground">
                      {conversation.createdAt === null
                        ? t("nir1Local.panel.createdAtUnknown")
                        : t("nir1Local.panel.createdAt", {
                            date: new Date(
                              conversation.createdAt,
                            ).toLocaleString(i18n.language),
                          })}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onOpenConversation(conversation.conversationId)
                    }
                    className="shrink-0 text-primary underline-offset-2 hover:underline"
                  >
                    {t("nir1Local.panel.open")}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {list.truncated && (
            <p className="text-muted-foreground">
              {t("nir1Local.panel.listTruncated")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
