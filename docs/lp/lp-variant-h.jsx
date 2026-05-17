/* eslint-disable */
/**
 * H · SWISS × ZINE — D's clean massive base, with G's highest-impact zine accents:
 *   yellow #fff200 highlight on key words, JetBrains Mono uppercase labels,
 *   bordered chips, a zbar of verbs, brutalist box-shadow CTA buttons.
 *   Whitespace stays Swiss; punctuation goes zine.
 */

// Screenshots are fed through vite-imagetools at build time so the browser
// receives PNG/WebP/AVIF variants pre-resized with Sharp (Lanczos) instead of
// downscaling a single 4K source on the fly — the latter produces visible
// aliasing on the fine 1px UI lines in the app captures.
import pEditor from "/assets/panel-editor.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pScenes from "/assets/panel-scenes.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pGrid from "/assets/panel-grid.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCodex from "/assets/panel-codex.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pSnippets from "/assets/panel-snippets.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChat from "/assets/panel-chat.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pKouetsu from "/assets/panel-kouetsu.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pTimeline from "/assets/panel-timeline.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMap from "/assets/panel-map.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMatrix from "/assets/panel-matrix.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pTrashBin from "/assets/panel-trash-bin.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChatHistory from "/assets/panel-chat-history.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCodexQuick from "/assets/panel-codex-quick.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pAttribution from "/assets/panel-attribution.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pForeshadow from "/assets/panel-foreshadow.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import psDefault from "/assets/preset-default.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psPlan from "/assets/preset-plan.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psChat from "/assets/preset-chat-main.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psCodex from "/assets/preset-codex-main.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psReview from "/assets/preset-review.png?w=1400;2200;3000&format=avif;webp;png&as=picture";

// Renders the vite-imagetools `?as=picture` payload as a real <picture>,
// preserving the styles/aria props passed by the caller on the inner <img>.
function HPicture({ pic, alt, sizes, style, draggable }) {
  const sources = pic.sources || {};
  const fallback = pic.img || {};
  return (
    <picture>
      {sources.avif && (
        <source type="image/avif" srcSet={sources.avif} sizes={sizes} />
      )}
      {sources.webp && (
        <source type="image/webp" srcSet={sources.webp} sizes={sizes} />
      )}
      <img
        src={fallback.src}
        srcSet={fallback.srcset}
        sizes={sizes}
        width={fallback.w}
        height={fallback.h}
        alt={alt}
        draggable={draggable}
        style={style}
      />
    </picture>
  );
}

const HZ_INK = "#0a0a0a";
const HZ_BG = "#ffffff";
const HZ_HL = "var(--hz-hl, #fff200)";

function HChip({ children, hl, on }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: `1.5px solid ${HZ_INK}`,
        padding: "3px 9px",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: ".06em",
        background: hl ? HZ_HL : on ? HZ_INK : HZ_BG,
        color: on ? HZ_BG : HZ_INK,
      }}
    >
      {children}
    </span>
  );
}

function HZBar({ items }) {
  return (
    <div
      style={{
        display: "flex",
        borderTop: `2px solid ${HZ_INK}`,
        borderBottom: `2px solid ${HZ_INK}`,
      }}
    >
      {items.map((it, i) => {
        const Component = it.href ? "a" : "div";
        return (
          <Component
            key={i}
            href={it.href}
            target={it.href ? "_blank" : undefined}
            rel={it.href ? "noreferrer" : undefined}
            style={{
              flex: it.k ? "0 0 auto" : 1,
              padding: "10px 18px",
              borderRight:
                i < items.length - 1 ? `2px solid ${HZ_INK}` : "none",
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: ".1em",
              background: it.k ? HZ_INK : it.hl ? HZ_HL : HZ_BG,
              color: it.k ? HZ_BG : HZ_INK,
              fontWeight: it.k ? 700 : 400,
              textDecoration: "none",
            }}
          >
            {it.t}
          </Component>
        );
      })}
    </div>
  );
}

function HSectionMark({ tag, kicker }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        marginBottom: 24,
      }}
    >
      <span
        style={{
          background: HZ_INK,
          color: HZ_BG,
          padding: "4px 8px",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".1em",
          fontWeight: 700,
        }}
      >
        {tag}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: ".1em",
          color: "rgba(10,10,10,0.55)",
        }}
      >
        ── {kicker}
      </span>
    </div>
  );
}

function HMotionOK() {
  return !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function HReveal({ children, style, delay = 0, burst = false }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    const gsap = window.gsap;
    if (!el || !gsap) return undefined;
    if (!HMotionOK()) {
      gsap.set(el, {
        autoAlpha: 1,
        y: 0,
        rotateX: 0,
        clipPath: "inset(0% 0% 0% 0%)",
      });
      return undefined;
    }

    const hoverListeners = [];
    const ctx = gsap.context(() => {
      gsap.fromTo(
        el,
        {
          autoAlpha: 0,
          y: burst ? 72 : 44,
          rotateX: burst ? -13 : -4,
          scale: burst ? 0.96 : 1,
          clipPath: "inset(0% 0% 100% 0%)",
          transformOrigin: "50% 0%",
        },
        {
          autoAlpha: 1,
          y: 0,
          rotateX: 0,
          scale: 1,
          clipPath: "inset(0% 0% 0% 0%)",
          duration: burst ? 0.95 : 0.72,
          delay,
          ease: burst ? "expo.out" : "power3.out",
          scrollTrigger: {
            trigger: el,
            start: "top 84%",
            once: true,
          },
        },
      );
    }, el);

    return () => ctx.revert();
  }, [burst, delay]);

  return (
    <div
      ref={ref}
      style={{
        ...style,
        opacity: 0,
        willChange: "transform, opacity, clip-path",
      }}
    >
      {children}
    </div>
  );
}

/* ============================================================
   WORKSPACE SECTION — sticky scroll stage, preset tabs, panel dialog
   Ported from temp/Grimodex_2 design handoff. Pixel-perfect.
   ============================================================ */

const WS_PANELS = {
  Editor: {
    jp: "Editor",
    cat: "次の一行を書く場所。",
    desc: "本文を執筆する中心パネル。AI や設定資料に飲み込まれず、最終的に作品へ落とし込むための主戦場。",
    img: pEditor,
  },
  Scenes: {
    jp: "Scenes",
    cat: "場面を分けて、迷子を減らす。",
    desc: "シーン単位で本文を管理し、長編の構成を扱いやすくするパネル。どこで何が起きているかを見失いにくくする。",
    img: pScenes,
  },
  Grid: {
    jp: "Grid",
    cat: "章とシーンを、カードで見渡す。",
    desc: "章・シーンをカード状に並べる構成ビュー。物語全体の配置や流れを視覚的に確認できる。",
    img: pGrid,
  },
  Codex: {
    jp: "Codex",
    cat: "設定資料が、執筆の外に散らばらない。",
    desc: "キャラクター、世界観、用語、組織などをまとめる設定資料庫。AI に注入される情報源となる。",
    img: pCodex,
  },
  Snippets: {
    jp: "Snippets",
    cat: "まだ本文ではない言葉を、捨てずに持つ。",
    desc: "台詞、描写、アイデア、断片的な文章を保管するパネル。今は使えない一文も、後のシーン素材にできる。",
    img: pSnippets,
  },
  Chat: {
    jp: "Chat",
    cat: "AI に丸投げしない。AI と揉む。",
    desc: "AI との相談用パネル。本文生成よりも、違和感の整理、別案の検討、設定の掘り下げに使う補助空間。",
    img: pChat,
  },
  Review: {
    jp: "Review",
    cat: "作品を、少し離れて見る。",
    desc: "矛盾、弱い動機、説明不足、テンポの乱れなどを確認する校閲・レビュー用パネル。書いた後の違和感を拾う。",
    img: pKouetsu,
  },
  Timeline: {
    jp: "Timeline",
    cat: "出来事の順番を見失わない。",
    desc: "物語内の時系列を管理するパネル。回想、過去設定、章をまたぐ因果関係を整理しやすくする。",
    img: pTimeline,
  },
  Map: {
    jp: "Map",
    cat: "物語の迷子にならない。",
    desc: "付箋、ノード、関係線でアイデアや設定を広げる発散の盤。構造化しすぎず、眺めながら考えるための空間。",
    img: pMap,
  },
  Matrix: {
    jp: "Matrix",
    cat: "関係性を、表で殴る。",
    desc: "Codex エントリ × シーンの言及をマトリクスで一覧化するパネル。どのキャラがどのシーンに登場し、どの設定がどこで触れられているかを俯瞰できる。",
    img: pMatrix,
  },
  TrashBin: {
    jp: "Trash Bin",
    cat: "没案も、まだ死んでいない。",
    desc: "削除した断片や使わなかった文章を一時的に保持するパネル。完全な廃棄ではなく、再利用可能な創作残骸として扱う。",
    img: pTrashBin,
  },
  ChatHistory: {
    jp: "Chat History",
    cat: "AI との思考ログを、作品の横に残す。",
    desc: "AI との過去のやり取りを確認するパネル。相談の流れ、出てきた案、却下した方向性などを振り返り、執筆判断の履歴として扱える。",
    img: pChatHistory,
  },
  CodexQuick: {
    jp: "Codex Quick",
    cat: "今のシーンに必要な設定だけ、一覧で。",
    desc: "Codex の情報を素早く参照するための簡易パネル。シーンに登場するキャラクター名・用語・設定だけをリストアップ。",
    img: pCodexQuick,
  },
  Attribution: {
    jp: "Attribution",
    cat: "何を使い、どこから来たかを見える化する。",
    desc: "AI / Human(人間) / Unknown(コピペ) の割合をグラフ化するパネル。AI の使用率を俯瞰できる。",
    img: pAttribution,
  },
  Foreshadow: {
    jp: "Foreshadow",
    cat: "伏線を、置いたまま忘れない。",
    desc: "伏線、回収予定、未解決の要素を管理するパネル。思いつきで置いた仕込みを後から追跡し、放置や回収漏れを防ぐ。さらに、回収シーンで「どこに setup を仕込むべきか」を AI に提案させられる。",
    img: pForeshadow,
  },
};

