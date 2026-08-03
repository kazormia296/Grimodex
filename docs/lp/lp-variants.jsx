/* eslint-disable */
/**
 * Grimodex LP — 3 tone variants
 * A: VIVID MAXIMAL — massive type, kinetic strokes, magenta/cyan/marigold
 * B: INK SERIF     — black ground, acid green, swiss-editorial-meets-glitch
 * C: BRUTAL MONO   — paper + heavy rules, mono type, single neon accent
 */

const { useEffect, useRef, useState } = React;

/* ============================================================
   Shared content (bilingual)
   ============================================================ */

const COPY = {
  product: "Grimodex",
  tagline_ja: "ライティング・フィジェット・IDE",
  tagline_en: "A Writing Fidget IDE",
  hero_ja_lines: ["書くたび、", "世界が", "解像する。"],
  hero_en: "Write more. The world sharpens.",
  hero_sub_ja:
    "AIと話す。設定が抽出される。次の生成がもっと深くなる。書けば書くほど、あなたの世界の解像度が上がる執筆 IDE。",
  hero_sub_en:
    "Chat with AI. Codex extracts the world. The next prompt knows more. The flywheel of long-form fiction.",
  cta_primary_ja: "ダウンロード",
  cta_primary_en: "Download",
  cta_sub: "macOS · Windows · Linux  ·  Local-first  ·  BYOK",

  features: [
    {
      no: "01",
      kicker_ja: "Codex",
      kicker_en: "CODEX",
      title_ja: ["思いつきが、", "作品の資産になる。"],
      title_en: "Grow your world while you write.",
      body_ja:
        "設定資料が、執筆の外に散らばらない。人物、用語、世界観、アイデアを Codex に集めて、本文を書きながら育てられる。",
      body_en:
        "Characters, terms, worldbuilding, and ideas stay beside the manuscript instead of scattering across notes.",
    },
    {
      no: "02",
      kicker_ja: "Map",
      kicker_en: "MAP",
      title_ja: ["書けないときは、", "地図を触る。"],
      title_en: "See the story as a map.",
      body_ja:
        "物語の迷子にならない。章、シーン、断片、アイデアを Map 上で見渡し、構成の流れや抜けを確認できる。",
      body_en:
        "Move chapters, scenes, fragments, and ideas around spatially when linear text is not enough.",
    },
    {
      no: "03",
      kicker_ja: "AI Chat",
      kicker_en: "AI CHAT",
      title_ja: ["AI に丸投げしない。", "AI と揉む。"],
      title_en: "A thinking partner beside the draft.",
      body_ja:
        "本文、Codex、Map を参照しながら、設定確認・表現案・構成相談・校閲をその場で行える。AI は代筆機ではなく、執筆中の判断を支える相手になる。",
      body_en:
        "Use AI for comparison, structure, consistency checks, and revision talk, not only generation.",
    },
    {
      no: "04",
      kicker_ja: "ローカル",
      kicker_en: "LOCAL",
      title_ja: ["全部、", "あなたの machine の中。"],
      title_en: "All on your machine.",
      body_ja:
        "原稿は SQLite にローカル保存。AIへ送るのは、接続先を確認して自分で実行した処理のコンテキストだけ。Electron版では、ライセンス検証、更新確認、意味検索モデル取得の通信も発生する場合がある。",
      body_en:
        "Manuscripts live in local SQLite. Context leaves the device when you explicitly send it to a configured AI. Electron may also contact services for license validation, update checks, and semantic-model downloads.",
    },
  ],

  usecases: [
    {
      ja: "長編小説",
      en: "Long-form novel",
      desc_ja: "30 万字を超える原稿でも、Codex が世界の整合性を保つ。",
      desc_en: "Keep a 100k-word draft consistent — the Codex is the canon.",
    },
    {
      ja: "シナリオ・脚本",
      en: "Screenplay",
      desc_ja: "シーンごとの相談履歴を分けて、必要な場面の検討に戻りやすくする。",
      desc_en: "Keep per-scene discussion threads so each scene's decisions are easier to revisit.",
    },
    {
      ja: "TRPG シナリオ",
      en: "TTRPG scenario",
      desc_ja: "NPC・伏線・地理を構造化。当日のアドリブにも耐える設定書を生成。",
      desc_en: "NPCs, secrets, geography — structured for an improv-proof session.",
    },
  ],

  panels: [
    "Scenes",
    "Editor",
    "AI Chat",
    "Chat History",
    "Codex",
    "Codex Quick",
    "Map",
    "Timeline",
    "Snippets",
    "Attribution",
    "Kouetsu",
    "Foreshadow",
    "Grid",
    "Matrix",
    "Trash Bin",
  ],

  faq: [
    {
      q_ja: "AI モデルは何が使える？",
      q_en: "Which AI models?",
      a_ja: "OpenRouter、OpenAI、Anthropic、OpenAI互換、Ollamaなどに対応。選んだ接続先のモデルとAPIキーを使います。",
      a_en: "Use supported cloud APIs, OpenAI-compatible endpoints, Ollama, or other configured routes. Models and keys come from the connection you choose.",
    },
    {
      q_ja: "オフラインで動く？",
      q_en: "Does it work offline?",
      a_ja: "本文編集はローカルで行えます。AI呼び出しのほか、Electron版ではライセンス検証、更新確認、意味検索モデル取得の通信が発生する場合があります。",
      a_en: "Editing is local. AI calls can send selected context, and Electron may also contact services for license validation, update checks, and semantic-model downloads.",
    },
    {
      q_ja: "値段は？",
      q_en: "How much?",
      a_ja: "本体の価格とライセンスは公式購入ページを確認してください。AIの料金と保持条件は、選んだ接続先に依存します。",
      a_en: "Check the official purchase page for the product license. AI costs and retention depend on the connection you choose.",
    },
  ],
};

/* ============================================================
   Tiny utilities
   ============================================================ */

// Animate text on intersection — split into chars/words
function Reveal({ children, className, style, delay = 0, as: Tag = "div" }) {
  const ref = useRef(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setShown(true);
        });
      },
      { threshold: 0.15, root: el.closest("[data-artboard-scroll]") || null },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      ref={ref}
      className={className}
      style={{
        ...style,
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(28px)",
        transition: `opacity 700ms cubic-bezier(.2,.8,.2,1) ${delay}ms, transform 700ms cubic-bezier(.2,.8,.2,1) ${delay}ms`,
      }}
    >
      {children}
    </Tag>
  );
}

