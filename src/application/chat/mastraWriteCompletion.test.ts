import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import initSqlJs, { type Database } from "sql.js";
import type { MastraAgentTurnStartRequest } from "@/../electron/shared/mastraAgentTurnWire";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import {
  cancelMastraAgentTurn,
  startMastraAgentTurn,
} from "@/lib/mastraAgentTurn";

const mock = vi.hoisted(() => ({
  invoke: vi.fn(),
  control: vi.fn(),
  listen: vi.fn(),
  remove: vi.fn(),
  project: vi.fn(),
  codex: vi.fn(),
  foreshadow: vi.fn(),
  snippet: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock("@/lib/shell", () => ({ isElectron: () => true }));
vi.mock("@/lib/tauri", () => ({
  invoke: mock.invoke,
  invokeMastraAgentTurnControl: mock.control,
  listen: mock.listen,
  isD2aEgressDenied: () => false,
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: { subscribe: mock.subscribe },
}));
vi.mock("@/features/timelapse/recorder", () => ({
  getRecorderSessionId: () => "writer",
}));
vi.mock("@/features/agent-writes/event", () => ({
  projectChronicleWrite: mock.project,
}));

vi.mock("@/features/agent-writes/codex", () => ({
  projectCodexWrite: mock.codex,
}));
vi.mock("@/features/agent-writes/foreshadow", () => ({
  projectMastraForeshadowWrite: mock.foreshadow,
}));
vi.mock("@/features/agent-writes/snippet", () => ({
  projectSnippetWrite: mock.snippet,
}));
const request: Omit<MastraAgentTurnStartRequest, "writerSessionId"> = {
  turnId: "8f14e45f-ceea-467e-a5d4-1b9c6d0e2f3a",
  projectId: "p",
  chatSessionId: "session",
  chatMessageId: "m",
  currentSceneId: null,
  messages: [],
  route: {
    provider: "openai",
    model: null,
    endpointId: null,
    apiVariant: null,
    expectedOllamaEndpoint: null,
    thinking: null,
    effort: null,
    reasoningEnabled: null,
    reasoningEffort: null,
    webSearch: null,
  },
  systemCacheSegments: null,
  systemVolatileTail: null,
  fullyInjectedIds: [],
  loop: {
    tokenBudget: 1000,
    maxToolCalls: 10,
    maxUserQuestions: 3,
    contextWindow: 10000,
    requestMaxOutputTokens: 100,
    language: "ja",
    controlMessages: {
      callLimitMessage: "calls",
      tokenBudgetMessage: "tokens",
      userQuestionLimitMessage: "questions",
    },
    fallbackSystem: "system",
  },
  tools: [
    "create_event",
    "update_event",
    "delete_event",
    "stamp_scene_event",
    "unstamp_scene_event",
    "set_event_participants",
    "add_event_relation",
    "remove_event_relation",
    "create_codex_entry",
    "update_codex_entry",
    "create_foreshadow",
    "update_foreshadow",
    "create_snippet",
  ],
};

let database: Database;
let emit: (receipt: unknown) => void;
let switchProject: (value: { currentProjectId: string }) => void;
let onStart: () => void;
let nativeEnd: Promise<void> | undefined;
let readGate: Promise<void> | undefined;
let onRead: (() => void) | undefined;
let version: number | null;
const cases = [
  ["event.create", "agent_event_create", "Create"],
  ["event.update", "agent_event_update", "Update"],
  ["event.delete", "agent_event_delete", "Delete"],
  ["event.stamp", "agent_scene_event_link", "Update"],
  ["event.unstamp", "agent_scene_event_unlink", "Update"],
  ["event.participants", "agent_event_set_participants", "Update"],
  ["event.relation_add", "agent_event_relation_add", "Update"],
  ["event.relation_remove", "agent_event_relation_remove", "Update"],
];

function insertReceipt(
  id: string,
  op = "event.update",
  project = "p",
  session = "writer",
  message = "m",
  fields: readonly string[] = [],
) {
  const domain = op.startsWith("entry.") ? "codex" : op.split(".")[0];
  const kind = domain === "codex" ? "codex_entry" : domain;
  database.run("INSERT INTO undo_journal VALUES (?,?,?,?,?,?)", [
    id,
    project,
    "target",
    kind,
    "in-app-agent",
    id,
  ]);
  database.run("INSERT INTO change_events VALUES (?,?,?,?,?,?,?,?)", [
    id,
    project,
    "target",
    domain,
    kind,
    op,
    session,
    JSON.stringify({
      authorityEvidence: { provenance: { chatMessageId: message } },
      fields,
    }),
  ]);
}

function deliver(id: string) {
  emit({ targetId: "target", undoId: id });
}

beforeAll(async () => {
  const SQL = await initSqlJs();
  database = new SQL.Database();
  database.run(`CREATE TABLE undo_journal (id TEXT PRIMARY KEY, project_id TEXT, entity_id TEXT, entity_kind TEXT, surface TEXT, change_event_uid TEXT);
    CREATE TABLE change_events (event_uid TEXT, project_id TEXT, entity_id TEXT, domain TEXT, entity_type TEXT, op_type TEXT, session_id TEXT, payload TEXT);
    CREATE TABLE codex_entries (id TEXT PRIMARY KEY, project_id TEXT); CREATE TABLE snippets (id TEXT PRIMARY KEY, project_id TEXT);`);
});
beforeEach(() => {
  vi.clearAllMocks();
  database.run("DELETE FROM undo_journal; DELETE FROM change_events");
  for (const table of ["codex_entries", "snippets"]) {
    database.run("INSERT OR REPLACE INTO " + table + " VALUES ('target', 'p')");
  }
  setCurrentWorkspaceIdentity({ path: "/fixture", openRevision: 1 });
  publishCurrentProjectId("p");
  nativeEnd = undefined;
  readGate = undefined;
  onRead = undefined;
  version = 1;
  mock.subscribe.mockImplementation((fn) => {
    switchProject = fn;
    return () => {};
  });
  mock.listen.mockImplementation(async (channel, fn) => {
    expect(channel).toBe("mastra:agent-write-completed");
    emit = fn;
    return mock.remove;
  });
  mock.invoke.mockImplementation(async (command, args, guard) => {
    if (command === "mastra_agent_turn_start") {
      if (guard && !guard.allow()) return guard.cancelledValue;
      onStart();
      await nativeEnd;
      return {
        status: "completed",
        turnId: request.turnId,
        executionId: "exec",
        response: { blocks: [], stopReason: "end_turn" },
      };
    }
    if (command === "event_get_version") return version;
    expect(command).toBe("db_execute");
    onRead?.();
    await readGate;
    const stmt = database.prepare(args.sql);
    try {
      stmt.bind(args.params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return { rows };
    } finally {
      stmt.free();
    }
  });
});
afterEach(() => {
  publishCurrentProjectId(null);
  setCurrentWorkspaceIdentity(null);
});

describe("Mastra の完了通知", () => {
  it("開始窓の全8操作を順に1度ずつ反映して、終了後の通知は捨てる", async () => {
    for (const [op] of cases) insertReceipt(op, op);
    onStart = () => {
      for (const [op] of cases) {
        deliver(op);
        deliver(op);
      }
    };
    await startMastraAgentTurn(request);
    deliver("event.create");
    expect(mock.project.mock.calls).toEqual(
      cases.map(([op, command, label]) => [
        command,
        { entityId: "target", undoJournalId: op },
        "chronicle.agentHistory" + label,
      ]),
    );
    expect(mock.remove).toHaveBeenCalledOnce();
  });

  it("renderer 自身が処理する構成変更と本文提案だけでは通知を購読しない", async () => {
    onStart = () => {};
    await startMastraAgentTurn({
      ...request,
      tools: ["apply_ai_tree_plan", "propose_scene_body"],
    });
    expect(mock.listen).not.toHaveBeenCalled();
    expect(mock.project).not.toHaveBeenCalled();
  });

  it("Codex・伏線・スニペットの既存行を照合し、名前・別名の変更だけをIMEへ渡す", async () => {
    insertReceipt("codex", "entry.create");
    insertReceipt("changed-name", "entry.update", "p", "writer", "m", ["name"]);
    insertReceipt("changed-alias", "entry.update", "p", "writer", "m", [
      "aliases",
    ]);
    insertReceipt("changed-other", "entry.update", "p", "writer", "m", [
      "notes",
    ]);
    insertReceipt("hint", "foreshadow.create");
    insertReceipt("hint-update", "foreshadow.update");
    insertReceipt("snippet", "snippet.create");
    onStart = () => {
      for (const id of [
        "codex",
        "changed-name",
        "changed-alias",
        "changed-other",
        "hint",
        "hint-update",
        "snippet",
      ]) {
        deliver(id);
        deliver(id);
      }
    };
    await startMastraAgentTurn(request);
    const live = expect.any(Function);
    expect(mock.codex.mock.calls).toEqual([
      ["create_codex_entry", "p", "target", "codex", true, live],
      ["update_codex_entry", "p", "target", "changed-name", true, live],
      ["update_codex_entry", "p", "target", "changed-alias", true, live],
      ["update_codex_entry", "p", "target", "changed-other", false, live],
    ]);
    expect(mock.foreshadow.mock.calls).toEqual([
      ["create_foreshadow", "p", "target", "hint", live],
      ["update_foreshadow", "p", "target", "hint-update", live],
    ]);
    expect(mock.snippet).toHaveBeenCalledExactlyOnceWith(
      "p",
      "target",
      "snippet",
      live,
    );
  });

  it("別ドメインの後続通知は先行する再読込の終了を待つ", async () => {
    insertReceipt("codex", "entry.create");
    insertReceipt("snippet", "snippet.create");
    let release!: () => void;
    let entered!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    mock.codex.mockImplementationOnce(() => {
      entered();
      return slow;
    });
    onStart = () => {
      deliver("codex");
      deliver("snippet");
    };
    const run = startMastraAgentTurn(request);
    await started;
    expect(mock.snippet).not.toHaveBeenCalled();
    release();
    await run;
    expect(mock.snippet).toHaveBeenCalledOnce();
  });

  it("投影の失敗を適用済みと見なさず、次に届いた同じ通知で再読込できる", async () => {
    insertReceipt("snippet", "snippet.create");
    mock.snippet.mockRejectedValueOnce(new Error("read failed"));
    onStart = () => {
      deliver("snippet");
      deliver("snippet");
      deliver("snippet");
    };
    await startMastraAgentTurn(request);
    expect(mock.snippet).toHaveBeenCalledTimes(2);
  });

  it("削除済み対象、別作品の同じID、履歴と更新の種別不一致を投影しない", async () => {
    insertReceipt("removed", "entry.create");
    insertReceipt("other-project", "snippet.create");
    insertReceipt("mismatch", "foreshadow.create");
    database.run("DELETE FROM codex_entries");
    database.run("UPDATE snippets SET project_id='elsewhere'");
    database.run(
      "UPDATE change_events SET entity_type='codex_entry' WHERE event_uid='mismatch'",
    );
    onStart = () => {
      deliver("removed");
      deliver("other-project");
      deliver("mismatch");
    };
    await startMastraAgentTurn(request);
    expect(mock.codex).not.toHaveBeenCalled();
    expect(mock.snippet).not.toHaveBeenCalled();
    expect(mock.foreshadow).not.toHaveBeenCalled();
  });

  it("別作品・別セッション・別返信・別対象・未宣言の操作を反映しない", async () => {
    insertReceipt("project", undefined, "other");
    insertReceipt("session", undefined, "p", "other");
    insertReceipt("reply", undefined, "p", "writer", "other");
    insertReceipt("undeclared", "event.delete");
    insertReceipt("wrong-target");
    insertReceipt("valid");
    onStart = () => {
      for (const id of ["project", "session", "reply", "undeclared"])
        deliver(id);
      emit({ targetId: "other", undoId: "wrong-target" });
      emit({ targetId: "target", undoId: "wrong-target", body: "extra" });
      deliver("valid");
    };
    await startMastraAgentTurn({ ...request, tools: ["update_event"] });
    expect(mock.project).toHaveBeenCalledExactlyOnceWith(
      "agent_event_update",
      { entityId: "target", undoJournalId: "valid" },
      "chronicle.agentHistoryUpdate",
    );
  });

  it("作者の停止操作と競合した確定済みの変更を、開始処理の終了まで元の窓で受付ける", async () => {
    insertReceipt("committed");
    let finish!: () => void;
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    nativeEnd = new Promise<void>((resolve) => {
      finish = resolve;
    });
    onStart = ready;
    mock.control.mockResolvedValue({
      status: "ok",
      turnId: request.turnId,
      found: true,
    });
    const run = startMastraAgentTurn(request);
    await started;
    await cancelMastraAgentTurn({ turnId: request.turnId });
    deliver("committed");
    finish();
    await run;
    expect(mock.project).toHaveBeenCalledExactlyOnceWith(
      "agent_event_update",
      { entityId: "target", undoJournalId: "committed" },
      "chronicle.agentHistoryUpdate",
    );
  });

  it.each(["project", "workspace"])(
    "照合中の%s切替は同じ作品に戻っても反映しない",
    async (scope) => {
      insertReceipt("slow");
      let opened!: () => void, finishRead!: () => void;
      const reading = new Promise<void>((resolve) => {
        opened = resolve;
      });
      onRead = opened;
      readGate = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      onStart = () => deliver("slow");
      const run = startMastraAgentTurn(request);
      await reading;
      if (scope === "project") {
        switchProject({ currentProjectId: "other" });
        switchProject({ currentProjectId: "p" });
      } else {
        setCurrentWorkspaceIdentity({ path: "/fixture", openRevision: 2 });
      }
      finishRead();
      await run;
      expect(mock.project).not.toHaveBeenCalled();
    },
  );

  it("開始前の取消と、削除済みの出来事の作成通知は履歴に積まない", async () => {
    insertReceipt("create", "event.create");
    onStart = () => deliver("create");
    await expect(startMastraAgentTurn(request, () => false)).resolves.toEqual({
      kind: "cancelled-before-dispatch",
    });
    version = null;
    await startMastraAgentTurn(request);
    expect(mock.project).not.toHaveBeenCalled();
  });
});
