import { create } from "zustand";
import { toast } from "sonner";
import * as chatApi from "./chatApi";
import { buildSystemPrompt, countTokens } from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
} from "./contextBuilder";
import { loadSceneContent } from "@/features/tree/api";
import { getNode } from "@/features/tree/api";
import { getProject } from "@/features/project/api";
import { listCodexEntries } from "@/features/codex/api";
import { findMentionedEntries } from "@/features/codex/codexMatcher";
import type { ChatMessage, ChatSession, MessageRole } from "./chatTypes";

interface ChatState {
  // Session management
  sessions: ChatSession[];
  activeSessionId: string | null;
  isLoadingSessions: boolean;

  // Messages & streaming
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: string | null;
  contextTokenCount: number;

  // Session actions
  loadSessions: (nodeId?: string) => Promise<void>;
  selectSession: (sessionId: string | null) => Promise<void>;
  createNewSession: (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  persistMessage: (role: MessageRole, content: string) => Promise<void>;

  // Existing actions
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: string | null) => void;
}

async function fetchSceneContext(
  sceneId: string,
): Promise<SceneContext | null> {
  try {
    const [node, content] = await Promise.all([
      getNode(sceneId),
      loadSceneContent(sceneId),
    ]);
    if (!node) return null;
    return { id: node.id, title: node.title, content: content ?? "" };
  } catch {
    return null;
  }
}

async function fetchProjectContext(
  projectId: string | null,
): Promise<ProjectContext | null> {
  if (projectId == null) return null;
  try {
    const project = await getProject(projectId);
    if (!project) return null;
    return {
      title: project.title,
      genre: project.genre,
      pov: project.pov,
      tense: project.tense,
      styleGuide: project.styleGuide,
      aiInstructions: project.aiInstructions,
    };
  } catch {
    return null;
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: false,
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,

  // --- Session management ---

  loadSessions: async (nodeId?: string) => {
    set({ isLoadingSessions: true });
    try {
      const sessions = await chatApi.listSessions(nodeId);
      set({ sessions, isLoadingSessions: false });
    } catch (e) {
      set({ isLoadingSessions: false });
      toast.error("チャットセッションの読み込みに失敗しました");
      console.error("[ChatStore] loadSessions:", e);
    }
  },

  selectSession: async (sessionId: string | null) => {
    if (sessionId === null) {
      set({ activeSessionId: null, messages: [] });
      return;
    }
    try {
      const messages = await chatApi.listMessages(sessionId);
      set({ activeSessionId: sessionId, messages });
    } catch (e) {
      toast.error("メッセージの読み込みに失敗しました");
      console.error("[ChatStore] selectSession:", e);
    }
  },

  createNewSession: async (
    projectId: string,
    title: string,
    nodeId?: string,
  ) => {
    try {
      const session = await chatApi.createSession(projectId, title, nodeId);
      set((state) => ({
        sessions: [session, ...state.sessions],
        activeSessionId: session.id,
        messages: [],
      }));
    } catch (e) {
      toast.error("セッションの作成に失敗しました");
      console.error("[ChatStore] createNewSession:", e);
    }
  },

  deleteSession: async (sessionId: string) => {
    try {
      await chatApi.deleteSession(sessionId);
      const { activeSessionId } = get();
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionId),
        ...(activeSessionId === sessionId
          ? { activeSessionId: null, messages: [] }
          : {}),
      }));
    } catch (e) {
      toast.error("セッションの削除に失敗しました");
      console.error("[ChatStore] deleteSession:", e);
    }
  },

  persistMessage: async (role: MessageRole, content: string) => {
    const { activeSessionId } = get();
    if (!activeSessionId) return;

    try {
      const message = await chatApi.addMessage(activeSessionId, role, content);
      set((state) => ({
        messages: [...state.messages, message],
      }));
    } catch (e) {
      toast.error("メッセージの保存に失敗しました");
      console.error("[ChatStore] persistMessage:", e);
    }
  },

  // --- Streaming chat ---

  sendMessage: async (content: string) => {
    const { isStreaming, activeSceneId, activeProjectId, activeSessionId } =
      get();
    if (isStreaming) return;
    if (!content.trim()) return;

    const sessionId = activeSessionId ?? "";

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    const prevMessages = get().messages;
    set({
      messages: [...prevMessages, userMsg, assistantMsg],
      isStreaming: true,
      error: null,
    });

    try {
      const sceneCtx = activeSceneId
        ? await fetchSceneContext(activeSceneId)
        : null;
      const projectCtx = await fetchProjectContext(activeProjectId);

      const messagesForApi: ChatMessage[] = [...prevMessages, userMsg];

      if (sceneCtx) {
        const allEntries = await listCodexEntries();
        const mentioned = findMentionedEntries(sceneCtx.content, allEntries);
        const codexEntries: CodexContext[] = mentioned.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: allEntries.find((a) => a.id === e.id)?.summary ?? "",
        }));

        let pinnedCodexEntries: CodexContext[] = [];
        if (activeSessionId) {
          const pinned = await chatApi.listPinnedCodexEntries(activeSessionId);
          pinnedCodexEntries = pinned.map((e) => ({
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary ?? "",
          }));
        }

        const systemPrompt = buildSystemPrompt({
          scene: sceneCtx,
          project: projectCtx ?? undefined,
          codexEntries,
          pinnedCodexEntries,
        });

        set({ contextTokenCount: countTokens(systemPrompt) });

        const systemMsg: ChatMessage = {
          id: "system",
          sessionId,
          role: "system",
          content: systemPrompt,
          createdAt: new Date().toISOString(),
        };
        messagesForApi.unshift(systemMsg);
      }

      await chatApi.sendChatMessage(messagesForApi, (chunk: string) => {
        set((s) => {
          const msgs = [...s.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === "assistant") {
            msgs[msgs.length - 1] = { ...last, content: last.content + chunk };
          }
          return { messages: msgs };
        });
      });

      if (activeSessionId) {
        const finalMessages = get().messages;
        const lastMsg = finalMessages[finalMessages.length - 1];
        await chatApi.addMessage(activeSessionId, "user", content);
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
          await chatApi.addMessage(
            activeSessionId,
            "assistant",
            lastMsg.content,
          );
        }
      }
    } catch (e) {
      set({
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      set({ isStreaming: false });
    }
  },

  clearMessages: () => set({ messages: [] }),
  clearError: () => set({ error: null }),
  setActiveSceneId: (id: string) => set({ activeSceneId: id }),
  setActiveProjectId: (id: string | null) => set({ activeProjectId: id }),
}));