const WS_ALL_PANEL_KEYS = [
  "Editor",
  "Scenes",
  "Grid",
  "Codex",
  "CodexQuick",
  "Snippets",
  "Chat",
  "ChatHistory",
  "Review",
  "Timeline",
  "Map",
  "Matrix",
  "Attribution",
  "Foreshadow",
  "TrashBin",
];

const WS_PRESETS = [
  {
    id: "write",
    label: "WRITE",
    num: "01",
    desc: "本文 + Codex + Chat。中心は本文。設定資料と相談相手を脇に置く、執筆中心のレイアウト。",
    img: psDefault,
  },
  {
    id: "plan",
    label: "PLAN",
    num: "02",
    desc: "Grid + Map + Timeline。章とシーンを並べ、時系列と関係性で俯瞰する構成のレイアウト。",
    img: psPlan,
  },
  {
    id: "chat",
    label: "CHAT",
    num: "03",
    desc: "Chat を中央へ。設定の掘り下げ、別案の検討、違和感の整理を広いキャンバスで。",
    img: psChat,
  },
  {
    id: "codex",
    label: "CODEX",
    num: "04",
    desc: "Codex を中央へ。キャラクター・場所・用語を本文の隣に置いて編集する、設定編みのレイアウト。",
    img: psCodex,
  },
  {
    id: "review",
    label: "REVIEW",
    num: "05",
    desc: "Review + Attribution。矛盾、説明不足、由来の不明な箇所を拾う、読み返しのレイアウト。",
    img: psReview,
  },
];

// Scroll-driven values for the sticky workspace stage are written directly
// to DOM nodes via refs (see `HWorkspaceSection`). React state updates per
// scroll frame caused noticeable jank in earlier iterations because the
// whole section re-rendered on every wheel tick.

const WS_DIALOG_BTN_STYLE = {
  background: HZ_BG,
  color: HZ_INK,
  border: `2px solid ${HZ_INK}`,
  width: 34,
  height: 34,
  cursor: "pointer",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 14,
  fontWeight: 700,
  display: "grid",
  placeItems: "center",
};

