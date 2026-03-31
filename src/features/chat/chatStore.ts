import { create } from "zustand";
import * as chatApi from "./chatApi";
import { buildSystemPrompt, countTokens } from "./contextBuilder";
import type { SceneContext, ProjectContext } from "./contextBuilder";
import { loadSceneContent, getScene } from "@/features/scene/api";
import { getProject } from "@/features/project/api";
import type { ChatMessage } from "./chatTypes";

interface ChatState {
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  activeSceneId: string;
  activeProjectId: number | null;
  contextTokenCount: number;

  addUserMessage: (content: string) => void;
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
  messages: [],
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
  contextTokenCount: 0,

  addUserMessage: (content: string) => {
    const msg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };
    set((s) => ({ messages: [...s.messages, msg] }));
  },

  sendMessage: async (content: string) => {
    const { isStreaming, activeSceneId, activeProjectId } = get();
    if (isStreaming) return;
    if (!content.trim()) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    };

    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
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
        const systemPrompt = buildSystemPrompt({
          scene: sceneCtx,
          project: projectCtx ?? undefined,
        });

        set({ contextTokenCount: countTokens(systemPrompt) });

        const systemMsg: ChatMessage = {
          id: "system",
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
