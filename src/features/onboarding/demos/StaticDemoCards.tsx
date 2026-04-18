import { Layers, FileText } from "lucide-react";

export function ScenesDemoCard() {
  const items = [
    { label: "第一章：出会い", depth: 0 },
    { label: "シーン 1：夜明けの鐘", depth: 1 },
    { label: "シーン 2：運命の出会い", depth: 1 },
    { label: "第二章：旅立ち", depth: 0 },
    { label: "シーン 1：決意の朝", depth: 1 },
  ];

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2">
      <div className="space-y-0.5">
        {items.map((item, i) => (
          <div
            key={i}
            className={`flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs ${
              item.depth === 0
                ? "font-medium text-foreground"
                : "ml-4 text-foreground/80"
            }`}
          >
            {item.depth === 0 ? (
              <Layers className="h-3 w-3 shrink-0 text-primary" />
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span>{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CodexDemoCard() {
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-base">
          🧙
        </div>
        <div>
          <p className="text-xs font-semibold text-foreground">
            アリア・ルーン
          </p>
          <p className="text-[10px] text-muted-foreground">キャラクター</p>
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        古代魔法の使い手。師匠を失い、禁断の魔法書を求めて旅をしている。
      </p>
      <div className="mt-2 flex gap-1">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] text-primary">
          主人公
        </span>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          魔法使い
        </span>
      </div>
    </div>
  );
}

export function SnippetsDemoCard() {
  const snippets = [
    { text: "夕焼けの中で、二人の影が重なった。", source: "AI チャット" },
    {
      text: "彼女は振り返らなかった——それが答えだった。",
      source: "AI チャット",
    },
  ];

  return (
    <div className="mt-3 space-y-1.5">
      {snippets.map((s, i) => (
        <div
          key={i}
          className="rounded-lg border border-border bg-muted/30 px-2.5 py-2"
        >
          <p className="mb-1 text-xs leading-relaxed text-foreground">
            {s.text}
          </p>
          <p className="text-[10px] text-muted-foreground">{s.source}</p>
        </div>
      ))}
    </div>
  );
}

export function EditorDemoCard() {
  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 p-2.5">
      <p className="mb-1.5 text-sm font-bold text-foreground">
        第一章{"　"}夜明けの鐘
      </p>
      <p className="text-xs leading-relaxed text-foreground">
        薄明の光が石畳を照らし出す頃、アリアは城壁の外れに立っていた。風は冷たく、
        <em>古い羊皮紙</em>の匂いを運んでいた。
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-foreground">
        <strong>「もう戻れない」</strong>と彼女は呟いた。
      </p>
    </div>
  );
}