// Marquee — a continuously scrolling row, kinetic
function Marquee({ children, speed = 40, reverse = false, style, className }) {
  return (
    <div
      className={className}
      style={{
        ...style,
        overflow: "hidden",
        whiteSpace: "nowrap",
        display: "flex",
      }}
    >
      <div
        style={{
          display: "inline-flex",
          gap: 48,
          paddingRight: 48,
          animation: `${reverse ? "lp-marquee-r" : "lp-marquee"} ${speed}s linear infinite`,
        }}
      >
        {children}
        {children}
      </div>
    </div>
  );
}

// Scrollable artboard wrapper — gives each LP its own scroll context
function LPFrame({ bg, children, fontFamily }) {
  return (
    <div
      data-artboard-scroll
      style={{
        width: "100%",
        minHeight: "100vh",
        overflow: "visible",
        background: bg,
        position: "relative",
        fontFamily,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Dark themed panel bodies that echo real Grimodex panels (no app imports).
 * panelIndex aligns with COPY.panels order.
 */
function LPPanelBodyRealistic({ panelIndex = 0, accent = "#7c3aed" }) {
  const fg = "#e4e4e7";
  const muted = "#71717a";
  const line = "rgba(255,255,255,0.07)";
  const card = "#18181b";
  const mono = { fontFamily: "ui-monospace, monospace", fontSize: 9, letterSpacing: "0.04em", color: muted };

  const rowLine = (w) => (
    <div key={w} style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.08)", width: w }} />
  );

  const phLines = (widths) => (
    <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
      {widths.map((w) => rowLine(w))}
    </div>
  );

  if (panelIndex === 0) {
    return (
      <div style={{ padding: 10, color: fg, fontSize: 11 }}>
        <div style={{ ...mono, textTransform: "uppercase", marginBottom: 8 }}>Chapter / Scene</div>
        <div style={{ border: `1px solid ${line}`, borderRadius: 6, padding: 8, background: card }}>
          <div style={{ fontWeight: 600 }}>▼ Chapter 02</div>
          {phLines(["72%", "55%"])}
        </div>
        <div style={{ border: `1px solid ${line}`, borderRadius: 6, padding: 8, background: card, marginTop: 8 }}>
          <div style={{ fontWeight: 600, color: accent }}>▼ Chapter 03</div>
          <div style={{ marginTop: 6, paddingLeft: 8, borderLeft: `2px solid ${accent}` }}>
            <div style={{ fontWeight: 600 }}>Scene 12 — active</div>
            {phLines(["90%", "40%"])}
          </div>
        </div>
      </div>
    );
  }

  if (panelIndex === 1) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0, color: fg, fontSize: 12 }}>
        <div
          style={{
            flexShrink: 0,
            display: "flex",
            gap: 4,
            padding: "6px 8px",
            borderBottom: `1px solid ${line}`,
            background: "#141416",
          }}
        >
          {["B", "I", "⟨⟩", "•••"].map((x) => (
            <span
              key={x}
              style={{
                width: 24,
                height: 22,
                borderRadius: 4,
                border: `1px solid ${line}`,
                display: "grid",
                placeItems: "center",
                fontSize: 10,
                color: muted,
              }}
            >
              {x}
            </span>
          ))}
        </div>
        <div style={{ flex: 1, padding: 12, lineHeight: 1.75, overflow: "hidden" }}>
          <div style={{ ...mono, marginBottom: 8 }}>Scene body · TipTap</div>
          {phLines(["100%", "96%", "88%", "60%"])}
        </div>
      </div>
    );
  }

  if (panelIndex === 2) {
    return (
      <div style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", color: fg, fontSize: 11.5 }}>
        <div style={{ justifySelf: "end", maxWidth: "88%", background: "#27272a", padding: "8px 10px", borderRadius: 10, border: `1px solid ${line}` }}>
          <div style={{ ...mono, marginBottom: 4 }}>You</div>
          {rowLine("75%")}
        </div>
        <div style={{ border: `1px solid ${line}`, borderRadius: 10, padding: "8px 10px", background: card }}>
          <div style={{ ...mono, marginBottom: 4 }}>Model</div>
          {phLines(["100%", "80%", "45%"])}
          <div style={{ marginTop: 10, fontSize: 10, fontWeight: 600, color: accent }}>↳ Tool · Codex</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ flex: 1, height: 28, borderRadius: 6, border: `1px solid ${line}`, background: "#09090b" }} />
          <span style={{ width: 56, height: 28, borderRadius: 6, background: accent, opacity: 0.85 }} />
        </div>
      </div>
    );
  }

  if (panelIndex === 3) {
    return (
      <div style={{ color: fg, fontSize: 11 }}>
        {[
          { k: "Thread A", sub: "Scene 03" },
          { k: "Thread B", sub: "Scene 12 — current", hi: true },
          { k: "Thread C", sub: "Scene 01" },
        ].map((row) => (
          <div
            key={row.k}
            style={{
              padding: "10px 12px",
              borderBottom: `1px solid ${line}`,
              background: row.hi ? "rgba(124,58,237,0.12)" : "transparent",
            }}
          >
            <div style={{ fontWeight: 600 }}>{row.k}</div>
            <div style={{ color: muted, fontSize: 10, marginTop: 2 }}>{row.sub}</div>
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 4) {
    return (
      <div style={{ padding: 10, display: "grid", gap: 6, color: fg, fontSize: 11 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 48px", gap: 8, marginBottom: 4 }}>
          <div style={{ height: 28, borderRadius: 6, border: `1px solid ${line}`, background: "#09090b" }} />
          <div style={{ height: 28, borderRadius: 6, border: `1px solid ${line}`, background: card }} />
        </div>
        {["Entry A", "Entry B", "Entry C"].map((name, i) => (
          <div key={name} style={{ border: `1px solid ${line}`, borderRadius: 8, padding: "8px 10px", background: i === 1 ? "rgba(124,58,237,0.08)" : card }}>
            <span style={{ ...mono }}>CODEX</span>
            <div style={{ fontWeight: 600, marginTop: 4 }}>{name}</div>
            {phLines(["70%"])}
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 5) {
    return (
      <div style={{ padding: 12, color: fg, fontSize: 11 }}>
        <div style={{ ...mono, marginBottom: 8 }}>Quick capture</div>
        <div style={{ border: `1px dashed ${accent}`, borderRadius: 8, padding: 10, background: "rgba(124,58,237,0.06)", minHeight: 64 }}>
          {phLines(["92%", "50%"])}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
          <span style={{ ...mono, flex: 1 }}>→ Add to</span>
          <span style={{ background: accent, color: "#fff", padding: "4px 10px", borderRadius: 6, fontWeight: 700, fontSize: 10 }}>
            Codex
          </span>
        </div>
      </div>
    );
  }

  if (panelIndex === 6) {
    return (
      <div
        style={{
          position: "relative",
          margin: 8,
          flex: 1,
          minHeight: 120,
          background: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
          backgroundSize: "18px 18px",
          border: `1px solid ${line}`,
          borderRadius: 8,
        }}
      >
        {[
          { x: 10, y: 14, w: 52, h: 32 },
          { x: 70, y: 44, w: 60, h: 40, hi: true },
          { x: 36, y: 78, w: 44, h: 28 },
        ].map((b, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: b.x,
              top: b.y,
              width: b.w,
              height: b.h,
              borderRadius: 6,
              background: b.hi ? "rgba(124,58,237,0.25)" : card,
              border: `1px solid ${line}`,
              boxShadow: b.hi ? `0 0 0 1px ${accent}` : "none",
            }}
          />
        ))}
      </div>
    );
  }

  if (panelIndex === 7) {
    return (
      <div style={{ padding: 12, color: fg, fontSize: 10 }}>
        <div style={{ position: "relative", height: 40, marginBottom: 8 }}>
          <div style={{ position: "absolute", left: 8, right: 8, top: 18, borderTop: `1px solid ${line}` }} />
          {[
            { l: "A1", left: "12%", on: true },
            { l: "A2", left: "38%" },
            { l: "A3", left: "64%" },
            { l: "A4", left: "88%" },
          ].map((d) => (
            <div key={d.l} style={{ position: "absolute", left: d.left, top: 12, transform: "translateX(-50%)" }}>
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  margin: "0 auto",
                  background: d.on ? accent : "#3f3f46",
                  border: `1px solid ${line}`,
                }}
              />
              <div style={{ textAlign: "center", marginTop: 4, color: d.on ? fg : muted }}>{d.l}</div>
            </div>
          ))}
        </div>
        <div style={{ color: muted }}>Timeline ruler · story order</div>
      </div>
    );
  }

  if (panelIndex === 8) {
    return (
      <div style={{ padding: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, color: fg, fontSize: 11 }}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ background: "#1c1917", border: `1px solid ${line}`, borderRadius: 8, padding: "8px 10px", minHeight: 56 }}>
            {phLines(i === 3 ? ["100%", "70%"] : ["88%"])}
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 9) {
    return (
      <div style={{ padding: 10, color: fg, fontSize: 11 }}>
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          {[
            { k: "human", c: "#22c55e", w: "72%" },
            { k: "ai", c: accent, w: "22%" },
            { k: "?", c: "#71717a", w: "6%" },
          ].map((x) => (
            <div key={x.k} style={{ flex: 1 }}>
              <div style={{ height: 6, borderRadius: 3, background: x.c, width: x.w, marginBottom: 6 }} />
              <div style={{ ...mono, textTransform: "uppercase" }}>{x.k}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: 10, border: `1px solid ${line}`, borderRadius: 8, background: card, lineHeight: 1.7 }}>
          {phLines(["100%", "90%", "40%"])}
        </div>
      </div>
    );
  }

  if (panelIndex === 10) {
    return (
      <div style={{ padding: 10, display: "grid", gap: 8, color: fg, fontSize: 11 }}>
        {["Issue · wording", "Issue · consistency", "Issue · pacing"].map((t, i) => (
          <div key={t} style={{ display: "grid", gridTemplateColumns: "26px 1fr", gap: 8, alignItems: "start" }}>
            <span
              style={{
                background: "rgba(124,58,237,0.2)",
                border: `1px solid ${line}`,
                borderRadius: 4,
                textAlign: "center",
                fontWeight: 800,
                fontSize: 9,
                padding: "4px 0",
              }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <div style={{ fontWeight: 600 }}>{t}</div>
              {rowLine("85%")}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 11) {
    return (
      <div style={{ margin: 8, border: `1px solid ${line}`, borderRadius: 8, overflow: "hidden", fontSize: 10, color: fg }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", background: card, borderBottom: `1px solid ${line}`, fontWeight: 700, ...mono }}>
          {["Seed", "Status", "Payoff"].map((h) => (
            <span key={h} style={{ padding: 8 }}>
              {h}
            </span>
          ))}
        </div>
        {[
          { a: "Item A", b: "Open", c: "Ch.8" },
          { a: "Item B", b: "Done", c: "Ch.3" },
        ].map((r) => (
          <div key={r.a} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: `1px solid ${line}` }}>
            <span style={{ padding: 8 }}>{r.a}</span>
            <span style={{ padding: 8, color: r.b === "Open" ? accent : muted }}>{r.b}</span>
            <span style={{ padding: 8 }}>{r.c}</span>
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 12) {
    return (
      <div style={{ margin: 8, border: `1px solid ${line}`, borderRadius: 8, overflow: "hidden", fontSize: 9, color: fg }}>
        <div style={{ display: "grid", gridTemplateColumns: "40px repeat(3, 1fr)", background: card, borderBottom: `1px solid ${line}` }}>
          {["", "α", "β", "γ"].map((c) => (
            <span key={c} style={{ padding: 6, fontWeight: 700, borderRight: `1px solid ${line}` }}>
              {c}
            </span>
          ))}
        </div>
        {["R1", "R2", "R3"].map((rn, ri) => (
          <div key={rn} style={{ display: "grid", gridTemplateColumns: "40px repeat(3, 1fr)" }}>
            <span style={{ padding: 6, fontWeight: 600, borderRight: `1px solid ${line}`, borderBottom: `1px solid ${line}`, background: "#121214" }}>{rn}</span>
            {[0, 1, 2].map((ci) => {
              const on = ri === 1 && ci === 2;
              return (
                <span
                  key={ci}
                  style={{
                    padding: 6,
                    borderRight: `1px solid ${line}`,
                    borderBottom: `1px solid ${line}`,
                    textAlign: "center",
                    background: on ? "rgba(124,58,237,0.2)" : "transparent",
                  }}
                >
                  {on ? "●" : "○"}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 13) {
    return (
      <div style={{ padding: 10, fontSize: 9, color: fg }}>
        <div style={{ display: "grid", gridTemplateColumns: "26px repeat(3, 1fr)", gap: 2, marginBottom: 4, fontWeight: 700 }}>
          {["", "x", "y", "z"].map((lb) => (
            <span key={lb} style={{ textAlign: "center", padding: 4 }}>
              {lb}
            </span>
          ))}
        </div>
        {["Axis 1", "Axis 2", "Axis 3"].map((row) => (
          <div key={row} style={{ display: "grid", gridTemplateColumns: "26px repeat(3, 1fr)", gap: 2, marginBottom: 2 }}>
            <span style={{ fontWeight: 600, padding: 4 }}>{row}</span>
            {[0.8, 0.35, 0.55].map((a, i) => (
              <span
                key={i}
                style={{
                  display: "grid",
                  placeItems: "center",
                  padding: 4,
                  background: card,
                  border: `1px solid ${line}`,
                  borderRadius: 4,
                  color: a > 0.5 ? accent : muted,
                }}
              >
                {a > 0.5 ? "●" : "·"}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (panelIndex === 14) {
    return (
      <div style={{ padding: 10, color: fg, fontSize: 11 }}>
        <div style={{ ...mono, marginBottom: 8 }}>Trash · restore available</div>
        {[1, 2].map((i) => (
          <div
            key={i}
            style={{
              padding: "8px 10px",
              border: `1px dashed ${line}`,
              borderRadius: 8,
              marginBottom: 6,
              background: "#121214",
              textDecoration: "line-through",
              color: muted,
            }}
          >
            Deleted node {i}
          </div>
        ))}
        <span style={{ ...mono }}>↩ Restore</span>
      </div>
    );
  }

  return (
    <div style={{ padding: 12, color: muted, fontSize: 11 }}>
      {COPY.panels[panelIndex] ?? "Panel"}
    </div>
  );
}

function lpIconFileOutput({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="12" y1="18" x2="12" y2="12" />
      <line x1="9" y1="15" x2="15" y2="15" />
    </svg>
  );
}

function lpIconSettings({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
    </svg>
  );
}

function lpIconLayoutPreset({ size = 16, color = "currentColor" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="3" width="7" height="18" rx="1" />
      <rect x="14" y="3" width="7" height="8" rx="1" />
      <rect x="14" y="13" width="7" height="8" rx="1" />
    </svg>
  );
}

/* IDs mirror src/features/layout/layoutPresets.ts getBuiltinPresets() */
const LP_BUILTIN_PRESETS = [
  { id: "builtin:default", label: "Write" },
  { id: "builtin:plan", label: "Plan" },
  { id: "builtin:chat-main", label: "Chat" },
  { id: "builtin:review", label: "Proofread" },
  { id: "builtin:codex-main", label: "Condense" },
];

function LPDockPanel({
  tabs,
  panelIndex,
  activeIndicator,
}) {
  const hi = activeIndicator ?? "#7c3aed";
  const tabMute = "#a1a1aa";
  const tabStrip = "#18181b";
  const border = "rgba(255,255,255,0.08)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: "#09090b",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 2,
          paddingLeft: 4,
          paddingRight: 4,
          minHeight: 32,
          borderBottom: `1px solid ${border}`,
          background: tabStrip,
          overflowX: "auto",
        }}
      >
        {tabs.map((t) => (
          <span
            key={t.id}
            style={{
              fontSize: 12,
              fontWeight: t.active ? 600 : 500,
              color: t.active ? "#fafafa" : tabMute,
              padding: "6px 10px",
              borderBottom: t.active ? `2px solid ${hi}` : "2px solid transparent",
              marginBottom: -1,
              fontFamily: "ui-sans-serif, system-ui",
              whiteSpace: "nowrap",
            }}
          >
            {t.label}
          </span>
        ))}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: 0,
          background: "#0c0c0e",
        }}
      >
        <LPPanelBodyRealistic panelIndex={panelIndex} accent={hi} />
      </div>
    </div>
  );
}

/**
 * Full in-page Grimodex window: title bar + Dockview-style grid + builtin preset switcher.
 */
function LPAppShellPreview({
  accent = "#534AB7",
  activeIndicator,
  mac = true,
  minHeight = 440,
}) {
  const [preset, setPreset] = useState("builtin:default");
  const hi = activeIndicator ?? accent;
  const ink = "#18181b";
  const muted = "rgba(24,24,27,0.55)";
  const barBg = "#fafafa";
  const barBorder = "rgba(24,24,27,0.12)";
  const split = "#27272a";

  const cell = { minWidth: 0, minHeight: 0, overflow: "hidden" };

  const presetRow = (
    <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", color: muted }} title="Layout presets">
        {lpIconLayoutPreset({ size: 15, color: "rgba(24,24,27,0.45)" })}
      </span>
      {LP_BUILTIN_PRESETS.map((p) => {
        const on = preset === p.id;
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => setPreset(p.id)}
            style={{
              fontSize: 11,
              fontWeight: on ? 600 : 500,
              padding: "4px 9px",
              borderRadius: 6,
              border: `1px solid ${on ? hi : barBorder}`,
              background: on ? `${hi}26` : "transparent",
              color: ink,
              cursor: "pointer",
              fontFamily: "ui-sans-serif, system-ui",
            }}
          >
            {p.label}
          </button>
        );
      })}
    </div>
  );

  let dock;
  if (preset === "builtin:default") {
    dock = (
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `
            "scenes editor chat"
            "cq editor codex"
          `,
          gridTemplateColumns: "minmax(96px, 0.18fr) 1fr minmax(120px, 0.33fr)",
          gridTemplateRows: "1fr 1fr",
          gap: 1,
          flex: 1,
          minHeight: 0,
          height: "100%",
          background: split,
        }}
      >
        <div style={{ gridArea: "scenes", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "scenes", label: COPY.panels[0], active: true },
              { id: "grid", label: COPY.panels[12], active: false },
            ]}
            panelIndex={0}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "cq", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "cq", label: COPY.panels[5], active: true }]}
            panelIndex={5}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "editor", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "ed", label: COPY.panels[1], active: true }]}
            panelIndex={1}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "chat", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "chat", label: COPY.panels[2], active: true },
              { id: "hist", label: COPY.panels[3], active: false },
            ]}
            panelIndex={2}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "codex", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "codex", label: COPY.panels[4], active: true },
              { id: "snip", label: COPY.panels[8], active: false },
            ]}
            panelIndex={4}
            activeIndicator={hi}
          />
        </div>
      </div>
    );
  } else if (preset === "builtin:plan") {
    dock = (
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `
            "grid chat"
            "timeline codex"
          `,
          gridTemplateColumns: "minmax(140px, 0.67fr) minmax(120px, 0.33fr)",
          gridTemplateRows: "1fr minmax(64px, 0.24fr)",
          gap: 1,
          flex: 1,
          minHeight: 0,
          height: "100%",
          background: split,
        }}
      >
        <div style={{ gridArea: "grid", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "g", label: COPY.panels[12], active: true },
              { id: "m", label: COPY.panels[6], active: false },
            ]}
            panelIndex={12}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "chat", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "c", label: COPY.panels[2], active: true },
              { id: "h", label: COPY.panels[3], active: false },
            ]}
            panelIndex={2}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "timeline", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "tl", label: COPY.panels[7], active: true }]}
            panelIndex={7}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "codex", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "cx", label: COPY.panels[4], active: true },
              { id: "sn", label: COPY.panels[8], active: false },
              { id: "fs", label: COPY.panels[11], active: false },
              { id: "mx", label: COPY.panels[13], active: false },
            ]}
            panelIndex={4}
            activeIndicator={hi}
          />
        </div>
      </div>
    );
  } else if (preset === "builtin:chat-main") {
    dock = (
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `"chat codex"`,
          gridTemplateColumns: "minmax(160px, 2fr) minmax(120px, 1fr)",
          gridTemplateRows: "1fr",
          gap: 1,
          flex: 1,
          minHeight: 0,
          height: "100%",
          background: split,
        }}
      >
        <div style={{ gridArea: "chat", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "c", label: COPY.panels[2], active: true },
              { id: "h", label: COPY.panels[3], active: false },
            ]}
            panelIndex={2}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "codex", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "cx", label: COPY.panels[4], active: true },
              { id: "sn", label: COPY.panels[8], active: false },
              { id: "mx", label: COPY.panels[13], active: false },
            ]}
            panelIndex={4}
            activeIndicator={hi}
          />
        </div>
      </div>
    );
  } else if (preset === "builtin:review") {
    dock = (
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `
            "scenes editor kouetsu codex"
            "attr editor kouetsu codex"
          `,
          gridTemplateColumns:
            "minmax(72px, 0.13fr) minmax(100px, 1fr) minmax(88px, 0.3fr) minmax(88px, 0.25fr)",
          gridTemplateRows: "1fr minmax(56px, 0.38fr)",
          gap: 1,
          flex: 1,
          minHeight: 0,
          height: "100%",
          background: split,
        }}
      >
        <div style={{ gridArea: "scenes", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "sc", label: COPY.panels[0], active: true },
              { id: "gr", label: COPY.panels[12], active: false },
            ]}
            panelIndex={0}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "attr", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "at", label: COPY.panels[9], active: true }]}
            panelIndex={9}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "editor", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "ed", label: COPY.panels[1], active: true }]}
            panelIndex={1}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "kouetsu", ...cell }}>
          <LPDockPanel
            tabs={[{ id: "k", label: COPY.panels[10], active: true }]}
            panelIndex={10}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "codex", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "cx", label: COPY.panels[4], active: true },
              { id: "sn", label: COPY.panels[8], active: false },
              { id: "mx", label: COPY.panels[13], active: false },
              { id: "fs", label: COPY.panels[11], active: false },
              { id: "tl", label: COPY.panels[7], active: false },
            ]}
            panelIndex={4}
            activeIndicator={hi}
          />
        </div>
      </div>
    );
  } else {
    dock = (
      <div
        style={{
          display: "grid",
          gridTemplateAreas: `"codex chat"`,
          gridTemplateColumns: "minmax(160px, 3fr) minmax(100px, 1fr)",
          gridTemplateRows: "1fr",
          gap: 1,
          flex: 1,
          minHeight: 0,
          height: "100%",
          background: split,
        }}
      >
        <div style={{ gridArea: "codex", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "cx", label: COPY.panels[4], active: true },
              { id: "sn", label: COPY.panels[8], active: false },
              { id: "mx", label: COPY.panels[13], active: false },
              { id: "mp", label: COPY.panels[6], active: false },
            ]}
            panelIndex={4}
            activeIndicator={hi}
          />
        </div>
        <div style={{ gridArea: "chat", ...cell }}>
          <LPDockPanel
            tabs={[
              { id: "c", label: COPY.panels[2], active: true },
              { id: "h", label: COPY.panels[3], active: false },
            ]}
            panelIndex={2}
            activeIndicator={hi}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 14,
        overflow: "hidden",
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.07)",
        background: barBg,
        fontFamily: 'ui-sans-serif, system-ui, "Inter", sans-serif',
        color: ink,
        display: "flex",
        flexDirection: "column",
        minHeight: minHeight + 48,
      }}
    >
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: mac ? "6px 12px 6px 72px" : "6px 12px",
          borderBottom: `1px solid ${barBorder}`,
          background: barBg,
          flexWrap: "wrap",
          rowGap: 8,
          flexShrink: 0,
          zIndex: 2,
        }}
      >
        {mac && (
          <div
            style={{
              position: "absolute",
              left: 16,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              gap: 7,
            }}
          >
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#FF5F57" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#FEBC2E" }} />
            <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#28C840" }} />
          </div>
        )}
        <img
          src="assets/grimodex-logo.svg"
          alt=""
          style={{ height: 24, width: "auto", display: "block" }}
        />
        <button
          type="button"
          style={{
            fontSize: 13,
            color: muted,
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "default",
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Workspace <span style={{ fontSize: 10, opacity: 0.65 }}>⌄</span>
        </button>
        <div style={{ display: "flex", gap: 2 }}>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              color: muted,
              border: `1px solid ${barBorder}`,
              fontSize: 12,
            }}
          >
            ◀
          </span>
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              display: "grid",
              placeItems: "center",
              color: muted,
              border: `1px solid ${barBorder}`,
              fontSize: 12,
            }}
          >
            ▶
          </span>
        </div>
        <button
          type="button"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: muted,
            padding: "4px 8px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "default",
            fontFamily: "inherit",
          }}
        >
          {lpIconFileOutput({ size: 15, color: "rgba(24,24,27,0.55)" })}
          <span>Export</span>
        </button>
        <div style={{ flex: 1, minWidth: 8 }} />
        {presetRow}
        <button
          type="button"
          style={{
            fontSize: 13,
            color: muted,
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "default",
            fontFamily: "inherit",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          Panels <span style={{ fontSize: 10, opacity: 0.65 }}>⌄</span>
        </button>
        <button
          type="button"
          aria-label="Settings"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 13,
            color: muted,
            padding: "4px 8px",
            borderRadius: 6,
            border: "none",
            background: "transparent",
            cursor: "default",
            fontFamily: "inherit",
          }}
        >
          {lpIconSettings({ size: 16, color: "rgba(24,24,27,0.55)" })}
          <span>Settings</span>
        </button>
        {!mac && (
          <>
            <div style={{ width: 1, height: 16, background: barBorder }} />
            <span style={{ fontSize: 11, color: muted }}>─ □ ✕</span>
          </>
        )}
      </div>
      <div
        style={{
          flex: 1,
          minHeight: minHeight,
          display: "flex",
          flexDirection: "column",
          background: "#09090b",
        }}
      >
        {dock}
      </div>
    </div>
  );
}

