import { create } from "zustand";
import * as chatApi from "./chatApi";
import { buildSystemPrompt, countTokens } from "./contextBuilder";
import type {
  SceneContext,
  ProjectContext,
  CodexContext,
} from "./contextBuilder";
import { loadSceneContent, getScene } from "@/features/scene/api";
import { getProject } from "@/features/project/api";
import { listCodexEntries } from "@/features/codex/api";
import { findMentionedEntries } from "@/features/codex/codexMatcher";
import type { ChatMessage, ChatThread, MessageRole } from "./chatTypes";

interface ChatState {
  // Thread management (Task 2.5)
  threads: ChatThread[];
  activeThreadId: string | null;
  isLoadingThreads: boolean;

  // Messages & streaming (existing)
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: number | null;
  contextTokenCount: number;

  // Thread actions (Task 2.5)
  loadThreads: (sceneId?: string) => Promise<void>;
  selectThread: (threadId: string | null) => Promise<void>;
  createNewThread: (title: string, sceneId?: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  persistMessage: (role: MessageRole, content: string) => Promise<void>;

  // Existing actions
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => void;
  clearError: () => void;
  setActiveSceneId: (id: string) => void;
  setActiveProjectId: (id: number | null) => void;
}

async function fetchSceneContext(
  sceneId: string,
): Promise<SceneContext | null> {
  try {
    const [scene, content] = await Promise.all([
      getScene(sceneId),
      loadSceneContent(sceneId),
    ]);
    if (!scene) return null;
    return { id: scene.id, title: scene.title, content: content ?? "" };
  } catch {
    return null;
  }
}

async function fetchProjectContext(
  projectId: number | null,
): Promise<ProjectContext | null> {
  if (projectId == null) return null;
  try {
    const project = await getProject(projectId);
    if (!project) return null;
    return { title: project.title, description: project.description };
  } catch {
    return null;
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  threads: [],
  activeThreadId: null,
  isLoadingThreads: false,
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,

  // --- Thread management (Task 2.5) ---

  loadThreads: async (sceneId?: string) => {
    set({ isLoadingThreads: true });
    const threads = await chatApi.listThreads(sceneId);
    set({ threads, isLoadingThreads: false });
  },

  selectThread: async (threadId: string | null) => {
    if (threadId === null) {
      set({ activeThreadId: null, messages: [] });
      return;
    }
    const messages = await chatApi.listMessages(threadId);
    set({ activeThreadId: threadId, messages });
  },

  createNewThread: async (title: string, sceneId?: string) => {
    const thread = await chatApi.createThread(title, sceneId);
    set((state) => ({
      threads: [thread, ...state.threads],
      activeThreadId: thread.id,
      messages: [],
    }));
  },

  deleteThread: async (threadId: string) => {
    await chatApi.deleteThread(threadId);
    const { activeThreadId } = get();
    set((state) => ({
      threads: state.threads.filter((t) => t.id !== threadId),
      ...(activeThreadId === threadId
        ? { activeThreadId: null, messages: [] }
        : {}),
    }));
  },

  persistMessage: async (role: MessageRole, content: string) => {
    const { activeThreadId } = get();
    if (!activeThreadId) return;

    const message = await chatApi.addMessage(activeThreadId, role, content);
    set((state) => ({
      messages: [...state.messages, message],
    }));
  },

  // --- Streaming chat (existing, updated for thread awareness) ---

  sendMessage: async (content: string) => {
    const { isStreaming, activeSceneId, activeProjectId, activeThreadId } =
      get();
    if (isStreaming) return;
    if (!content.trim()) return;

    const threadId = activeThreadId ?? "";

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      threadId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      threadId,
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
      // Build context
      const sceneCtx = activeSceneId
        ? await fetchSceneContext(activeSceneId)
        : null;
      const projectCtx = await fetchProjectContext(activeProjectId);

      const messagesForApi: ChatMessage[] = [...prevMessages, userMsg];

      if (sceneCtx) {
        // Auto-detect codex entries mentioned in scene content
        const allEntries = await listCodexEntries();
        const mentioned = findMentionedEntries(sceneCtx.content, allEntries);
        const codexEntries: CodexContext[] = mentioned.map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          summary: allEntries.find((a) => a.id === e.id)?.summary ?? "",
        }));

        // Load pinned codex entries for current thread
        let pinnedCodexEntries: CodexContext[] = [];
        if (activeThreadId) {
          const pinned = await chatApi.listPinnedCodexEntries(activeThreadId);
          pinnedCodexEntries = pinned.map((e) => ({
            id: e.id,
            type: e.type,
            name: e.name,
            summary: e.summary,
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
          threadId,
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

      // Persist messages to DB after streaming completes
      if (activeThreadId) {
        const finalMessages = get().messages;
        const lastMsg = finalMessages[finalMessages.length - 1];
        await chatApi.addMessage(activeThreadId, "user", content);
        if (lastMsg && lastMsg.role === "assistant" && lastMsg.content) {
          await chatApi.addMessage(
            activeThreadId,
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
  setActiveProjectId: (id: number | null) => set({ activeProjectId: id }),
}));
