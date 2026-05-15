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
  cta_sub: "macOS · Windows · Linux  ·  Free  ·  Local-first",

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
        "原稿は SQLite にローカル保存。アカウントは要らない。ネットに出るのは、あなたが押した AI 呼び出しの瞬間だけ。",
      body_en:
        "Manuscripts live in local SQLite. No account. The network only sees the AI calls you trigger yourself.",
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
      a_ja: "OpenRouter 経由で任意。GPT, Claude, Gemini, ローカル LLM まで。鍵はあなたの。",
      a_en: "Any model via OpenRouter — GPT, Claude, Gemini, even local LLMs. Your key, your call.",
    },
    {
      q_ja: "オフラインで動く？",
      q_en: "Does it work offline?",
      a_ja: "編集は完全オフライン。AI 呼び出しの時だけネットに出る。",
      a_en: "Editing is fully offline. The network is only touched when you fire an AI call.",
    },
    {
      q_ja: "値段は？",
      q_en: "How much?",
      a_ja: "本体は無料。AI を使うなら OpenRouter の従量課金だけ。",
      a_en: "Free. AI usage is your OpenRouter pay-as-you-go.",
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

/* ============================================================
   Shared "panel mock" — abstract the Map / Editor / AI shot
   so each variant skins it differently.
   ============================================================ */

function PanelMock({
  theme = "light",
  accent = "#534AB7",
  showTitle = true,
}) {
  const dark = theme === "dark";
  const bg = dark ? "#0e0e10" : "#f6f3ec";
  const ink = dark ? "#f6f3ec" : "#1a1815";
  const sub = dark ? "rgba(246,243,236,0.6)" : "rgba(26,24,21,0.55)";
  const line = dark ? "rgba(246,243,236,0.12)" : "rgba(26,24,21,0.12)";
  const card = dark ? "#181819" : "#ffffff";

  return (
    <div
      style={{
        background: bg,
        color: ink,
        borderRadius: 14,
        boxShadow: dark
          ? "0 30px 60px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.06)"
          : "0 30px 60px -20px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.06)",
        overflow: "hidden",
        position: "relative",
        fontFamily: "ui-sans-serif, system-ui",
      }}
    >
      {/* Window chrome */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: `1px solid ${line}` }}>
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#FF5F57" }} />
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#FEBC2E" }} />
        <span style={{ width: 11, height: 11, borderRadius: "50%", background: "#28C840" }} />
        <span style={{ marginLeft: 14, fontSize: 12, color: sub, fontFamily: "ui-monospace, monospace" }}>
          grimodex · akane-no-kioku.gdx
        </span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: sub, fontFamily: "ui-monospace, monospace" }}>
          ⌘K
        </span>
      </div>

      {/* 3-pane workspace */}
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr 280px", height: 360 }}>
        {/* Sidebar — scenes */}
        <div style={{ borderRight: `1px solid ${line}`, padding: "12px 10px", fontSize: 11 }}>
          <div style={{ color: sub, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8, fontSize: 10 }}>
            Chapters
          </div>
          {[
            { t: "第1章 雨の駅", on: false },
            { t: "第2章 赤い傘", on: false },
            { t: "第3章 再会", on: true },
            { t: "第4章 告白", on: false },
            { t: "第5章 別れ", on: false },
          ].map((s, i) => (
            <div
              key={i}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                background: s.on ? accent : "transparent",
                color: s.on ? "#fff" : ink,
                marginBottom: 2,
                fontWeight: s.on ? 700 : 500,
              }}
            >
              {s.t}
            </div>
          ))}
          <div style={{ color: sub, textTransform: "uppercase", letterSpacing: 1, margin: "16px 0 8px", fontSize: 10 }}>
            Codex
          </div>
          {["七瀬 朱里", "白石 律", "雨宿りの駅", "赤い傘 (伏線)"].map((c, i) => (
            <div key={i} style={{ padding: "5px 8px", color: sub, fontSize: 11 }}>
              · {c}
            </div>
          ))}
        </div>

        {/* Editor */}
        <div style={{ padding: "20px 28px", overflow: "hidden" }}>
          {showTitle && (
            <div style={{ fontSize: 9, letterSpacing: 1.5, color: sub, textTransform: "uppercase" }}>
              CHAPTER 03
            </div>
          )}
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4, marginBottom: 12 }}>
            再会 <span style={{ color: sub, fontSize: 14, fontWeight: 400 }}>· Reunion</span>
          </div>

          <div style={{ fontSize: 13, lineHeight: 1.85, color: ink }}>
            <span>三年ぶりの駅に立つと、改札の灯りが滲んで見えた。</span>
            <span
              style={{
                background: dark ? "rgba(184,255,58,0.16)" : "rgba(83,74,183,0.12)",
                borderBottom: `2px solid ${accent}`,
                padding: "0 2px",
              }}
            >
              赤い傘が、ホームの端で揺れている。
            </span>
            <span> 律はもう来ているのだろうか。雨の音が遠い。</span>
            <br /><br />
            <span style={{ color: sub }}>
              （ AI: 朱里の心拍を地の文に滲ませる方向で、次の段落候補が 3 つあります — Tab で挿入 ）
            </span>
          </div>

          {/* Attribution legend */}
          <div style={{ display: "flex", gap: 14, marginTop: 18, fontSize: 10, color: sub, fontFamily: "ui-monospace, monospace" }}>
            <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#27c08e", marginRight: 5, borderRadius: 2 }} />HUMAN 84%</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, background: accent, marginRight: 5, borderRadius: 2 }} />AI 14%</span>
            <span><span style={{ display: "inline-block", width: 8, height: 8, background: "#a0a0a0", marginRight: 5, borderRadius: 2 }} />UNKNOWN 2%</span>
          </div>
        </div>

        {/* AI chat */}
        <div style={{ borderLeft: `1px solid ${line}`, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "10px 14px", fontSize: 10, letterSpacing: 1, color: sub, textTransform: "uppercase", borderBottom: `1px solid ${line}` }}>
            AI Chat · Scene 03
          </div>
          <div style={{ padding: 14, fontSize: 11.5, lineHeight: 1.55, flex: 1, overflow: "hidden" }}>
            <div style={{ background: dark ? "#1f1f22" : "#efece6", padding: "8px 10px", borderRadius: 8, marginBottom: 8 }}>
              律の声、もっと低くしたい。
            </div>
            <div style={{ background: card, padding: "8px 10px", borderRadius: 8, marginBottom: 8, border: `1px solid ${line}` }}>
              彼の声を低くするなら、語尾を短く切るのが効きます。<br />
              <span style={{ color: accent, fontWeight: 600, fontSize: 10 }}>
                ↳ Codex.白石律 / 性格 を更新しますか？
              </span>
            </div>
            <div style={{ marginTop: 12, display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["Codex+", "本文挿入", "再生成"].map((b) => (
                <span key={b} style={{ padding: "3px 8px", border: `1px solid ${line}`, borderRadius: 99, fontSize: 10, color: sub }}>
                  {b}
                </span>
              ))}
            </div>
          </div>
          <div style={{ borderTop: `1px solid ${line}`, padding: "8px 12px", fontSize: 11, color: sub, fontFamily: "ui-monospace, monospace" }}>
            ⏎ ask · ⌘⏎ insert
          </div>
        </div>
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
          <span style={{ marginLeft: "auto", color: INK, opacity: 0.6 }}>v0.7.0 · Tauri · Local-first</span>
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
              macOS · Windows · Linux  ·  Free
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
          <div style={{ fontSize: 12, fontFamily: "ui-monospace, monospace", opacity: 0.6 }}>shot:001 · 12 panels</div>
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
          <PanelMock theme="light" accent={ACCENT_PURPLE} />
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
          Free. Local-first. Bring your own AI key.
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
          GRIMODEX · TAURI v2 · ELASTIC LICENSE 2.0 · MADE FOR PEOPLE WHO MAKE WORLDS
        </div>
      </section>
    </LPFrame>
  );
}

window.LPVariantA = LPVariantA;