/* ============================================================
   Variant A — VIVID MAXIMAL
   ============================================================ */

function LPVariantA() {
  const ACCENT_PURPLE = "#534AB7";
  const HOT = "#FF2E63";
  const CYAN = "#00D9C0";
  const MARI = "#FFC233";
  const PAPER = "#F4F0E6";
  const INK = "#0e0d0c";

  return (
    <LPFrame
      bg={PAPER}
      fontFamily="'Space Grotesk', ui-sans-serif, system-ui"
    >
      <style>{`
        @keyframes lp-marquee { from { transform: translateX(0); } to { transform: translateX(-50%); } }
        @keyframes lp-marquee-r { from { transform: translateX(-50%); } to { transform: translateX(0); } }
        @keyframes lp-glide { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-8px); } }
      `}</style>

      {/* NAV */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, background: PAPER, borderBottom: `2px solid ${INK}` }}>
        <div style={{ display: "flex", alignItems: "center", padding: "14px 36px", gap: 24 }}>
          <div style={{ fontWeight: 900, fontSize: 22, letterSpacing: -0.5, color: INK, fontFamily: "'Space Grotesk'" }}>
            <span style={{ background: INK, color: PAPER, padding: "2px 8px", marginRight: 6 }}>Gri</span>modex
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 22, fontSize: 13, color: INK, fontWeight: 500 }}>
            <span>Features</span><span>How it works</span><span>Use cases</span><span>FAQ</span>
          </div>
          <button style={{ background: INK, color: PAPER, border: 0, padding: "10px 18px", fontWeight: 800, fontSize: 13, cursor: "pointer", letterSpacing: 0.3 }}>
            ↓ Download
          </button>
        </div>
      </div>

      {/* HERO */}
      <section style={{ padding: "60px 36px 30px", position: "relative", overflow: "hidden" }}>
        <div style={{ display: "flex", gap: 12, fontSize: 11, fontWeight: 800, letterSpacing: 2, marginBottom: 28 }}>
          <span style={{ background: HOT, color: "#fff", padding: "5px 10px" }}>WRITING</span>
          <span style={{ background: CYAN, color: INK, padding: "5px 10px" }}>FIDGET</span>
          <span style={{ background: MARI, color: INK, padding: "5px 10px" }}>IDE</span>
              <span style={{ marginLeft: "auto", color: INK, opacity: 0.6 }}>v2.0.10 · Electron · Local-first</span>
        </div>

        <Reveal>
          <h1 style={{
            margin: 0,
            fontSize: 156,
            lineHeight: 0.88,
            fontWeight: 900,
            letterSpacing: -5,
            color: INK,
            fontFamily: "'Space Grotesk'",
          }}>
            書いていない<br />
            時間も、<br />
            <span style={{
              background: `linear-gradient(90deg, ${HOT}, ${MARI}, ${CYAN}, ${ACCENT_PURPLE})`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              fontStyle: "italic",
              fontFamily: "'Instrument Serif', 'Times New Roman', serif",
              fontWeight: 400,
            }}>
              書いている。
            </span>
          </h1>
          <div style={{ fontSize: 18, marginTop: 18, color: INK, opacity: 0.7, fontFamily: "'Instrument Serif', serif", fontStyle: "italic", letterSpacing: 0.3 }}>
            Even when you're not writing, you're writing.
          </div>
        </Reveal>

        <Reveal delay={120}>
          <div style={{ display: "flex", marginTop: 36, gap: 36, alignItems: "flex-end" }}>
            <p style={{ fontSize: 19, lineHeight: 1.45, maxWidth: 540, color: INK, margin: 0, fontWeight: 500 }}>
              {COPY.hero_sub_ja}
            </p>
            <p style={{ fontSize: 13, maxWidth: 360, color: INK, opacity: 0.7, margin: 0, fontFamily: "ui-monospace, monospace", lineHeight: 1.55 }}>
              {COPY.hero_sub_en}
            </p>
          </div>
        </Reveal>

        <Reveal delay={220}>
          <div style={{ display: "flex", gap: 14, marginTop: 36, alignItems: "center" }}>
            <button style={{ background: INK, color: PAPER, border: 0, padding: "20px 28px", fontSize: 18, fontWeight: 800, cursor: "pointer", display: "flex", gap: 10 }}>
              ↓ ダウンロード <span style={{ opacity: 0.5 }}>/ Download</span>
            </button>
            <span style={{ fontSize: 13, color: INK, opacity: 0.7, fontFamily: "ui-monospace, monospace" }}>
              macOS · Windows · Linux  ·  Local-first · BYOK
            </span>
          </div>
        </Reveal>
      </section>

      {/* MARQUEE */}
      <div style={{ borderTop: `2px solid ${INK}`, borderBottom: `2px solid ${INK}`, background: ACCENT_PURPLE, color: PAPER, padding: "18px 0", marginTop: 24 }}>
        <Marquee speed={50}>
          {["WRITE", "EXTRACT", "REFERENCE", "REWRITE", "RESOLVE", "REVISE", "RELEASE", "REPEAT"].map((w, i) => (
            <span key={i} style={{ fontSize: 56, fontWeight: 900, letterSpacing: -2 }}>
              {w} <span style={{ color: MARI, fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400 }}>/{i + 1}/</span>
            </span>
          ))}
        </Marquee>
      </div>

      {/* PRODUCT SHOT */}
      <section style={{ padding: "80px 36px" }}>
        <div style={{ display: "flex", alignItems: "flex-end", marginBottom: 28, gap: 24 }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2 }}>§ 01 — THE WORKSPACE</div>
          <div style={{ flex: 1, height: 2, background: INK }} />
          <div style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", opacity: 0.6 }}>shot:001 · workspace layout</div>
        </div>
        <Reveal>
          <h2 style={{ fontSize: 88, fontWeight: 900, lineHeight: 0.92, letterSpacing: -3, margin: "0 0 16px" }}>
            12 paneled.<br />
            <span style={{ fontStyle: "italic", fontFamily: "'Instrument Serif', serif", fontWeight: 400, color: HOT }}>Infinitely</span> arrangable.
          </h2>
        </Reveal>
        <p style={{ fontSize: 16, maxWidth: 640, opacity: 0.8, lineHeight: 1.55, marginBottom: 36 }}>
          Editor、AI Chat、Codex、Map、Timeline、Beats — 12 種類のパネルを Dockview で自由配置。あなたの脳の形に合わせる。
        </p>

        <div style={{ position: "relative" }}>
          <div style={{ position: "absolute", inset: -20, background: `repeating-linear-gradient(45deg, ${INK} 0, ${INK} 2px, transparent 2px, transparent 12px)`, opacity: 0.06, borderRadius: 18 }} />
          <LPAppShellPreview accent={ACCENT_PURPLE} />
        </div>

        {/* Panel list strip */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 24 }}>
          {COPY.panels.map((p, i) => (
            <span key={p} style={{
              padding: "6px 12px",
              border: `2px solid ${INK}`,
              fontSize: 12,
              fontWeight: 700,
              background: i % 4 === 0 ? HOT : i % 4 === 1 ? CYAN : i % 4 === 2 ? MARI : PAPER,
              color: i % 4 === 0 ? "#fff" : INK,
            }}>
              {p}
            </span>
          ))}
        </div>
      </section>

      {/* FEATURES */}
      <section style={{ borderTop: `2px solid ${INK}`, padding: "60px 36px 30px" }}>
        <div style={{ display: "flex", gap: 24, marginBottom: 36, alignItems: "flex-end" }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2 }}>§ 02 — THREE MOVES</div>
          <div style={{ flex: 1, height: 2, background: INK }} />
        </div>
        <h2 style={{ fontSize: 96, lineHeight: 0.9, fontWeight: 900, letterSpacing: -3, margin: "0 0 60px", maxWidth: 1100 }}>
          The <span style={{ fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400, color: ACCENT_PURPLE }}>three</span> moves<br />
          that compound.
        </h2>

        {COPY.features.slice(0, 3).map((f, i) => {
          const colors = [HOT, CYAN, MARI];
          const c = colors[i];
          return (
            <Reveal key={f.no} delay={i * 80}>
              <div style={{
                borderTop: `2px solid ${INK}`,
                padding: "40px 0",
                display: "grid",
                gridTemplateColumns: "120px 1fr 380px",
                gap: 32,
                alignItems: "flex-start",
              }}>
                <div style={{
                  fontSize: 80,
                  fontWeight: 900,
                  lineHeight: 0.85,
                  color: c,
                  letterSpacing: -2,
                }}>
                  {f.no}
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 2, color: INK, opacity: 0.55, marginBottom: 8 }}>
                    {f.kicker_ja} · {f.kicker_en}
                  </div>
                  <h3 style={{ fontSize: 56, lineHeight: 0.95, letterSpacing: -2, fontWeight: 900, margin: "0 0 14px" }}>
                    {f.title_ja.map((line, k) => (
                      <span key={k} style={{ display: "block" }}>{line}</span>
                    ))}
                  </h3>
                  <div style={{ fontSize: 14, fontFamily: "'Instrument Serif',serif", fontStyle: "italic", color: INK, opacity: 0.7, marginBottom: 18 }}>
                    {f.title_en}
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 15, lineHeight: 1.6, margin: "0 0 12px", color: INK }}>{f.body_ja}</p>
                  <p style={{ fontSize: 12, lineHeight: 1.55, margin: 0, color: INK, opacity: 0.6, fontFamily: "ui-monospace, monospace" }}>
                    {f.body_en}
                  </p>
                </div>
              </div>
            </Reveal>
          );
        })}
      </section>

      {/* FLYWHEEL DIAGRAM */}
      <section style={{ background: INK, color: PAPER, padding: "80px 36px", position: "relative", overflow: "hidden" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, marginBottom: 24, opacity: 0.6 }}>§ 03 — THE LOOP</div>
        <h2 style={{ fontSize: 110, fontWeight: 900, lineHeight: 0.9, letterSpacing: -3, margin: "0 0 60px" }}>
          Write. Extract. <br />
          Reference. <span style={{ fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400, color: MARI }}>Repeat.</span>
        </h2>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 0, marginTop: 40, border: `2px solid ${PAPER}` }}>
          {[
            { n: "1", k: "WRITE", c: HOT, t_ja: "本文を書く", t_en: "Draft a scene" },
            { n: "2", k: "CHAT", c: CYAN, t_ja: "AIに相談する", t_en: "Ask the AI" },
            { n: "3", k: "EXTRACT", c: MARI, t_ja: "Codexに抽出", t_en: "Pull to Codex" },
            { n: "4", k: "REFERENCE", c: ACCENT_PURPLE, t_ja: "次の文脈に効く", t_en: "Feeds the next" },
          ].map((s, i) => (
            <div key={s.n} style={{
              padding: "32px 24px 90px",
              borderRight: i < 3 ? `2px solid ${PAPER}` : "none",
              position: "relative",
              minHeight: 240,
            }}>
              <div style={{ fontSize: 14, fontWeight: 800, color: s.c, letterSpacing: 2, marginBottom: 16 }}>
                STEP / {s.n}
              </div>
              <div style={{ fontSize: 44, fontWeight: 900, lineHeight: 0.95, letterSpacing: -1.5 }}>{s.k}</div>
              <div style={{ position: "absolute", bottom: 24, left: 24, right: 24 }}>
                <div style={{ fontSize: 16, fontWeight: 600 }}>{s.t_ja}</div>
                <div style={{ fontSize: 11, opacity: 0.55, fontFamily: "ui-monospace, monospace" }}>{s.t_en}</div>
              </div>
              {i < 3 && (
                <div style={{ position: "absolute", right: -14, top: "50%", transform: "translateY(-50%)", fontSize: 28, fontWeight: 900, color: s.c, background: INK, padding: "0 4px", zIndex: 2 }}>
                  →
                </div>
              )}
              {i === 3 && (
                <div style={{ position: "absolute", right: 24, top: 24, fontSize: 11, color: MARI, fontFamily: "ui-monospace, monospace" }}>
                  ↻ loops back
                </div>
              )}
            </div>
          ))}
        </div>

        <p style={{ fontSize: 16, maxWidth: 720, marginTop: 40, opacity: 0.8, lineHeight: 1.6 }}>
          毎回 0 から始めるプロンプトじゃない。あなたが書いた世界が、毎回プロンプトに乗る。だから長編が破綻しない。
        </p>
      </section>

      {/* ATTRIBUTION */}
      <section style={{ background: PAPER, padding: "80px 36px", borderTop: `2px solid ${INK}` }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, marginBottom: 24 }}>§ 04 — HONEST WRITING</div>
        <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 60, alignItems: "center" }}>
          <div>
            <h2 style={{ fontSize: 96, fontWeight: 900, lineHeight: 0.9, letterSpacing: -3, margin: 0 }}>
              Every <span style={{ color: HOT, fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400 }}>line</span><br />
              knows where<br />
              it came from.
            </h2>
            <p style={{ fontSize: 17, lineHeight: 1.55, marginTop: 24, maxWidth: 540 }}>
              human / ai / unknown のラベルが、文字単位で永続。後から「あれ、これ自分で書いた？」が一目でわかる。AI 時代の、誠実な執筆ツール。
            </p>
          </div>
          {/* Attribution sample */}
          <div style={{ background: "#fff", border: `2px solid ${INK}`, padding: 28, fontSize: 16, lineHeight: 1.85, position: "relative" }}>
            <div style={{ position: "absolute", top: -14, left: 16, background: INK, color: PAPER, fontSize: 11, padding: "4px 10px", letterSpacing: 1.5, fontWeight: 800 }}>
              SCENE 03 / 再会
            </div>
            <div>
              <span style={{ background: "rgba(39,192,142,0.18)", borderBottom: `2px solid #27c08e` }}>三年ぶりの駅に立つと、改札の灯りが滲んで見えた。</span>
              <span style={{ background: `${ACCENT_PURPLE}22`, borderBottom: `2px solid ${ACCENT_PURPLE}` }}>赤い傘が、ホームの端で揺れている。</span>
              <span style={{ background: "rgba(39,192,142,0.18)", borderBottom: `2px solid #27c08e` }}> 律はもう来ているのだろうか。</span>
              <span style={{ background: "rgba(160,160,160,0.18)", borderBottom: `2px dashed #888` }}>雨の音が遠い。</span>
            </div>
            <div style={{ display: "flex", gap: 20, marginTop: 24, fontSize: 11, fontFamily: "ui-monospace,monospace" }}>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#27c08e", marginRight: 6 }} />HUMAN 84%</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: ACCENT_PURPLE, marginRight: 6 }} />AI 14%</span>
              <span><span style={{ display: "inline-block", width: 10, height: 10, background: "#a0a0a0", marginRight: 6 }} />? 2%</span>
            </div>
          </div>
        </div>
      </section>

      {/* USE CASES */}
      <section style={{ background: ACCENT_PURPLE, color: PAPER, padding: "80px 36px" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, marginBottom: 24, opacity: 0.7 }}>§ 05 — WHO IT'S FOR</div>
        <h2 style={{ fontSize: 96, fontWeight: 900, lineHeight: 0.9, letterSpacing: -3, margin: "0 0 50px" }}>
          For the people<br />
          who keep<br />
          <span style={{ fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400, color: MARI }}>making worlds.</span>
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 1, background: PAPER, border: `1px solid ${PAPER}` }}>
          {COPY.usecases.map((u, i) => (
            <div key={u.ja} style={{ background: ACCENT_PURPLE, padding: "28px 20px", minHeight: 240, display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", opacity: 0.6, marginBottom: 12 }}>0{i + 1}</div>
              <div style={{ fontSize: 22, fontWeight: 900, lineHeight: 1.05, marginBottom: 4 }}>{u.ja}</div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 14, fontFamily: "'Instrument Serif',serif", fontStyle: "italic" }}>{u.en}</div>
              <div style={{ fontSize: 12, lineHeight: 1.55, opacity: 0.85, marginTop: "auto" }}>{u.desc_ja}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ background: INK, color: PAPER, padding: "120px 36px", textAlign: "center" }}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 2, marginBottom: 24, opacity: 0.5 }}>§ 06 — NOW</div>
        <h2 style={{ fontSize: 220, lineHeight: 0.85, fontWeight: 900, letterSpacing: -8, margin: "0 0 8px" }}>
          Write<br />
          <span style={{ fontStyle: "italic", fontFamily: "'Instrument Serif',serif", fontWeight: 400, background: `linear-gradient(90deg, ${HOT}, ${MARI}, ${CYAN})`, WebkitBackgroundClip: "text", color: "transparent" }}>
            differently.
          </span>
        </h2>
        <p style={{ fontSize: 18, opacity: 0.7, marginTop: 32, marginBottom: 36 }}>
          Local-first. Bring your own AI key.
        </p>
        <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
          {["macOS .dmg", "Windows .msi", "Linux .AppImage"].map((p, i) => (
            <button key={p} style={{
              background: [HOT, CYAN, MARI][i],
              color: i === 0 ? "#fff" : INK,
              border: 0,
              padding: "20px 28px",
              fontSize: 16,
              fontWeight: 800,
              cursor: "pointer",
              letterSpacing: 0.3,
            }}>
              ↓ {p}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 60, fontSize: 11, opacity: 0.4, fontFamily: "ui-monospace, monospace", letterSpacing: 1 }}>
          GRIMODEX · ELECTRON · LOCAL-FIRST · BYOK · MADE FOR PEOPLE WHO MAKE WORLDS
        </div>
      </section>
    </LPFrame>
  );
}

window.LPVariantA = LPVariantA;
