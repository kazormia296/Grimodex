import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Send } from "lucide-react";

type Message = { role: "user" | "ai"; text: string };

const SEED_JA: Message[] = [
  { role: "user", text: "主人公の動機について相談したい" },
  {
    role: "ai",
    text: "もちろんです。主人公にはどのような背景がありますか？目標と障害を教えていただけると、具体的なアドバイスができます。",
  },
];

const SEED_EN: Message[] = [
  { role: "user", text: "I want advice on my protagonist's motivation" },
  {
    role: "ai",
    text: "Of course! What background does your protagonist have? Tell me their goal and the obstacles they face.",
  },
];

const REPLIES_JA = [
  "承知しました。物語の世界観に合わせた提案をします。",
  "キャラクターの動機をさらに深掘りするのはいかがでしょうか？",
  "その展開は読者を引き込む効果があると思います。",
  "もう少し具体的なシーンを描写すると、より臨場感が出るでしょう。",
];

const REPLIES_EN = [
  "Great question! Let me suggest something that fits your story world.",
  "Consider deepening the character's internal conflict further.",
  "That plot development should really hook the reader.",
  "A more concrete scene description would add great atmosphere.",
];

export function ChatDemoCard() {
  const { t, i18n } = useTranslation();
  const isJa = i18n.language.startsWith("ja");
  const [messages, setMessages] = useState<Message[]>(isJa ? SEED_JA : SEED_EN);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);

  function send() {
    if (!input.trim() || thinking) return;
    const text = input.trim();
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setThinking(true);
    setTimeout(() => {
      const replies = isJa ? REPLIES_JA : REPLIES_EN;
      const reply = replies[Math.floor(Math.random() * replies.length)];
      setMessages((m) => [...m, { role: "ai", text: reply }]);
      setThinking(false);
    }, 800);
  }

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2">
      <div className="mb-2 max-h-28 space-y-1.5 overflow-y-auto">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-relaxed ${
                m.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-background text-foreground"
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {thinking && (
          <div className="flex justify-start">
            <div className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-muted-foreground">
              {t("onboarding.demo.chat.thinking")}
            </div>
          </div>
        )}
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={t("onboarding.demo.chat.placeholder")}
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={send}
          disabled={!input.trim() || thinking}
          className="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-40"
        >
          <Send className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