function WSPanelDialog({ openKey, onClose, onNav }) {
  const idx = openKey ? WS_ALL_PANEL_KEYS.indexOf(openKey) : -1;
  const prev =
    idx >= 0
      ? WS_ALL_PANEL_KEYS[
          (idx - 1 + WS_ALL_PANEL_KEYS.length) % WS_ALL_PANEL_KEYS.length
        ]
      : null;
  const next =
    idx >= 0 ? WS_ALL_PANEL_KEYS[(idx + 1) % WS_ALL_PANEL_KEYS.length] : null;
  const overlayRef = useRef(null);
  const closeBtnRef = useRef(null);
  const previousFocusRef = useRef(null);

  useEffect(() => {
    if (!openKey) return undefined;
    previousFocusRef.current = document.activeElement;
    const focusFrame = requestAnimationFrame(() => {
      closeBtnRef.current?.focus?.();
    });
    const onKey = (e) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        onNav(prev);
        return;
      }
      if (e.key === "ArrowRight") {
        onNav(next);
        return;
      }
      if (e.key === "Tab") {
        const root = overlayRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll(
            'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      const restore = previousFocusRef.current;
      if (restore && typeof restore.focus === "function") {
        restore.focus();
      }
    };
  }, [openKey, prev, next, onClose, onNav]);

  if (!openKey) return null;
  const p = WS_PANELS[openKey];

  return (
    <div
      ref={overlayRef}
      onClick={onClose}
      className="ws-dialog-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(10,10,10,0.78)",
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: "3vh 2vw",
        animation: "ws-fade .18s ease-out",
        backdropFilter: "blur(2px)",
      }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNav(prev);
        }}
        aria-label="前のパネル"
        className="ws-carousel-btn ws-carousel-btn--prev"
      >
        <span style={{ fontSize: 22, lineHeight: 1, marginBottom: 2 }}>←</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: ".08em",
            opacity: 0.6,
          }}
        >
          {WS_PANELS[prev].jp.toUpperCase()}
        </span>
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onNav(next);
        }}
        aria-label="次のパネル"
        className="ws-carousel-btn ws-carousel-btn--next"
      >
        <span style={{ fontSize: 22, lineHeight: 1, marginBottom: 2 }}>→</span>
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: ".08em",
            opacity: 0.6,
          }}
        >
          {WS_PANELS[next].jp.toUpperCase()}
        </span>
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="ws-dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ws-dialog-title"
        style={{
          background: HZ_BG,
          color: HZ_INK,
          width: "min(1560px, 100%)",
          maxHeight: "94vh",
          overflow: "hidden",
          border: `2px solid ${HZ_INK}`,
          boxShadow: `8px 8px 0 ${HZ_INK}`,
          display: "grid",
          gridTemplateRows: "auto 1fr",
          animation: "ws-pop .22s cubic-bezier(.2,.9,.3,1.2)",
          fontFamily:
            "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderBottom: `2px solid ${HZ_INK}`,
            padding: "12px 18px",
            gap: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                background: HZ_INK,
                color: HZ_BG,
                padding: "4px 10px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".1em",
              }}
            >
              P / {String(idx + 1).padStart(2, "0")}
            </span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                opacity: 0.55,
                textTransform: "uppercase",
                letterSpacing: ".08em",
              }}
            >
              ── {p.jp}
            </span>
          </div>
          <button
            ref={closeBtnRef}
            onClick={onClose}
            aria-label="閉じる"
            style={{
              ...WS_DIALOG_BTN_STYLE,
              background: HZ_INK,
              color: HZ_BG,
            }}
          >
            ×
          </button>
        </div>
        <div
          className="ws-dialog-content"
          style={{
            display: "grid",
            gridTemplateColumns: "2.1fr 1fr",
            minHeight: 0,
          }}
        >
          <div
            className="ws-dialog-image"
            style={{
              borderRight: `2px solid ${HZ_INK}`,
              background: HZ_BG,
              display: "grid",
              placeItems: "stretch",
              overflow: "hidden",
            }}
          >
            <HPicture
              pic={p.img}
              alt={p.jp}
              sizes="(max-width: 900px) 100vw, 60vw"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                display: "block",
                maxHeight: "86vh",
              }}
            />
          </div>
          <div
            className="ws-dialog-body"
            style={{ padding: "28px 28px 32px", overflow: "auto" }}
          >
            <h3
              id="ws-dialog-title"
              style={{
                margin: "0 0 18px",
                fontSize: 28,
                fontWeight: 800,
                letterSpacing: -0.8,
                lineHeight: 1.1,
              }}
            >
              <span style={{ background: HZ_HL, padding: "0 8px" }}>
                {p.jp}
              </span>
            </h3>
            <p style={{ fontSize: 16, lineHeight: 1.85, margin: 0 }}>
              {p.desc}
            </p>
            <div
              style={{
                marginTop: 28,
                paddingTop: 18,
                borderTop: `1.5px dashed ${HZ_INK}`,
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                opacity: 0.55,
                textTransform: "uppercase",
                letterSpacing: ".08em",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>← / → で別パネル · ESC で閉じる</span>
              <span>
                {idx + 1} / {WS_ALL_PANEL_KEYS.length}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Sticky stage runway, mapped against the section's scrollable height (= height - 100vh).
// The animation plays through ANIM_END, then `progress` stays at 1 for the rest of the
// runway — that tail is the "look at the full screenshot" dwell zone before page-snap
// hands the user off to the next section.
// Dwell zone tuning: total stage = `WS_STAGE_VH`; sticky animation
// completes at `WS_ANIM_END` of the runway, then `progress` stays at 1
// for the remainder. Reducing stage_vh or pushing anim_end toward 1
// shortens that "stuck scrolling" feel after the animation finishes.
const WS_STAGE_VH = 220;
const WS_ANIM_END = 0.65;

function HWorkspaceSection() {
  const stageRef = useRef(null);
  const marketingRef = useRef(null);
  const copyRef = useRef(null);
  const stageInnerRef = useRef(null);
  const frameRef = useRef(null);
  const chipsRef = useRef(null);
  const [preset, setPreset] = useState("write");
  const [openPanel, setOpenPanel] = useState(null);

  const shown = WS_PRESETS.find((x) => x.id === preset);

  // Drive scroll-based styles directly on DOM nodes — bypassing React's
  // render cycle keeps the sticky animation at 60fps. Setting state per
  // scroll frame previously triggered a full subtree re-render and dropped
  // frames noticeably on long sessions.
  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const vh = window.innerHeight;
      const denom = rect.height - vh;
      let raw;
      if (denom <= 0) raw = rect.top <= 0 ? 1 : 0;
      else raw = -rect.top / denom;
      raw = Math.max(0, Math.min(1, raw));
      const progress = Math.min(raw / WS_ANIM_END, 1);

      const copyOpacity = Math.max(0, 1 - progress * 1.7);
      const copyScale = 1 - progress * 0.55;
      const copyTx = progress * 40;
      const copyTy = -progress * 24;
      const shotW = 42 + progress * 54;
      const shotShadow = (1 - progress) * 12;
      const chipStripOpacity = Math.min(
        1,
        Math.max(0, (progress - 0.35) / 0.4),
      );

      const marketing = marketingRef.current;
      if (marketing) {
        const inv = 1 - copyOpacity;
        marketing.style.opacity = String(inv);
        marketing.style.pointerEvents = inv > 0.1 ? "auto" : "none";
      }
      const copy = copyRef.current;
      if (copy) {
        copy.style.transform = `translate(${copyTx}px, ${copyTy}px) scale(${copyScale})`;
        copy.style.opacity = String(copyOpacity);
        copy.style.pointerEvents = copyOpacity < 0.1 ? "none" : "auto";
      }
      const stageInner = stageInnerRef.current;
      if (stageInner) {
        stageInner.style.width = `${shotW}%`;
      }
      const frame = frameRef.current;
      if (frame) {
        frame.style.boxShadow =
          shotShadow > 1
            ? `${shotShadow}px ${shotShadow}px 0 ${HZ_INK}`
            : "none";
      }
      const chips = chipsRef.current;
      if (chips) {
        chips.style.opacity = String(chipStripOpacity);
        chips.style.pointerEvents = chipStripOpacity > 0.5 ? "auto" : "none";
      }
    };

    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <section
      ref={stageRef}
      id="workspace"
      data-hz-page
      data-hz-workspace
      style={{
        // z-index 26 lifts the whole section above the page-wide texture
        // overlay (z-index 25). Necessary because the inner sticky div
        // creates a stacking context that trapped any z-index attempts on
        // `.ws-stage` — they never reached the root. Section bg is plain
        // white so losing texture inside the section is visually neutral.
        position: "relative",
        zIndex: 26,
        height: `${WS_STAGE_VH}vh`,
        color: HZ_INK,
        background: HZ_BG,
        borderTop: `2px solid ${HZ_INK}`,
        fontFamily:
          "'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif",
      }}
    >
      <style>{`
        @keyframes ws-fade { from { opacity: 0 } to { opacity: 1 } }
        @keyframes ws-pop { from { opacity: 0; transform: translateY(14px) scale(.97) } to { opacity: 1; transform: none } }
        [data-hz-workspace] { scroll-snap-align: none !important; scroll-snap-stop: normal !important; }
        .ws-carousel-btn { position: fixed; top: 50%; transform: translateY(-50%); z-index: 1001; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0; width: 56px; height: 72px; background: ${HZ_BG}; color: ${HZ_INK}; border: 2px solid ${HZ_INK}; box-shadow: 4px 4px 0 ${HZ_INK}; cursor: pointer; padding: 8px 6px; transition: background .14s, box-shadow .14s, transform .14s; font-family: 'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif; font-weight: 800; }
        .ws-carousel-btn--prev { left: calc(2vw + 8px); }
        .ws-carousel-btn--next { right: calc(2vw + 8px); }
        .ws-carousel-btn:hover { background: ${HZ_HL}; box-shadow: 6px 6px 0 ${HZ_INK}; transform: translateY(-50%) translate(-2px, -2px); }
        .ws-carousel-btn:active { box-shadow: 2px 2px 0 ${HZ_INK}; transform: translateY(-50%) translate(1px, 1px); }
        .ws-tab { flex: 1; border: none; background: ${HZ_BG}; color: ${HZ_INK}; cursor: pointer; font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; padding: 10px 14px; text-align: left; display: flex; flex-direction: column; gap: 2px; transition: background .12s; }
        .ws-tab:hover { background: ${HZ_HL}; }
        .ws-tab.active, .ws-tab[aria-pressed="true"] { background: ${HZ_INK}; color: ${HZ_BG}; }
        .ws-tab + .ws-tab { border-left: 2px solid ${HZ_INK}; }
        .ws-chip { font-family: 'JetBrains Mono', monospace; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; padding: 9px 14px; border: 2px solid ${HZ_INK}; background: ${HZ_BG}; color: ${HZ_INK}; cursor: pointer; transition: transform .14s, box-shadow .14s, background .14s; white-space: nowrap; box-shadow: 3px 3px 0 ${HZ_INK}; position: relative; }
        .ws-chip::after { content: "↗"; margin-left: 8px; opacity: 0.45; transition: opacity .14s, transform .14s; display: inline-block; }
        .ws-chip:hover { background: ${HZ_HL}; transform: translate(-2px, -2px); box-shadow: 5px 5px 0 ${HZ_INK}; }
        .ws-chip:hover::after { opacity: 1; transform: translate(2px, -2px); }
        .ws-chip:active { transform: translate(1px, 1px); box-shadow: 2px 2px 0 ${HZ_INK}; }

        /* Mobile / narrow tablet: tighten paddings, hide the desktop-only
           carousel buttons (chip strip below still navigates), stack the
           dialog body. */
        @media (max-width: 900px) {
          .ws-marker { top: 16px !important; left: 20px !important; }
          .ws-marketing { top: 14px !important; right: 20px !important; }
          .ws-copy { top: 56px !important; left: 20px !important; right: 20px !important; }
          .ws-stage { width: 96% !important; bottom: 16px !important; }
          .ws-tab { padding: 8px 10px !important; font-size: 10px !important; }
          .ws-tab-meta { display: none !important; }
          .ws-chip { font-size: 11px !important; padding: 7px 10px !important; box-shadow: 2px 2px 0 ${HZ_INK} !important; }
          .ws-dialog-overlay { padding: 6vh 12px !important; }
          .ws-dialog-content { grid-template-columns: 1fr !important; grid-template-rows: auto 1fr !important; }
          .ws-dialog-image { border-right: none !important; border-bottom: 2px solid ${HZ_INK} !important; max-height: 38vh !important; }
          .ws-dialog-image img { max-height: 38vh !important; }
          .ws-dialog-body { padding: 18px !important; }
          .ws-carousel-btn { display: none !important; }
        }
      `}</style>

      <div
        style={{
          position: "sticky",
          top: 0,
          height: "100vh",
          overflow: "hidden",
        }}
      >
        <div className="ws-tex-halftone-local" aria-hidden="true" />
        <div className="ws-tex-grain-local" aria-hidden="true" />
        <div
          className="ws-marker"
          style={{
            position: "absolute",
            top: 28,
            left: 48,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            textTransform: "uppercase",
            letterSpacing: ".1em",
          }}
        >
          <span
            style={{
              background: HZ_INK,
              color: HZ_BG,
              padding: "4px 8px",
              fontWeight: 700,
            }}
          >
            B / 02
          </span>
          <span style={{ opacity: 0.55 }}>── WORKSPACE</span>
        </div>

        <div
          ref={marketingRef}
          className="ws-marketing"
          style={{
            position: "absolute",
            top: 24,
            right: 48,
            zIndex: 5,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            fontWeight: 700,
            textTransform: "uppercase",
            letterSpacing: ".1em",
            background: HZ_HL,
            color: HZ_INK,
            padding: "4px 10px",
            border: `2px solid ${HZ_INK}`,
            opacity: 0,
            pointerEvents: "none",
          }}
        >
          15 PANELS · ONE DESK
        </div>

        <div
          ref={copyRef}
          className="ws-copy"
          style={{
            position: "absolute",
            top: 78,
            left: 48,
            right: 48,
            transformOrigin: "left top",
            transform: "translate(0px, 0px) scale(1)",
            opacity: 1,
            pointerEvents: "auto",
            zIndex: 3,
            willChange: "transform, opacity",
          }}
        >
          <h2
            style={{
              fontSize: "clamp(72px, 11vw, 144px)",
              lineHeight: 0.9,
              fontWeight: 800,
              letterSpacing: "-0.035em",
              margin: "0 0 18px",
            }}
          >
            <span
              style={{
                background: HZ_HL,
                padding: "0 12px",
                display: "inline-block",
                lineHeight: 0.95,
              }}
            >
              15 PANELS.
            </span>
            <br />
            ONE DESK.
          </h2>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.65,
              opacity: 0.78,
              maxWidth: 680,
              margin: 0,
            }}
          >
            Editor、Codex、Map、Chat、Grid
            などを自由に並べ替えられる作業レイアウト。プリセットでレイアウトを瞬時に切り替えられる。執筆、整理、発散、相談をひとつの画面内で行き来できる。
          </p>
        </div>

        <div
          ref={stageInnerRef}
          className="ws-stage"
          style={{
            position: "absolute",
            bottom: 28,
            left: "50%",
            transform: "translateX(-50%)",
            width: "42%",
            maxWidth: 1640,
            zIndex: 2,
            willChange: "width",
          }}
        >
          <div
            className="ws-tabs"
            style={{
              display: "flex",
              borderTop: `2px solid ${HZ_INK}`,
              borderLeft: `2px solid ${HZ_INK}`,
              borderRight: `2px solid ${HZ_INK}`,
              background: HZ_BG,
            }}
          >
            {WS_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`ws-tab ${preset === p.id ? "active" : ""}`}
                onClick={() => setPreset(p.id)}
                aria-pressed={preset === p.id}
              >
                <span
                  className="ws-tab-meta"
                  style={{ opacity: 0.55, fontSize: 9 }}
                >
                  PRESET · {p.num}
                </span>
                <span>{p.label}</span>
              </button>
            ))}
          </div>

          <div
            ref={frameRef}
            style={{
              position: "relative",
              border: `2px solid ${HZ_INK}`,
              boxShadow: `12px 12px 0 ${HZ_INK}`,
              background: "#1a1a1a",
              aspectRatio: "16 / 9",
            }}
          >
            <HPicture
              pic={shown.img}
              alt={shown.label}
              sizes="96vw"
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                objectFit: "cover",
                userSelect: "none",
                pointerEvents: "none",
              }}
            />
          </div>

          <div
            className="ws-caption"
            style={{
              padding: "12px 16px",
              borderLeft: `2px solid ${HZ_INK}`,
              borderRight: `2px solid ${HZ_INK}`,
              borderBottom: `2px solid ${HZ_INK}`,
              display: "flex",
              alignItems: "center",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                background: HZ_INK,
                color: HZ_BG,
                padding: "3px 9px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                fontWeight: 700,
                textTransform: "uppercase",
                letterSpacing: ".08em",
              }}
            >
              {shown.num} · {shown.label}
            </span>
            <span
              style={{ fontSize: 13, lineHeight: 1.55, flex: 1, minWidth: 280 }}
            >
              {shown.desc}
            </span>
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                opacity: 0.55,
                textTransform: "uppercase",
                letterSpacing: ".06em",
              }}
            >
              ↓ 15 PANELS から開く
            </span>
          </div>

          <div
            ref={chipsRef}
            className="ws-chips"
            style={{
              marginTop: 22,
              opacity: 0,
              pointerEvents: "none",
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
            }}
          >
            <span
              style={{
                background: HZ_INK,
                color: HZ_BG,
                padding: "5px 10px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 800,
                textTransform: "uppercase",
                letterSpacing: ".1em",
                marginRight: 4,
              }}
            >
              ALL 15 PANELS ↓
            </span>
            {WS_ALL_PANEL_KEYS.map((k) => (
              <button
                key={k}
                className="ws-chip"
                onClick={() => setOpenPanel(k)}
              >
                {WS_PANELS[k].jp}
              </button>
            ))}
          </div>
        </div>
      </div>

      <WSPanelDialog
        openKey={openPanel}
        onClose={() => setOpenPanel(null)}
        onNav={(k) => setOpenPanel(k)}
      />
    </section>
  );
}

