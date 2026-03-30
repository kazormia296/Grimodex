import { invoke } from "@/lib/tauri";
import type { ChatMessage } from "./chatTypes";

export async function sendChatMessage(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<void> {
  const payload = messages.map((m) => ({ role: m.role, content: m.content }));
  const response = await invoke<string>("send_chat_message", {
    messages: payload,
  });
  onChunk(response);
}