function LPVariantH() {
  const [workflowMode, setWorkflowMode] = useState("plotter");
  const workflowGridRef = useRef(null);
  const pagingLockRef = useRef(false);
  const navRef = useRef(null);
  const heroTitleRef = useRef(null);
  const heroMetaRef = useRef(null);
  const heroBodyRef = useRef(null);
  const heroEchoRef = useRef(null);

  // Always start at the top on initial load, even if the URL has a fragment
  // like #workspace. The hero animation is part of the brand and the page
  // would feel broken if it played offscreen while the user is scrolled away.
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.scrollTo(0, 0);
      });
    });
  }, []);

  useEffect(() => {
    const gsap = window.gsap;
    if (!gsap || !HMotionOK()) return undefined;

    const hoverListeners = [];
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".hz-nav-link",
        { y: -18, autoAlpha: 0 },
        {
          y: 0,
          autoAlpha: 1,
          duration: 0.5,
          stagger: 0.045,
          ease: "back.out(1.8)",
          delay: 0.15,
        },
      );
      gsap.fromTo(
        ".hz-micro",
        { y: 22, autoAlpha: 0, rotate: -1.5 },
        {
          y: 0,
          autoAlpha: 1,
          rotate: 0,
          duration: 0.56,
          stagger: 0.04,
          ease: "power3.out",
          delay: 0.5,
        },
      );

      gsap.utils.toArray(".hz-pop").forEach((target) => {
        const enter = () =>
          gsap.to(target, {
            y: -4,
            scale: 1.035,
            duration: 0.18,
            ease: "power2.out",
          });
        const leave = () =>
          gsap.to(target, {
            y: 0,
            scale: 1,
            duration: 0.18,
            ease: "power2.out",
          });
        target.addEventListener("mouseenter", enter);
        target.addEventListener("mouseleave", leave);
        hoverListeners.push([target, enter, leave]);
      });
    });

    return () => {
      hoverListeners.forEach(([target, enter, leave]) => {
        target.removeEventListener("mouseenter", enter);
        target.removeEventListener("mouseleave", leave);
      });
      ctx.revert();
    };
  }, []);

  useEffect(() => {
    const gsap = window.gsap;
    const title = heroTitleRef.current;
    const heroBits = [heroMetaRef.current, heroBodyRef.current].filter(Boolean);
    if (!title || !gsap) {
      // Hero animation can't run — make sure the NAV and texture overlays
      // (which we render hidden) still become visible so the page isn't
      // missing chrome.
      if (navRef.current) navRef.current.style.opacity = "1";
      document.documentElement.style.setProperty("--tex-halftone-op", "0.06");
      document.documentElement.style.setProperty("--tex-grain-op", "0.1");
      return undefined;
    }

    const lines = title.querySelectorAll("[data-hz-hero-line]");
    const marker = title.querySelector("[data-hz-hero-marker]");
    const nav = navRef.current;
    const echo = heroEchoRef.current;
    const docEl = document.documentElement;
    if (!HMotionOK()) {
      gsap.set([title, ...heroBits], { clearProps: "all", autoAlpha: 1 });
      gsap.set(lines, { autoAlpha: 1, y: 0, rotateX: 0 });
      gsap.set(marker, { "--hero-marker-scale": 1 });
      if (nav) gsap.set(nav, { clearProps: "all", autoAlpha: 1 });
      if (echo) gsap.set(echo, { clearProps: "all", autoAlpha: 1 });
      gsap.set(docEl, { "--tex-halftone-op": 0.06, "--tex-grain-op": 0.1 });
      return undefined;
    }

    const ctx = gsap.context(() => {
      const rect = title.getBoundingClientRect();
      const navHeight =
        document.querySelector("[data-hz-nav]")?.getBoundingClientRect()
          .height ?? 0;
      const centeredX = window.innerWidth / 2 - (rect.left + rect.width / 2);
      // On narrow viewports the hero grid stacks tall; including the whole
      // column in vertical center math makes `(vh - groupHeight)` strongly
      // negative and shoves headline+meta to the viewport top ("埋もれる").
      // Center headline + meta only; body keeps natural flow below them.
      const narrowHeroCenter =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(max-width: 900px)").matches;
      const heroMetaOnly = heroMetaRef.current;
      const centerTargets = narrowHeroCenter
        ? [title, ...(heroMetaOnly ? [heroMetaOnly] : [])]
        : [title, ...heroBits];
      const groupRects = centerTargets.map((element) =>
        element.getBoundingClientRect(),
      );
      const groupTop = Math.min(
        ...groupRects.map((groupRect) => groupRect.top),
      );
      const groupBottom = Math.max(
        ...groupRects.map((groupRect) => groupRect.bottom),
      );
      const groupHeight = groupBottom - groupTop;
      const availableHeight = window.innerHeight - navHeight;
      const centerCorrection = Math.min(
        96,
        Math.max(48, availableHeight * 0.065),
      );
      const finalY =
        navHeight +
        (availableHeight - groupHeight) / 2 -
        groupTop +
        centerCorrection;

      gsap.set(heroBits, { autoAlpha: 0, y: finalY + 28 });
      gsap.set(lines, {
        autoAlpha: 0,
        y: 34,
        rotateX: -9,
        transformOrigin: "50% 50%",
      });
      gsap.set(marker, { "--hero-marker-scale": 0 });

      gsap.set(title, {
        x: centeredX,
        y: finalY,
        transformOrigin: "50% 50%",
        willChange: "transform",
      });
      if (nav) gsap.set(nav, { autoAlpha: 0, y: -12 });
      // Echo starts BIG and offset leftward toward the centered title
      // (x: -vw*0.18). Motion is horizontal-only — the echo rides the title
      // shift in mirror back to its tiny resting spot on the right edge.
      if (echo) {
        gsap.set(echo, {
          autoAlpha: 0,
          "--echo-size": "clamp(56px, 9vw, 96px)",
          x: -window.innerWidth * 0.18,
        });
      }

      const tl = gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .to(lines, {
          autoAlpha: 1,
          y: 0,
          rotateX: 0,
          duration: 0.9,
          stagger: 0.48,
        })
        .to(
          marker,
          {
            "--hero-marker-scale": 1,
            duration: 0.68,
            ease: "power3.out",
          },
          "+=0",
        );
      tl.to(
        title,
        {
          x: 0,
          duration: 1.18,
          ease: "expo.inOut",
        },
        "+=0.18",
      );
      // Echo rides the title shift in mirror — shrinks + drifts back up to
      // its top-right resting spot with the same duration and easing, so the
      // two motions stay locked. autoAlpha fades up DURING the motion so the
      // echo materializes as it moves rather than sitting visibly idle first.
      if (echo) {
        tl.to(
          echo,
          {
            "--echo-size": "14px",
            x: 0,
            autoAlpha: 1,
            duration: 1.18,
            ease: "expo.inOut",
          },
          "<",
        );
      }
      tl.to(
        heroBits,
        {
          autoAlpha: 1,
          y: finalY,
          duration: 0.72,
          stagger: 0.12,
          ease: "power3.out",
        },
        "+=0.06",
      );
      // NAV reveals together with the hero body bits — page "opens up"
      // once the title settles, instead of being there from frame zero.
      if (nav) {
        tl.to(
          nav,
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.55,
            ease: "power3.out",
          },
          "<",
        );
      }
      // Texture overlays fade in alongside the NAV — the page becomes
      // "printed paper" only after the intro completes. CSS vars drive
      // BOTH the page-wide fixed overlay and the workspace-local overlays
      // simultaneously, so the texture stays consistent across the
      // stacking-context boundary at the workspace section.
      tl.to(
        docEl,
        {
          "--tex-halftone-op": 0.06,
          "--tex-grain-op": 0.1,
          duration: 0.7,
          ease: "power2.out",
        },
        "<",
      );
    }, title);

    return () => ctx.revert();
  }, []);

  useEffect(() => {
    const gsap = window.gsap;
    const target = workflowGridRef.current;
    if (!gsap || !target || !HMotionOK()) return undefined;

    const tween = gsap.fromTo(
      target.children,
      { y: 26, autoAlpha: 0, rotate: -1.5 },
      {
        y: 0,
        autoAlpha: 1,
        rotate: 0,
        duration: 0.38,
        stagger: 0.055,
        ease: "back.out(1.7)",
      },
    );
    return () => tween.kill();
  }, [workflowMode]);

  useEffect(() => {
    const pageSelector = "[data-hz-page]";
    const navSelector = "[data-hz-nav]";

    const getPages = () => Array.from(document.querySelectorAll(pageSelector));
    const getNavOffset = () =>
      document.querySelector(navSelector)?.getBoundingClientRect().height ?? 0;
    const getCurrentIndex = (pages) => {
      // Pick the latest page whose start has scrolled past the nav.
      // For tall sticky sections (Workspace = 220vh), this keeps "current"
      // pinned to the section the user is actually inside, instead of jumping
      // to the next section as soon as its top kisses the viewport.
      const navOffset = getNavOffset();
      const cursor = window.scrollY + navOffset + 1;
      let idx = 0;
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].offsetTop <= cursor) idx = i;
      }
      return idx;
    };

    const goToPage = (direction) => {
      const pages = getPages();
      if (pages.length === 0 || pagingLockRef.current) return false;

      const current = getCurrentIndex(pages);
      const next = Math.min(Math.max(current + direction, 0), pages.length - 1);
      if (next === current) return false;

      const target = pages[next];
      const navOffset = getNavOffset();
      // When entering a sticky stage from below, land at its END so scrolling
      // up reveals the animation; from above, land at its START.
      const isWorkspace = target.hasAttribute("data-hz-workspace");
      let top;
      if (isWorkspace && direction < 0) {
        top = target.offsetTop + target.offsetHeight - window.innerHeight;
      } else {
        top = target.offsetTop - navOffset;
      }

      pagingLockRef.current = true;
      window.scrollTo({
        top: Math.max(0, top),
        behavior: HMotionOK() ? "smooth" : "auto",
      });
      window.setTimeout(
        () => {
          pagingLockRef.current = false;
        },
        HMotionOK() ? 720 : 120,
      );
      return true;
    };

    // Workspace section runs a tall sticky stage — page-snap must stand down
    // while the user is scrolling through its interior, otherwise the scroll
    // jumps past the sticky animation in one wheel tick. The thresholds use
    // navOffset (not 0) because goToPage lands users at `offsetTop - navOffset`,
    // making rect.top ≈ navOffset on entry, not 0.
    const isInsideWorkspaceStage = (direction) => {
      const stage = document.querySelector("[data-hz-workspace]");
      if (!stage) return false;
      const rect = stage.getBoundingClientRect();
      const vh = window.innerHeight;
      const navOffset = getNavOffset();
      const epsilon = 4;
      if (direction > 0) {
        // scrolling down: stay native from entry until the stage bottom reaches viewport bottom
        return rect.top <= navOffset + epsilon && rect.bottom > vh + epsilon;
      }
      // scrolling up: stay native from end-of-sticky until the stage top reaches the nav
      return rect.top < navOffset - epsilon && rect.bottom >= vh - epsilon;
    };

    const onWheel = (event) => {
      if (
        Math.abs(event.deltaY) < 18 ||
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
      )
        return;
      if (pagingLockRef.current) return;
      if (isInsideWorkspaceStage(event.deltaY > 0 ? 1 : -1)) return;
      if (goToPage(event.deltaY > 0 ? 1 : -1)) {
        event.preventDefault();
      }
    };

    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (["ArrowDown", "PageDown", " "].includes(event.key)) {
        if (isInsideWorkspaceStage(1)) return;
        if (goToPage(1)) event.preventDefault();
      }
      if (["ArrowUp", "PageUp"].includes(event.key)) {
        if (isInsideWorkspaceStage(-1)) return;
        if (goToPage(-1)) event.preventDefault();
      }
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const workflowSteps = {
    plotter: [
      {
        n: "01",
        k: "DESIGN",
        jp: "設計",
        role: "entry",
        t: "キャラ・世界観・設定を、本文より先に固める。",
        panels: ["Codex", "Chat", "Map"],
      },
      {
        n: "02",
        k: "OUTLINE",
        jp: "構成",
        role: null,
        t: "プロット・章立て・伏線をマップ上に置く。",
        panels: ["Matrix", "Timeline", "Foreshadow", "Map"],
      },
      {
        n: "03",
        k: "WRITE",
        jp: "執筆",
        role: null,
        t: "設計に沿って本文を進める。設定は脇に置く。",
        panels: ["Editor", "Chat", "Codex"],
      },
      {
        n: "04",
        k: "POLISH",
        jp: "仕上げ",
        role: "end",
        t: "整合性と表現を磨く。回収漏れを潰す。",
        panels: ["Review", "Foreshadow", "ChatHistory"],
      },
    ],
    pantser: [
      {
        n: "01",
        k: "DRAFT",
        jp: "走り書き",
        role: "entry",
        t: "思いつきで書き始める。AI と壁打ちする。",
        panels: ["Editor", "Chat"],
      },
      {
        n: "02",
        k: "CAPTURE",
        jp: "回収",
        role: null,
        t: "出てきた設定・人物を、後から構造化する。",
        panels: ["Snippets", "Codex"],
      },
      {
        n: "03",
        k: "RECONCILE",
        jp: "整合",
        role: null,
        t: "矛盾と時系列を、後付けで揃える。",
        panels: ["Codex", "Timeline", "Foreshadow"],
      },
      {
        n: "04",
        k: "POLISH",
        jp: "仕上げ",
        role: "end",
        t: "全体を俯瞰し、整える。",
        panels: ["Matrix", "Review", "ChatHistory"],
      },
    ],
  };
  const activeWorkflow = workflowSteps[workflowMode];
  const handleWorkflowModeClick = (mode, event) => {
    const target = event.currentTarget;
    const gsap = window.gsap;
    setWorkflowMode(mode);

    if (!gsap || !HMotionOK()) return;
    gsap
      .timeline()
      .to(target, {
        y: 4,
        scale: 0.96,
        boxShadow: `1px 1px 0 ${HZ_INK}`,
        duration: 0.08,
        ease: "power2.out",
      })
      .to(target, {
        y: 0,
        scale: 1,
        boxShadow: `4px 4px 0 ${HZ_INK}`,
        duration: 0.26,
        ease: "back.out(2.4)",
      });
  };
  const advantageRows = [
    {
      pain: "ChatGPT/Claude Projects に上げた設定.md を、書き換えるたびに上げ直してる。",
      title: "AI が、世界を覚える。",
      en: "Context that lingers.",
      body: "Codex はアプリ内データ。書き換えれば次のターンから AI が見る内容も即変わる。毎回アップロードし直さなくていい。",
      chip: "TALK",
      moveTag: "↳ MOVE 03",
    },
    {
      pain: "死んだはずのキャラが、後の章で生きている。",
      title: "設定が、時系列で進む。",
      en: "Phase-aware Codex.",
      body: "Phase は物語進行のスナップショット。シーン毎に Phase を切り替えれば Codex の値が時系列で変化し、過去シーンには過去の Phase の状態のまま AI が読みに行く。死んだキャラは、それ以降のシーンでは死んだまま。",
      chip: "CODEX · PHASE",
      moveTag: "↳ MOVE 02",
    },
    {
      pain: "張った伏線を、回収するのを忘れてた。",
      title: "伏線が、構造化される。",
      en: "Foreshadows, structured.",
      body: "未回収の伏線は、状態（仕込み済み・回収待ち・回収済み）付きで一覧できる構造化データとして Foreshadow に残る。AI 文脈にも自動で乗るが、まず自分の目で回収漏れを確認できることが効く。",
      chip: "FORESHADOW",
      moveTag: "↳ MOVE 02",
    },
    {
      pain: "AI に書かせると、自分の声が消える。",
      title: "AI は、Co-Writer。",
      en: "AI as second opinion.",
      body: "Chat は本文生成より、矛盾チェック・壁打ちに使う設計。書いた一行が AI / 人間どちらに由来するかは文字単位で追跡されているので、自分の書いた箇所が常に見える。",
      chip: "ATTRIBUTION",
      moveTag: "↳ MOVE 01",
    },
    {
      pain: "クラウドに原稿を預けたくない。",
      title: "ローカルファースト。",
      en: "Local-first, account-free.",
      body: "原稿は SQLite にローカル保存。アカウント不要。ネットに出るのは、自分で呼んだ AI 呼び出しのみ。ローカルLLMも対応。",
      chip: "LOCAL",
      moveTag: "(INFRA)",
    },
  ];

  return (
    <LPFrame
      bg={HZ_BG}
      fontFamily="'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif"
    >
      <style>{`
        .hz-mark{background:${HZ_HL};padding:0 10px;display:inline-block;line-height:0.95}
        .hz-hero-marker{--hero-marker-scale:0;background:transparent;position:relative;isolation:isolate;overflow:visible}
        .hz-hero-marker::before{content:"";position:absolute;left:0;right:0;bottom:.04em;height:.92em;background:${HZ_HL};transform:scaleX(var(--hero-marker-scale));transform-origin:left center;z-index:-1}
        .hz-shadow{box-shadow:5px 5px 0 ${HZ_INK}}
        .hz-split{display:block;width:max-content;transform-style:preserve-3d}
        .hz-pop{transform-origin:50% 80%;will-change:transform}
        .hz-page{min-height:calc(100vh - 76px);min-height:calc(100dvh - 76px);display:flex;flex-direction:column;justify-content:center}
        html{scroll-behavior:smooth}

        /* Page-wide paper texture overlays. Opacity is driven through CSS
           custom properties on :root, set/tweened from the hero timeline.
           That lets us mirror the same opacity onto a LOCAL overlay inside
           the workspace sticky stage (.ws-tex-*-local) — necessary because
           position: sticky always creates its own stacking context, so a
           single fixed overlay cannot be escaped by elements inside it.
           Global overlay covers everything except the workspace section
           (lifted via z-index 26); local overlays cover the workspace
           interior while sitting below .ws-stage (z 2) so the preset
           screenshot stays clean. */
        :root { --tex-halftone-op: 0; --tex-grain-op: 0; }
        .hz-halftone, .ws-tex-halftone-local {
          background-image: radial-gradient(circle at 1px 1px, ${HZ_INK} 1px, transparent 1.5px);
          background-size: 10px 10px;
          pointer-events: none;
        }
        .hz-grain, .ws-tex-grain-local {
          background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='4'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0'/></filter><rect width='100%25' height='100%25' filter='url(%23n)'/></svg>");
          pointer-events: none;
        }
        .hz-halftone {
          position: fixed; inset: 0;
          opacity: var(--tex-halftone-op);
          z-index: 25;
        }
        .hz-grain {
          position: fixed; inset: 0;
          opacity: var(--tex-grain-op);
          z-index: 25;
        }
        .ws-tex-halftone-local, .ws-tex-grain-local {
          position: absolute; inset: 0;
          z-index: 0;
        }
        .ws-tex-halftone-local { opacity: var(--tex-halftone-op); }
        .ws-tex-grain-local    { opacity: var(--tex-grain-op); }

        /* Hero EN-mirror echo. Enters large near the centered title, then
           rides the leftward title shift in reverse — shrinking and drifting
           up to a tiny stamp at top-right that persists for the rest of the
           hero. Font size is tweened via a CSS var so the shrink stays crisp
           (transform: scale would soft-blur small text). */
        .hz-hero-echo {
          position: absolute;
          top: 88px;
          right: 48px;
          font-family: 'JetBrains Mono', monospace;
          font-weight: 800;
          text-transform: uppercase;
          letter-spacing: -0.01em;
          font-size: var(--echo-size, 14px);
          line-height: 1;
          color: ${HZ_INK};
          white-space: nowrap;
          pointer-events: none;
          z-index: 2;
          opacity: 0;
          text-align: right;
          transform-origin: 100% 50%;
          will-change: transform, opacity, font-size;
        }
        @media (max-width: 900px) {
          .hz-hero-echo { top: 64px; right: 20px; font-size: 10px; }
        }

        /* Responsive — desktop-first inline styles get overridden below. The
           hero animation depends on h1 having width:max-content for the
           center→shift transform, so we keep that on every viewport and only
           shrink the typography via clamp() below. */
        @media (max-width: 900px) {
          .hz-nav-row { padding: 12px 20px !important; grid-template-columns: 1fr auto !important; }
          .hz-nav-center { display: none !important; }
          .hz-nav-logo { width: 130px !important; }

          .hz-hero-section { padding: 28px 20px 40px !important; }
          .hz-hero-meta-row { gap: 8px !important; }
          .hz-hero-grid { grid-template-columns: 1fr !important; gap: 28px !important; margin-top: 36px !important; }
          .hz-hero-spec { min-width: 0 !important; }

          .hz-page-section { padding: 64px 20px !important; }
          .hz-section-row { grid-template-columns: 1fr !important; gap: 16px !important; }
          .hz-massive { font-size: clamp(48px, 11vw, 112px) !important; letter-spacing: -2px !important; margin-bottom: 32px !important; }

          .hz-3move-row { grid-template-columns: 1fr !important; gap: 14px !important; padding: 26px 0 !important; }
          .hz-3move-num { font-size: 40px !important; }
          .hz-3move-title { font-size: 28px !important; }
          .hz-3move-meta { flex-direction: row !important; align-items: center !important; gap: 8px !important; flex-wrap: wrap !important; }
          .hz-3move-meta > * { margin-top: 0 !important; }

          .hz-workflow-grid { grid-template-columns: 1fr 1fr !important; }
          .hz-workflow-step { padding: 22px 16px !important; min-height: 170px !important; }
          .hz-workflow-step:nth-child(1), .hz-workflow-step:nth-child(2) { border-bottom: 2px solid ${HZ_INK} !important; }
          .hz-workflow-step:nth-child(even) { border-right: none !important; }
          .hz-workflow-step:nth-child(1), .hz-workflow-step:nth-child(3) { border-right: 2px solid ${HZ_INK} !important; }
          .hz-workflow-step-arrow { display: none !important; }
          .hz-workflow-step-k { font-size: 28px !important; }

          .hz-usecase-row { grid-template-columns: 48px 1fr !important; }
          .hz-usecase-num { font-size: 18px !important; padding: 14px 10px !important; }
          .hz-usecase-title { padding: 16px !important; }
          .hz-usecase-title-text { font-size: 18px !important; }
          .hz-usecase-body { grid-column: 1 / -1 !important; border-right: none !important; border-top: 1.5px dashed ${HZ_INK} !important; padding: 14px 16px !important; }
          .hz-usecase-chip { grid-column: 1 / -1 !important; padding: 12px 16px !important; flex-direction: row !important; align-items: center !important; justify-content: flex-start !important; gap: 10px !important; border-top: 1.5px dashed ${HZ_INK} !important; }
          .hz-usecase-pain { font-size: 12px !important; margin-bottom: 8px !important; }

          .hz-cta-section { padding: 72px 20px !important; }
          .hz-cta-massive { font-size: clamp(54px, 17vw, 220px) !important; letter-spacing: -4px !important; }
          .hz-cta-massive .hz-mark { padding: 0 10px !important; }
        }

        @media (max-width: 600px) {
          .hz-workflow-grid { grid-template-columns: 1fr !important; }
          .hz-workflow-step { border-right: none !important; min-height: 140px !important; }
          .hz-workflow-step:nth-child(odd) { border-right: none !important; }
          .hz-workflow-step:nth-child(3) { border-bottom: 2px solid ${HZ_INK} !important; }
          .hz-workflow-step:last-child { border-bottom: none !important; }
          .hz-massive { font-size: clamp(40px, 13vw, 112px) !important; }
          .hz-cta-massive { font-size: clamp(46px, 18vw, 220px) !important; }
        }
      `}</style>

      {/* Page-wide paper texture overlays. Opacity is driven by CSS
          variables on :root (--tex-halftone-op / --tex-grain-op) tweened
          from the hero timeline; same vars also feed the workspace-local
          overlays so the texture stays in sync across the section. */}
      <div className="hz-halftone" aria-hidden="true" />
      <div className="hz-grain" aria-hidden="true" />

      {/* NAV — hidden during the hero intro and revealed at the end of the
          hero timeline so it doesn't compete with the headline animation. */}
      <div
        ref={navRef}
        data-hz-nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 30,
          background: HZ_BG,
          borderTop: `4px solid ${HZ_INK}`,
          borderBottom: `2px solid ${HZ_INK}`,
          opacity: 0,
        }}
      >
        <div
          className="hz-nav-row"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            padding: "16px 48px",
            color: HZ_INK,
          }}
        >
          <a
            href="#hero"
            className="hz-nav-logo"
            style={{ display: "inline-flex", width: 190, color: HZ_INK }}
          >
            <img
              src="assets/grimodex-logo.svg"
              alt="Grimodex"
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          </a>
          <div
            className="hz-nav-center"
            style={{
              display: "flex",
              gap: 24,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: ".08em",
            }}
          >
            <a
              className="hz-nav-link"
              href="#hero"
              style={{ color: HZ_INK, textDecoration: "none" }}
            >
              A HERO
            </a>
            <a
              className="hz-nav-link"
              href="#workspace"
              style={{ color: HZ_INK, textDecoration: "none" }}
            >
              B WORKSPACE
            </a>
            <a
              className="hz-nav-link"
              href="#moves"
              style={{ color: HZ_INK, textDecoration: "none" }}
            >
              C MOVES
            </a>
            <a
              className="hz-nav-link"
              href="#workflow"
              style={{ color: HZ_INK, textDecoration: "none" }}
            >
              D WORKFLOW
            </a>
            <a
              className="hz-nav-link"
              href="#for"
              style={{ color: HZ_INK, textDecoration: "none" }}
            >
              E FOR
            </a>
          </div>
          <div
            style={{
              justifySelf: "end",
              display: "flex",
              alignItems: "center",
              gap: 12,
            }}
          >
            <a
              href="#download"
              className="hz-shadow hz-pop"
              style={{
                background: HZ_INK,
                color: HZ_BG,
                border: `2px solid ${HZ_INK}`,
                padding: "10px 18px",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
                textTransform: "uppercase",
                letterSpacing: ".08em",
                textDecoration: "none",
              }}
            >
              ↓ DOWNLOAD
            </a>
          </div>
        </div>
      </div>

      {/* HERO */}
      <section
        data-hz-page
        id="hero"
        className="hz-page hz-hero-section"
        style={{
          padding: "48px 48px 56px",
          color: HZ_INK,
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div ref={heroEchoRef} className="hz-hero-echo" aria-hidden="true">
          YOU&rsquo;RE WRITING<span className="hz-mark">.</span>
        </div>
        <div style={{ position: "relative", zIndex: 1 }}>
          <div>
            <h1
              ref={heroTitleRef}
              data-hz-hero-title
              style={{
                margin: 0,
                fontSize: "clamp(44px, 13vw, 200px)",
                lineHeight: 0.88,
                fontWeight: 800,
                letterSpacing: "-0.035em",
                fontFamily: "'Inter Tight', 'Helvetica Neue', Helvetica, Arial",
                width: "max-content",
                maxWidth: "100%",
              }}
            >
              <span data-hz-hero-line className="hz-split">
                {"\u66f8\u3044\u3066\u306a\u3044"}
              </span>
              <span data-hz-hero-line className="hz-split">
                {"\u6642\u9593\u3082\u3001"}
              </span>
              <span
                data-hz-hero-line
                data-hz-hero-marker
                className="hz-mark hz-split hz-hero-marker"
              >
                {"\u66f8\u3044\u3066\u3044\u308b\u3002"}
              </span>
            </h1>
            <div ref={heroMetaRef} data-hz-hero-meta>
              <div
                className="hz-hero-meta-row"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  marginTop: 28,
                  flexWrap: "wrap",
                }}
              >
                <span
                  className="hz-micro"
                  style={{
                    background: HZ_INK,
                    color: HZ_BG,
                    padding: "4px 10px",
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".1em",
                  }}
                >
                  A / 01
                </span>
                <span
                  className="hz-micro"
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 13,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: ".18em",
                  }}
                >
                  A{" "}
                  <span className="hz-mark" style={{ padding: "0 6px" }}>
                    WRITING FIDGET IDE
                  </span>
                </span>
                <span
                  style={{
                    flex: 1,
                    height: 1,
                    background: HZ_INK,
                    opacity: 0.25,
                    minWidth: 40,
                  }}
                />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 10,
                    color: "rgba(10,10,10,0.55)",
                    textTransform: "uppercase",
                    letterSpacing: ".12em",
                  }}
                >
                  TAURI · LOCAL · CLI · BYOK
                </span>
              </div>
            </div>
            <div ref={heroBodyRef} data-hz-hero-body>
              <div
                className="hz-hero-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr auto",
                  gap: 48,
                  marginTop: 56,
                  alignItems: "start",
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: ".1em",
                      color: "rgba(10,10,10,0.55)",
                      marginBottom: 8,
                    }}
                  >
                    EN ──
                  </div>
                  <p
                    style={{
                      fontSize: 22,
                      lineHeight: 1.35,
                      margin: 0,
                      fontWeight: 600,
                    }}
                  >
                    Even when you're not writing,{" "}
                    <span className="hz-mark" style={{ padding: "0 6px" }}>
                      you're writing.
                    </span>
                  </p>
                  <p
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      lineHeight: 1.7,
                      color: "rgba(10,10,10,0.6)",
                      marginTop: 14,
                      textTransform: "uppercase",
                      letterSpacing: ".04em",
                    }}
                  >
                    THE FIDGET IS THE WORK. IDLE MOVES FEED THE NEXT LINE.
                  </p>
                </div>
                <div>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: ".1em",
                      color: "rgba(10,10,10,0.55)",
                      marginBottom: 8,
                    }}
                  >
                    JA ──
                  </div>
                  <p style={{ fontSize: 16, lineHeight: 1.85, margin: 0 }}>
                    執筆ツールの王道は、集中を邪魔しないこと。
                    <br />
                    Grimodex は、集中の外側にある時間まで執筆に変える。
                    <br />
                    Codex を整える時間も、Map を眺める時間も、AI
                    と雑談する時間も——
                    <span className="hz-mark" style={{ padding: "0 4px" }}>
                      全部、次の一行に効く。
                    </span>
                  </p>
                </div>
                {/* Spec sheet — the zine fingerprint */}
                <div
                  className="hz-hero-spec"
                  style={{
                    border: `2px solid ${HZ_INK}`,
                    padding: "12px 16px",
                    minWidth: 220,
                    position: "relative",
                  }}
                >
                  <span
                    style={{
                      position: "absolute",
                      top: -10,
                      left: 10,
                      background: HZ_BG,
                      padding: "0 6px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: ".1em",
                    }}
                  >
                    SPEC
                  </span>
                  <div
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 11,
                      lineHeight: 2,
                      textTransform: "uppercase",
                      letterSpacing: ".04em",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        borderBottom: `1px dashed ${HZ_INK}`,
                      }}
                    >
                      <span>RUNTIME</span>
                      <b>TAURI v2</b>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        borderBottom: `1px dashed ${HZ_INK}`,
                      }}
                    >
                      <span>STORAGE</span>
                      <b>LOCAL</b>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        borderBottom: `1px dashed ${HZ_INK}`,
                      }}
                    >
                      <span>AI</span>
                      <b>MCP / LOCAL / CLI / BYOK</b>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                      }}
                    >
                      <span>STATUS</span>
                      <b style={{ background: HZ_HL, padding: "0 4px" }}>
                        BETA
                      </b>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* WORKSPACE — sticky scroll stage (snap-exempt) */}
      <HWorkspaceSection />

      {/* THREE MOVES — D layout, G accents */}
      <section
        data-hz-page
        id="moves"
        className="hz-page hz-page-section"
        style={{ padding: "100px 48px", color: HZ_INK }}
      >
        <div
          className="hz-section-row"
          style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}
        >
          <HSectionMark tag="C / 03" kicker="THREE MOVES" />
          <div>
            <HReveal>
              <h2
                className="hz-massive"
                style={{
                  fontSize: 112,
                  lineHeight: 0.92,
                  fontWeight: 800,
                  letterSpacing: -4,
                  margin: "0 0 56px",
                }}
              >
                THREE MOVES
                <br />
                THAT <span className="hz-mark">COMPOUND.</span>
              </h2>
            </HReveal>
            {[
              {
                no: "01",
                kicker_en: "WRITE · 書く",
                title_ja: ["書き手は、", "あなたのまま。"],
                title_en: "Your voice stays your own.",
                body_ja:
                  "自分の文章で本文を進める。AI は「必要なときだけ呼ぶ」道具で、ハンドルを奪わない。",
                chips: ["Editor", "Scenes", "Snippets"],
                out_ja: "一行が積まれる。",
                out_en: "Lines accumulate.",
                accent: "+1 LINE",
                flow: "↓ feeds 02",
              },
              {
                no: "02",
                kicker_en: "STRUCTURE · 構造的重力",
                title_ja: ["構造化への、", "重力。"],
                title_en: "A gravity toward structure.",
                body_ja:
                  "Structural Gravity（構造的重力）— 書いた本文を、構造化する力。Codex の言及が Matrix の格子に並び、シーンが Timeline の点に変わる。Phase（物語進行のスナップショット）を切り替えれば、Codex の値が時系列で変化していく。",
                chips: ["Codex", "Phase", "Matrix", "Timeline"],
                out_ja: "構造が見える。",
                out_en: "See the skeleton.",
                accent: "+1 GRAVITY",
                flow: "↓ feeds 03",
              },
              {
                no: "03",
                kicker_en: "TALK · 壁打ち",
                title_ja: ["AI には書かせず、", "アイデアを揉む。"],
                title_en: "Spar with AI. Don't ghostwrite.",
                body_ja:
                  "Chat はシーンごとに独立。AI はそのシーンの本文・関連 Codex・未回収の伏線等を見た状態で答える。ブレスト、設定を煮詰め、物語を強化する。",
                chips: ["Chat", "ChatHistory", "Foreshadow"],
                out_ja: "設定が深くなる。",
                out_en: "Your world grows deeper.",
                accent: "+1 DEPTH",
                flow: "↺ back to 01",
              },
            ].map((f, i) => (
              <HReveal key={f.no} delay={i * 0.08}>
                <div
                  className="hz-3move-row"
                  style={{
                    borderTop: `2px solid ${HZ_INK}`,
                    padding: "44px 0",
                    display: "grid",
                    gridTemplateColumns: "100px 1fr 1fr 140px",
                    gap: 32,
                    alignItems: "start",
                  }}
                >
                  <div
                    className="hz-3move-num"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 64,
                      fontWeight: 800,
                      lineHeight: 0.9,
                      letterSpacing: -3,
                    }}
                  >
                    {f.no}
                  </div>
                  <div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        textTransform: "uppercase",
                        letterSpacing: ".1em",
                        opacity: 0.55,
                        marginBottom: 12,
                      }}
                    >
                      ── {f.kicker_en}
                    </div>
                    <h3
                      className="hz-3move-title"
                      style={{
                        fontSize: 44,
                        lineHeight: 1,
                        fontWeight: 800,
                        letterSpacing: -1.5,
                        margin: 0,
                        textTransform: "none",
                      }}
                    >
                      {f.title_ja.map((line, k) => (
                        <span key={k} style={{ display: "block" }}>
                          {k === f.title_ja.length - 1 ? (
                            <span
                              className="hz-mark"
                              style={{ padding: "0 6px" }}
                            >
                              {line}
                            </span>
                          ) : (
                            line
                          )}
                        </span>
                      ))}
                    </h3>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11,
                        opacity: 0.55,
                        marginTop: 12,
                        textTransform: "uppercase",
                        letterSpacing: ".06em",
                      }}
                    >
                      {f.title_en}
                    </div>
                    <div
                      className="hz-3move-chips"
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 5,
                        marginTop: 16,
                      }}
                    >
                      {f.chips.map((c) => (
                        <span
                          key={c}
                          className="hz-wf-chip"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: ".06em",
                            textTransform: "uppercase",
                            padding: "3px 7px",
                            border: `1.5px solid ${HZ_INK}`,
                            background: HZ_BG,
                            color: HZ_INK,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p style={{ fontSize: 15, lineHeight: 1.75, margin: 0 }}>
                      {f.body_ja}
                    </p>
                    <div
                      className="hz-3move-output"
                      style={{
                        marginTop: 18,
                        paddingTop: 14,
                        borderTop: `1.5px dashed rgba(10,10,10,0.28)`,
                        display: "flex",
                        alignItems: "baseline",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: ".1em",
                          background: HZ_INK,
                          color: HZ_BG,
                          padding: "3px 7px",
                        }}
                      >
                        ↳ OUTPUT
                      </span>
                      <span style={{ fontSize: 14, fontWeight: 700 }}>
                        {f.out_ja}
                      </span>
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          opacity: 0.55,
                          letterSpacing: ".03em",
                        }}
                      >
                        {f.out_en}
                      </span>
                    </div>
                  </div>
                  <div
                    className="hz-3move-meta"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      alignItems: "flex-end",
                    }}
                  >
                    <HChip>0{i + 1} / 03</HChip>
                    <HChip hl>{["WRITE", "STRUCTURE", "TALK"][i]}</HChip>
                    <div
                      style={{
                        marginTop: 12,
                        padding: "4px 8px",
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        fontWeight: 800,
                        letterSpacing: ".08em",
                        background: HZ_INK,
                        color: HZ_BG,
                      }}
                    >
                      {f.accent}
                    </div>
                    <div
                      style={{
                        marginTop: 6,
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 9.5,
                        opacity: 0.55,
                        letterSpacing: ".05em",
                        textTransform: "uppercase",
                      }}
                    >
                      {f.flow}
                    </div>
                  </div>
                </div>
              </HReveal>
            ))}
          </div>
        </div>
      </section>

      {/* WORKFLOW */}
      <section
        data-hz-page
        id="workflow"
        className="hz-page hz-page-section"
        style={{ padding: "100px 48px", color: HZ_INK }}
      >
        <div
          className="hz-section-row"
          style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}
        >
          <HSectionMark tag="D / 04" kicker="WORKFLOW" />
          <div>
            <HReveal>
              <h2
                className="hz-massive"
                style={{
                  fontSize: 112,
                  lineHeight: 0.92,
                  fontWeight: 800,
                  letterSpacing: -4,
                  margin: "0 0 48px",
                }}
              >
                PLOTTER OR
                <br />
                <span className="hz-mark">PANTSER.</span>
              </h2>
            </HReveal>
            <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
              {[
                { key: "plotter", label: "PLOTTER", desc: "先に構造を作る" },
                { key: "pantser", label: "PANTSER", desc: "探索しながら書く" },
              ].map((mode) => {
                const active = workflowMode === mode.key;
                return (
                  <button
                    key={mode.key}
                    onClick={(event) =>
                      handleWorkflowModeClick(mode.key, event)
                    }
                    style={{
                      background: active ? HZ_HL : HZ_BG,
                      color: HZ_INK,
                      border: `2px solid ${HZ_INK}`,
                      padding: "12px 16px",
                      minWidth: 180,
                      textAlign: "left",
                      cursor: "pointer",
                      fontFamily: "'JetBrains Mono', monospace",
                      boxShadow: active
                        ? `4px 4px 0 ${HZ_INK}`
                        : `0 0 0 ${HZ_INK}`,
                      transformOrigin: "50% 80%",
                    }}
                  >
                    <div
                      style={{
                        fontSize: 14,
                        fontWeight: 800,
                        letterSpacing: ".08em",
                      }}
                    >
                      {mode.label}
                    </div>
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>
                      {mode.desc}
                    </div>
                  </button>
                );
              })}
            </div>
            <div
              className="hz-workflow-tagline"
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 12,
                marginBottom: 18,
              }}
            >
              <span
                style={{
                  background: HZ_INK,
                  color: HZ_BG,
                  padding: "5px 10px",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 800,
                  textTransform: "uppercase",
                  letterSpacing: ".1em",
                }}
              >
                ↳ SAME END · DIFFERENT PATH
              </span>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  letterSpacing: ".06em",
                  color: "rgba(10,10,10,0.65)",
                }}
              >
                終点は同じ。経路は別。
              </span>
            </div>
            <div style={{ border: `2px solid ${HZ_INK}` }}>
              <div
                ref={workflowGridRef}
                className="hz-workflow-grid"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                }}
              >
                {activeWorkflow.map((s, i) => (
                  <div
                    key={s.n}
                    className="hz-workflow-step"
                    style={{
                      borderRight: i < 3 ? `2px solid ${HZ_INK}` : "none",
                      padding: "28px 22px",
                      minHeight: 248,
                      position: "relative",
                      background: i === 0 ? HZ_HL : HZ_BG,
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 6,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          textTransform: "uppercase",
                          letterSpacing: ".1em",
                          opacity: 0.7,
                        }}
                      >
                        STEP {s.n}
                      </div>
                      {s.role === "entry" && (
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: ".08em",
                            color: HZ_INK,
                            background: HZ_BG,
                            border: `1.5px solid ${HZ_INK}`,
                            padding: "2px 6px",
                          }}
                        >
                          ← ENTRY
                        </div>
                      )}
                      {s.role === "end" && (
                        <div
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9.5,
                            fontWeight: 800,
                            textTransform: "uppercase",
                            letterSpacing: ".08em",
                            color: HZ_BG,
                            background: HZ_INK,
                            padding: "3px 7px",
                          }}
                        >
                          → SHARED END
                        </div>
                      )}
                    </div>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 10,
                        marginTop: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <div
                        className="hz-workflow-step-k"
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontWeight: 800,
                          fontSize: 32,
                          letterSpacing: -1,
                          lineHeight: 1,
                        }}
                      >
                        {s.k}
                      </div>
                      <div
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          opacity: 0.55,
                          letterSpacing: ".04em",
                        }}
                      >
                        / {s.jp}
                      </div>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.55,
                        opacity: 0.78,
                        marginTop: 10,
                      }}
                    >
                      {s.t}
                    </div>
                    <div style={{ flex: 1 }} />
                    <div
                      className="hz-workflow-step-panels"
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 4,
                        marginTop: 16,
                      }}
                    >
                      {s.panels.map((p) => (
                        <span
                          key={p}
                          className="hz-wf-chip"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 9.5,
                            fontWeight: 700,
                            letterSpacing: ".06em",
                            textTransform: "uppercase",
                            padding: "3px 6px",
                            border: `1.5px solid ${HZ_INK}`,
                            background: HZ_BG,
                            color: HZ_INK,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                    {i < 3 && (
                      <div
                        className="hz-workflow-step-arrow"
                        style={{
                          position: "absolute",
                          right: -14,
                          top: "50%",
                          transform: "translateY(-50%)",
                          width: 26,
                          height: 26,
                          background: HZ_BG,
                          border: `2px solid ${HZ_INK}`,
                          borderRadius: "50%",
                          display: "grid",
                          placeItems: "center",
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 14,
                          fontWeight: 800,
                          zIndex: 2,
                        }}
                      >
                        →
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <HZBar
                items={[
                  { t: "NO SINGLE FLOW", k: true },
                  { t: "PLOTTER", hl: workflowMode === "plotter" },
                  { t: "PANTSER", hl: workflowMode === "pantser" },
                  { t: "OR HYBRID" },
                  { t: "↳ GRIMODEX :: FITS THE DRAFT" },
                ]}
              />
            </div>
          </div>
        </div>
      </section>

      {/* USE CASES */}
      <section
        data-hz-page
        id="for"
        className="hz-page hz-page-section"
        style={{ padding: "100px 48px", color: HZ_INK }}
      >
        <div
          className="hz-section-row"
          style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}
        >
          <HSectionMark tag="E / 05" kicker="FOR" />
          <div>
            <HReveal>
              <h2
                className="hz-massive"
                style={{
                  fontSize: 112,
                  lineHeight: 0.92,
                  fontWeight: 800,
                  letterSpacing: -4,
                  margin: "0 0 48px",
                }}
              >
                WHY WRITE
                <br />
                <span className="hz-mark">HERE?</span>
              </h2>
            </HReveal>
            <div style={{ border: `2px solid ${HZ_INK}` }}>
              {advantageRows.map((u, i) => (
                <div
                  key={u.title}
                  className="hz-usecase-row"
                  style={{
                    borderBottom:
                      i < advantageRows.length - 1
                        ? `2px solid ${HZ_INK}`
                        : "none",
                    display: "grid",
                    gridTemplateColumns: "70px 280px 1fr 110px",
                    gap: 0,
                    alignItems: "stretch",
                  }}
                >
                  <div
                    className="hz-usecase-num"
                    style={{
                      borderRight: `2px solid ${HZ_INK}`,
                      padding: "20px 14px",
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: 22,
                      fontWeight: 800,
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    0{i + 1}
                  </div>
                  <div
                    className="hz-usecase-title"
                    style={{
                      borderRight: `2px solid ${HZ_INK}`,
                      padding: "20px 18px",
                    }}
                  >
                    <div
                      className="hz-usecase-pain"
                      style={{
                        display: "flex",
                        gap: 6,
                        alignItems: "baseline",
                        fontSize: 13,
                        lineHeight: 1.45,
                        color: "rgba(10,10,10,0.6)",
                        marginBottom: 10,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: "'JetBrains Mono', monospace",
                          fontSize: 11,
                          opacity: 0.7,
                        }}
                      >
                        ↳
                      </span>
                      <span>「{u.pain}」</span>
                    </div>
                    <div
                      className="hz-usecase-title-text"
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        letterSpacing: -0.5,
                        lineHeight: 1.12,
                      }}
                    >
                      {u.title}
                    </div>
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 10,
                        opacity: 0.6,
                        textTransform: "uppercase",
                        letterSpacing: ".06em",
                        marginTop: 6,
                      }}
                    >
                      {u.en}
                    </div>
                  </div>
                  <div
                    className="hz-usecase-body"
                    style={{
                      padding: "20px 18px",
                      borderRight: `2px solid ${HZ_INK}`,
                      fontSize: 14,
                      lineHeight: 1.7,
                    }}
                  >
                    {u.body}
                  </div>
                  <div
                    className="hz-usecase-chip"
                    style={{
                      padding: "20px 14px",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                      background: i === 0 ? HZ_HL : HZ_BG,
                    }}
                  >
                    <div
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 9,
                        opacity: 0.5,
                        letterSpacing: ".08em",
                        textTransform: "uppercase",
                      }}
                    >
                      {u.moveTag}
                    </div>
                    <HChip>{u.chip}</HChip>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA — D's massive scale, G's brutalist buttons */}
      <section
        data-hz-page
        id="download"
        className="hz-page hz-cta-section"
        style={{ padding: "120px 48px", color: HZ_INK, textAlign: "center" }}
      >
        <h2
          className="hz-cta-massive"
          style={{
            fontSize: 220,
            lineHeight: 0.86,
            fontWeight: 800,
            letterSpacing: -8,
            margin: 0,
          }}
        >
          WRITE
          <br />
          <span className="hz-mark" style={{ padding: "0 18px" }}>
            DIFFERENTLY.
          </span>
        </h2>
        <p
          style={{
            fontSize: 16,
            opacity: 0.65,
            marginTop: 28,
            fontFamily: "'JetBrains Mono', monospace",
            textTransform: "uppercase",
            letterSpacing: ".08em",
          }}
        >
          FREE (BETA) · LOCAL-FIRST · BRING YOUR OWN AI KEY
        </p>
        <div
          style={{ display: "flex", justifyContent: "center", marginTop: 44 }}
        >
          <a
            href="https://github.com/kazormia296/Grimodex/releases/latest"
            className="hz-shadow"
            style={{
              background: HZ_HL,
              color: HZ_INK,
              border: `2px solid ${HZ_INK}`,
              padding: "22px 30px",
              textAlign: "left",
              cursor: "pointer",
              display: "inline-flex",
              flexDirection: "column",
              gap: 5,
              minWidth: 360,
              textDecoration: "none",
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".1em",
                opacity: 0.65,
              }}
            >
              ↓ DOWNLOAD
            </div>
            <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: -0.5 }}>
              GitHub Releases
            </div>
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 10,
                textTransform: "uppercase",
                opacity: 0.6,
              }}
            >
              macOS / Windows / Linux
            </div>
          </a>
        </div>
        <div style={{ marginTop: 80 }}>
          <HZBar
            items={[
              { t: "GRIMODEX", k: true },
              { t: "BETA" },
              { t: "TAURI v2" },
              {
                t: "GITHUB ↗",
                href: "https://github.com/kazormia296/Grimodex",
              },
              { t: "© 2026", hl: true },
            ]}
          />
        </div>
      </section>
    </LPFrame>
  );
}
window.LPVariantH = LPVariantH;
