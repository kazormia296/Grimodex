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
import pChronicle from "/assets/panel-chronicle.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMap from "/assets/panel-map.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMatrix from "/assets/panel-matrix.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pTrashBin from "/assets/panel-trash-bin.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChatHistory from "/assets/panel-chat-history.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCodexQuick from "/assets/panel-codex-quick.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCommandCenter from "/assets/panel-command-center-results.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pAttribution from "/assets/panel-attribution.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pWritingStats from "/assets/panel-writing-stats.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pForeshadow from "/assets/panel-foreshadow.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import psDefault from "/assets/preset-default.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psPlan from "/assets/preset-plan.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psChat from "/assets/preset-chat-main.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psCodex from "/assets/preset-codex-main.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psReview from "/assets/preset-review.png?w=1400;2200;3000&format=avif;webp;png&as=picture";

// English UI captures — same crops re-shot with the app in English. Selected
// per active LP language so the screenshots match the surrounding copy.
import pEditorEn from "/assets/panel-editor-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pScenesEn from "/assets/panel-scenes-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pGridEn from "/assets/panel-grid-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCodexEn from "/assets/panel-codex-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pSnippetsEn from "/assets/panel-snippets-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChatEn from "/assets/panel-chat-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pKouetsuEn from "/assets/panel-kouetsu-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pTimelineEn from "/assets/panel-timeline-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChronicleEn from "/assets/panel-chronicle-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMapEn from "/assets/panel-map-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pMatrixEn from "/assets/panel-matrix-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pTrashBinEn from "/assets/panel-trash-bin-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pChatHistoryEn from "/assets/panel-chat-history-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCodexQuickEn from "/assets/panel-codex-quick-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pCommandCenterEn from "/assets/panel-command-center-results-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pAttributionEn from "/assets/panel-attribution-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pWritingStatsEn from "/assets/panel-writing-stats-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import pForeshadowEn from "/assets/panel-foreshadow-en.png?w=1100;1700;2400&format=avif;webp;png&as=picture";
import psDefaultEn from "/assets/preset-default-en.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psPlanEn from "/assets/preset-plan-en.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psChatEn from "/assets/preset-chat-main-en.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psCodexEn from "/assets/preset-codex-main-en.png?w=1400;2200;3000&format=avif;webp;png&as=picture";
import psReviewEn from "/assets/preset-review-en.png?w=1400;2200;3000&format=avif;webp;png&as=picture";

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

/* ============================================================
   I18N — runtime ja/en switch for the landing page.
   The page is a single client-rendered bundle, so language is held in
   React state, seeded from (in priority order) the `?lang=` query param,
   `localStorage`, then the browser's `navigator.language`. Switching also
   rewrites <html lang>, document.title and the description meta so the
   tab / a11y tree stay correct. Decorative mono labels (WORKSPACE, SPEC…)
   are part of the Swiss-zine chrome and intentionally stay identical in
   both languages; only reader-facing prose is localized.
   ============================================================ */
const LP_LANGS = ["ja", "en"];
const LP_LANG_STORAGE_KEY = "grimodex-lp-lang";

// Context carries the active language to the module-scoped sub-components
// (HWorkspaceSection / WSPanelDialog) without prop-drilling through them.
const LPLangContext = React.createContext("ja");
function useLpLang() {
  return React.useContext(LPLangContext);
}

// Pick a localized value. Accepts a `{ ja, en }` map (returns the active
// language, falling back to ja) or a plain value (returned as-is so shared
// mono strings can sit alongside localized ones).
function lpText(value, lang) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if ("ja" in value || "en" in value) return value[lang] ?? value.ja;
  }
  return value;
}

function detectInitialLpLang() {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("lang");
    if (LP_LANGS.includes(fromQuery)) return fromQuery;
    const stored = window.localStorage?.getItem(LP_LANG_STORAGE_KEY);
    if (LP_LANGS.includes(stored)) return stored;
    const nav = (
      window.navigator?.language ||
      window.navigator?.userLanguage ||
      ""
    ).toLowerCase();
    return nav.startsWith("en") ? "en" : "ja";
  } catch {
    return "ja";
  }
}

const LP_DOC_META = {
  ja: {
    title: "Grimodex — A Writing Fidget IDE",
    description:
      "Grimodex は、書いていない時間も書いている、ライティング・フィジェット IDE。Codex / Map / AI Chat のフライホイールで、長編小説の世界が破綻しない。",
  },
  en: {
    title: "Grimodex — A Writing Fidget IDE",
    description:
      "Grimodex is a writing fidget IDE — even when you're not writing, you're writing. A Codex / Map / AI Chat flywheel keeps the world of a long novel from falling apart.",
  },
};

// Reflect the active language onto the document chrome. OGP/Twitter tags are
// crawler-only (read from static HTML at fetch time), so we update just the
// live-relevant bits: <html lang>, title and description.
function applyLpDocumentMeta(lang) {
  try {
    const meta = LP_DOC_META[lang] ?? LP_DOC_META.ja;
    document.documentElement.lang = lang;
    document.title = meta.title;
    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute("content", meta.description);
  } catch {
    /* SSR-less page; ignore if document is unavailable */
  }
}

// Persist + reflect a language choice into storage and the URL so reloads and
// shared links keep the selection.
function persistLpLang(lang) {
  try {
    window.localStorage?.setItem(LP_LANG_STORAGE_KEY, lang);
    const url = new URL(window.location.href);
    url.searchParams.set("lang", lang);
    window.history.replaceState(null, "", url);
  } catch {
    /* storage / history may be unavailable; selection still applies in-memory */
  }
}

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
    cat: {
      ja: "次の一行を書く場所。",
      en: "Where the next line gets written.",
    },
    desc: {
      ja: "本文を執筆する中心パネル。AI や設定資料に飲み込まれず、最終的に作品へ落とし込むための主戦場。",
      en: "The central panel where the manuscript gets written — the main stage for turning everything into finished prose without being swallowed by the AI or your notes.",
    },
    img: { ja: pEditor, en: pEditorEn },
  },
  Scenes: {
    jp: "Scenes",
    cat: {
      ja: "場面を分けて、迷子を減らす。",
      en: "Split the scenes, get lost less.",
    },
    desc: {
      ja: "シーン単位で本文を管理し、長編の構成を扱いやすくするパネル。どこで何が起きているかを見失いにくくする。",
      en: "Manages the manuscript scene by scene, keeping a long work's structure tractable so you rarely lose track of what happens where.",
    },
    img: { ja: pScenes, en: pScenesEn },
  },
  Grid: {
    jp: "Grid",
    cat: {
      ja: "章とシーンを、カードで見渡す。",
      en: "Survey chapters and scenes as cards.",
    },
    desc: {
      ja: "章・シーンをカード状に並べる構成ビュー。物語全体の配置や流れを視覚的に確認できる。",
      en: "A structural view that lays chapters and scenes out as cards, so you can read the whole story's arrangement and flow at a glance.",
    },
    img: { ja: pGrid, en: pGridEn },
  },
  Codex: {
    jp: "Codex",
    cat: {
      ja: "設定資料が、執筆の外に散らばらない。",
      en: "Your worldbuilding stops scattering.",
    },
    desc: {
      ja: "キャラクター、世界観、用語、組織などをまとめる設定資料庫。AI に注入される情報源となる。",
      en: "A reference library for characters, world, terminology, and factions — and the source that gets injected into the AI's context.",
    },
    img: { ja: pCodex, en: pCodexEn },
  },
  Snippets: {
    jp: "Snippets",
    cat: {
      ja: "まだ本文ではない言葉を、捨てずに持つ。",
      en: "Keep the words that aren't prose yet.",
    },
    desc: {
      ja: "台詞、描写、アイデア、断片的な文章を保管するパネル。今は使えない一文も、後のシーン素材にできる。",
      en: "Holds lines, descriptions, ideas, and stray fragments. A sentence you can't use now can become material for a later scene.",
    },
    img: { ja: pSnippets, en: pSnippetsEn },
  },
  Chat: {
    jp: "Chat",
    cat: {
      ja: "AI に丸投げしない。AI と揉む。",
      en: "Don't outsource to AI. Spar with it.",
    },
    desc: {
      ja: "AI との相談用パネル。本文生成よりも、違和感の整理、別案の検討、設定の掘り下げに使う補助空間。",
      en: "A panel for consulting the AI — less about generating prose, more a space for untangling what feels off, weighing alternatives, and digging into settings.",
    },
    img: { ja: pChat, en: pChatEn },
  },
  Review: {
    jp: "Review",
    cat: {
      ja: "作品を、少し離れて見る。",
      en: "See your work from a step back.",
    },
    desc: {
      ja: "矛盾、弱い動機、説明不足、テンポの乱れなどを確認する校閲・レビュー用パネル。書いた後の違和感を拾う。",
      en: "An editorial / review panel for catching contradictions, weak motivations, missing explanations, and pacing slips — the unease that surfaces after you've written.",
    },
    img: { ja: pKouetsu, en: pKouetsuEn },
  },
  Timeline: {
    jp: "Timeline",
    cat: {
      ja: "出来事の順番を見失わない。",
      en: "Never lose the order of events.",
    },
    desc: {
      ja: "物語内の時系列を管理するパネル。回想、過去設定、章をまたぐ因果関係を整理しやすくする。",
      en: "Manages the in-story chronology, keeping flashbacks, backstory, and cause-and-effect that span chapters straight.",
    },
    img: { ja: pTimeline, en: pTimelineEn },
  },
  Chronicle: {
    jp: "Chronicle",
    cat: {
      ja: "作中時間を、レーンと因果で見渡す。",
      en: "See story time through lanes and causality.",
    },
    desc: {
      ja: "出来事を作中時間・レーン・因果関係で並べ、参照シーンや人物の動きを追う作中年表。回想や並行進行、季節・年齢・同時刻の矛盾も見つけやすくする。",
      en: "A story chronicle that arranges events by story time, lane, and cause-and-effect, tying them back to scenes and character movement. Flashbacks, parallel threads, and time conflicts become easier to spot.",
    },
    img: { ja: pChronicle, en: pChronicleEn },
  },
  Map: {
    jp: "Map",
    cat: {
      ja: "物語の迷子にならない。",
      en: "Don't get lost in your own story.",
    },
    desc: {
      ja: "付箋、ノード、関係線でアイデアや設定を広げる発散の盤。構造化しすぎず、眺めながら考えるための空間。",
      en: "A divergent board for spreading ideas and settings out as sticky notes, nodes, and relation lines — a space to think while you look, without over-structuring.",
    },
    img: { ja: pMap, en: pMapEn },
  },
  Matrix: {
    jp: "Matrix",
    cat: {
      ja: "関係性を、表で殴る。",
      en: "Relationships, pinned to a grid.",
    },
    desc: {
      ja: "Codex エントリ × シーンの言及をマトリクスで一覧化するパネル。どのキャラがどのシーンに登場し、どの設定がどこで触れられているかを俯瞰できる。",
      en: "Tabulates Codex entries × scene mentions as a matrix, so you can see which character appears in which scene and where each setting is touched.",
    },
    img: { ja: pMatrix, en: pMatrixEn },
  },
  TrashBin: {
    jp: "Trash Bin",
    cat: {
      ja: "没案も、まだ死んでいない。",
      en: "Killed drafts aren't dead yet.",
    },
    desc: {
      ja: "削除した断片や使わなかった文章を一時的に保持するパネル。完全な廃棄ではなく、再利用可能な創作残骸として扱う。",
      en: "Temporarily holds deleted fragments and unused text — not a final purge, but reusable creative debris.",
    },
    img: { ja: pTrashBin, en: pTrashBinEn },
  },
  ChatHistory: {
    jp: "Chat History",
    cat: {
      ja: "AI との思考ログを、作品の横に残す。",
      en: "Keep your thinking log beside the work.",
    },
    desc: {
      ja: "AI との過去のやり取りを確認するパネル。相談の流れ、出てきた案、却下した方向性などを振り返り、執筆判断の履歴として扱える。",
      en: "Review past exchanges with the AI — how a consult unfolded, the ideas it raised, the directions you rejected — as a history of your writing decisions.",
    },
    img: { ja: pChatHistory, en: pChatHistoryEn },
  },
  CodexQuick: {
    jp: "Codex Quick",
    cat: {
      ja: "今のシーンに必要な設定だけ、一覧で。",
      en: "Only the settings this scene needs.",
    },
    desc: {
      ja: "Codex の情報を素早く参照するための簡易パネル。シーンに登場するキャラクター名・用語・設定だけをリストアップ。",
      en: "A lightweight panel for quick Codex lookups, listing only the character names, terms, and settings that appear in the current scene.",
    },
    img: { ja: pCodexQuick, en: pCodexQuickEn },
  },
  Attribution: {
    jp: "Attribution",
    cat: {
      ja: "何を使い、どこから来たかを見える化する。",
      en: "See what you used and where it came from.",
    },
    desc: {
      ja: "AI / Human(人間) / Unknown(コピペ) の割合をグラフ化するパネル。AI の使用率を俯瞰できる。",
      en: "Graphs the ratio of AI / Human / Unknown (pasted) text, giving you an overview of how much AI you lean on.",
    },
    img: { ja: pAttribution, en: pAttributionEn },
  },
  WritingStats: {
    jp: "Writing Stats",
    cat: {
      ja: "書いた量とペースを、次の一日に繋ぐ。",
      en: "Turn output and pace into tomorrow's plan.",
    },
    desc: {
      ja: "今日・直近7日・30日の文字数、連続執筆、ヒートマップ、Human / AI の内訳を一望する統計パネル。日次目標と完走ペースメーカーで、締切までの進み方も組み立てられる。",
      en: "See today's output, the last 7 and 30 days, streaks, a heatmap, and the Human / AI breakdown at a glance. Daily goals and a finish-line pacemaker turn the numbers into a route to your deadline.",
    },
    img: { ja: pWritingStats, en: pWritingStatsEn },
  },
  Foreshadow: {
    jp: "Foreshadow",
    cat: {
      ja: "伏線を、置いたまま忘れない。",
      en: "Plant a hook — and don't forget it.",
    },
    desc: {
      ja: "伏線、回収予定、未解決の要素を管理するパネル。思いつきで置いた仕込みを後から追跡し、放置や回収漏れを防ぐ。さらに、回収シーンで「どこに setup を仕込むべきか」を AI に提案させられる。",
      en: "Manages foreshadowing, planned payoffs, and loose threads. Track the hooks you dropped on a whim so nothing is left dangling — and let the AI suggest where to plant the setup for a payoff scene.",
    },
    img: { ja: pForeshadow, en: pForeshadowEn },
  },
  CommandCenter: {
    jp: "Command Center",
    cat: {
      ja: "横断検索を、一箇所から。",
      en: "Search across your project in one place.",
    },
    desc: {
      ja: "Scene・Codex・Snippet を字句検索し、Scene 本文には意味検索も重ねて、その場で目的地へジャンプする専用検索パネル。",
      en: "Search Scenes, Codex, and Snippets lexically, with semantic search layered over scene prose, then jump straight to the result from a dedicated search panel.",
    },
    img: { ja: pCommandCenter, en: pCommandCenterEn },
  },
};

const WS_ALL_PANEL_KEYS = [
  "Editor",
  "Scenes",
  "Grid",
  "Codex",
  "CodexQuick",
  "CommandCenter",
  "Snippets",
  "Chat",
  "ChatHistory",
  "Review",
  "Timeline",
  "Chronicle",
  "Map",
  "Matrix",
  "Attribution",
  "WritingStats",
  "Foreshadow",
  "TrashBin",
];

const WS_PRESETS = [
  {
    id: "write",
    label: "WRITE",
    num: "01",
    desc: {
      ja: "本文 + Codex + Chat。中心は本文。設定資料と相談相手を脇に置く、執筆中心のレイアウト。",
      en: "Manuscript + Codex + Chat. Prose at the center, with your notes and a sounding board off to the side — a writing-first layout.",
    },
    img: { ja: psDefault, en: psDefaultEn },
  },
  {
    id: "plan",
    label: "PLAN",
    num: "02",
    desc: {
      ja: "Grid + Map + Timeline。章とシーンを並べ、時系列と関係性で俯瞰する構成のレイアウト。",
      en: "Grid + Map + Timeline. Lay out chapters and scenes and survey them by chronology and relationships — a structuring layout.",
    },
    img: { ja: psPlan, en: psPlanEn },
  },
  {
    id: "chat",
    label: "CHAT",
    num: "03",
    desc: {
      ja: "Chat を中央へ。設定の掘り下げ、別案の検討、違和感の整理を広いキャンバスで。",
      en: "Chat at the center. Dig into settings, weigh alternatives, and untangle what feels off on a wide canvas.",
    },
    img: { ja: psChat, en: psChatEn },
  },
  {
    id: "codex",
    label: "CODEX",
    num: "04",
    desc: {
      ja: "Codex を中央へ。キャラクター・場所・用語を本文の隣に置いて編集する、設定編みのレイアウト。",
      en: "Codex at the center. Edit characters, places, and terms right beside the prose — a worldbuilding layout.",
    },
    img: { ja: psCodex, en: psCodexEn },
  },
  {
    id: "review",
    label: "REVIEW",
    num: "05",
    desc: {
      ja: "Review + Attribution。矛盾、説明不足、由来の不明な箇所を拾う、読み返しのレイアウト。",
      en: "Review + Attribution. Catch contradictions, gaps, and passages of unclear origin — a re-reading layout.",
    },
    img: { ja: psReview, en: psReviewEn },
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
  const lang = useLpLang();
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
        aria-label={lang === "en" ? "Previous panel" : "前のパネル"}
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
        aria-label={lang === "en" ? "Next panel" : "次のパネル"}
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
            aria-label={lang === "en" ? "Close" : "閉じる"}
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
              pic={lpText(p.img, lang)}
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
              {lpText(p.desc, lang)}
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
              <span>
                {lang === "en"
                  ? "← / → for other panels · ESC to close"
                  : "← / → で別パネル · ESC で閉じる"}
              </span>
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
  const lang = useLpLang();
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
          18 PANELS · ONE DESK
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
              18 PANELS.
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
            {lang === "en"
              ? "A work layout where Editor, Codex, Map, Chat, Grid and more rearrange freely. Presets switch the whole layout in an instant, so writing, organizing, diverging, and consulting all live on one screen."
              : "Editor、Codex、Map、Chat、Grid などを自由に並べ替えられる作業レイアウト。プリセットでレイアウトを瞬時に切り替えられる。執筆、整理、発散、相談をひとつの画面内で行き来できる。"}
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
              pic={lpText(shown.img, lang)}
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
              {lpText(shown.desc, lang)}
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
              {lang === "en" ? "↓ OPEN FROM 18 PANELS" : "↓ 18 PANELS から開く"}
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
              ALL 18 PANELS ↓
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
  const [lang, setLang] = useState(detectInitialLpLang);
  const [workflowMode, setWorkflowMode] = useState("plotter");
  const workflowGridRef = useRef(null);
  const navRef = useRef(null);
  const heroTitleRef = useRef(null);
  const heroMetaRef = useRef(null);
  const heroBodyRef = useRef(null);
  const heroEchoRef = useRef(null);

  // Reflect the active language onto the document chrome and persist the
  // choice (localStorage + ?lang=) whenever it changes — including the
  // browser-detected default on first paint, so the URL is shareable.
  useEffect(() => {
    applyLpDocumentMeta(lang);
    persistLpLang(lang);
  }, [lang]);

  const toggleLang = () => setLang((prev) => (prev === "en" ? "ja" : "en"));

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

  // Native scroll only. An earlier build hijacked wheel/keydown to "page-snap"
  // section-by-section (preventDefault on a non-passive wheel listener + a
  // smooth scrollTo + a 720ms input lock). On trackpads/inertial scrolling that
  // felt janky ("カクっと"): the page swallowed input, then jerked to the next
  // section. Removed in favour of free native scrolling. The Workspace sticky
  // stage (its own rAF, scrollY-driven) and nav anchor links
  // (html{scroll-behavior:smooth}) keep working without it.

  const workflowSteps = {
    plotter: [
      {
        n: "01",
        k: "DESIGN",
        jp: "設計",
        role: "entry",
        t: {
          ja: "キャラ・世界観・設定を、本文より先に固める。",
          en: "Lock in characters, world, and settings before the prose.",
        },
        panels: ["Codex", "Chat", "Map"],
      },
      {
        n: "02",
        k: "OUTLINE",
        jp: "構成",
        role: null,
        t: {
          ja: "プロット・章立て・伏線をマップ上に置く。",
          en: "Lay plot, chapters, and foreshadowing out on the map.",
        },
        panels: ["Matrix", "Timeline", "Foreshadow", "Map"],
      },
      {
        n: "03",
        k: "WRITE",
        jp: "執筆",
        role: null,
        t: {
          ja: "設計に沿って本文を進める。設定は脇に置く。",
          en: "Advance the prose along the design, notes kept to the side.",
        },
        panels: ["Editor", "Chat", "Codex"],
      },
      {
        n: "04",
        k: "POLISH",
        jp: "仕上げ",
        role: "end",
        t: {
          ja: "整合性と表現を磨く。回収漏れを潰す。",
          en: "Polish consistency and prose; close every unpaid setup.",
        },
        panels: ["Review", "Foreshadow", "ChatHistory"],
      },
    ],
    pantser: [
      {
        n: "01",
        k: "DRAFT",
        jp: "走り書き",
        role: "entry",
        t: {
          ja: "思いつきで書き始める。AI と壁打ちする。",
          en: "Start writing on a whim; bounce ideas off the AI.",
        },
        panels: ["Editor", "Chat"],
      },
      {
        n: "02",
        k: "CAPTURE",
        jp: "回収",
        role: null,
        t: {
          ja: "出てきた設定・人物を、後から構造化する。",
          en: "Structure the settings and characters that emerge, after the fact.",
        },
        panels: ["Snippets", "Codex"],
      },
      {
        n: "03",
        k: "RECONCILE",
        jp: "整合",
        role: null,
        t: {
          ja: "矛盾と時系列を、後付けで揃える。",
          en: "Reconcile contradictions and chronology retroactively.",
        },
        panels: ["Codex", "Timeline", "Foreshadow"],
      },
      {
        n: "04",
        k: "POLISH",
        jp: "仕上げ",
        role: "end",
        t: {
          ja: "全体を俯瞰し、整える。",
          en: "Survey the whole and tidy it up.",
        },
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
      pain: {
        ja: "ChatGPT/Claude Projects に上げた設定.md を、書き換えるたびに上げ直してる。",
        en: "Every time I edit my settings.md, I re-upload it to ChatGPT / Claude Projects.",
      },
      title: {
        ja: "AI が、世界を覚える。",
        en: "Your AI remembers the world.",
      },
      en: "Context that lingers.",
      body: {
        ja: "Codex はアプリ内データ。書き換えれば次のターンから AI が見る内容も即変わる。毎回アップロードし直さなくていい。",
        en: "The Codex is in-app data. Edit it and what the AI sees changes from the very next turn — no re-uploading, every time.",
      },
      chip: "TALK",
      moveTag: "↳ MOVE 03",
    },
    {
      pain: {
        ja: "死んだはずのキャラが、後の章で生きている。",
        en: "A character who should be dead is alive again two chapters later.",
      },
      title: {
        ja: "設定が、時系列で進む。",
        en: "Settings that move through time.",
      },
      en: "Phase-aware Codex.",
      body: {
        ja: "Phase は物語進行のスナップショット。シーン毎に Phase を切り替えれば Codex の値が時系列で変化し、過去シーンには過去の Phase の状態のまま AI が読みに行く。死んだキャラは、それ以降のシーンでは死んだまま。",
        en: "A Phase is a snapshot of story progress. Switch Phase per scene and Codex values shift over time; for past scenes the AI reads the past Phase's state. A character who died stays dead in every scene after.",
      },
      chip: "CODEX · PHASE",
      moveTag: "↳ MOVE 02",
    },
    {
      pain: {
        ja: "張った伏線を、回収するのを忘れてた。",
        en: "I planted a foreshadow and forgot to pay it off.",
      },
      title: {
        ja: "伏線が、構造化される。",
        en: "Foreshadowing, made structural.",
      },
      en: "Foreshadows, structured.",
      body: {
        ja: "未回収の伏線は、状態（仕込み済み・回収待ち・回収済み）付きで一覧できる構造化データとして Foreshadow に残る。AI 文脈にも自動で乗るが、まず自分の目で回収漏れを確認できることが効く。",
        en: "Unpaid foreshadowing lives in Foreshadow as structured data you can list by state (planted, awaiting payoff, paid off). It rides into the AI context automatically — but the real win is seeing the gaps with your own eyes first.",
      },
      chip: "FORESHADOW",
      moveTag: "↳ MOVE 02",
    },
    {
      pain: {
        ja: "AI に書かせると、自分の声が消える。",
        en: "When I let AI write, my own voice disappears.",
      },
      title: {
        ja: "AI は、Co-Writer。",
        en: "AI as your co-writer.",
      },
      en: "AI as second opinion.",
      body: {
        ja: "Chat は本文生成より、矛盾チェック・壁打ちに使う設計。書いた一行が AI / 人間どちらに由来するかは文字単位で追跡されているので、自分の書いた箇所が常に見える。",
        en: "Chat is built less for generating prose than for consistency checks and sparring. Every line is tracked character by character as AI- or human-authored, so what you wrote always stays visible.",
      },
      chip: "ATTRIBUTION",
      moveTag: "↳ MOVE 01",
    },
    {
      pain: {
        ja: "クラウドに原稿を預けたくない。",
        en: "I don't want to hand my manuscript to the cloud.",
      },
      title: {
        ja: "ローカルファースト。",
        en: "Local-first.",
      },
      en: "Local-first, account-free.",
      body: {
        ja: "原稿は SQLite にローカル保存。原稿本文が端末外へ出るのは、接続先を確認して自分でAI処理を実行した場合。Electron版では、ライセンス検証、更新確認、意味検索モデル取得の通信も発生する場合がある。ローカルLLMにも対応。",
        en: "Your manuscript is stored locally in SQLite. Context leaves the device when you explicitly send it to a configured AI. Electron may also contact services for license validation, update checks, and semantic-model downloads. Local LLMs are supported too.",
      },
      chip: "LOCAL",
      moveTag: "(INFRA)",
    },
  ];

  return (
    <LPLangContext.Provider value={lang}>
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
              <button
                type="button"
                onClick={toggleLang}
                className="hz-pop"
                aria-label={
                  lang === "en" ? "日本語に切り替え" : "Switch to English"
                }
                title={lang === "en" ? "日本語" : "English"}
                style={{
                  display: "inline-flex",
                  alignItems: "stretch",
                  border: `2px solid ${HZ_INK}`,
                  background: HZ_BG,
                  padding: 0,
                  cursor: "pointer",
                  overflow: "hidden",
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: ".08em",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    padding: "9px 9px",
                    background: lang === "ja" ? HZ_INK : HZ_BG,
                    color: lang === "ja" ? HZ_BG : HZ_INK,
                  }}
                >
                  JA
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    padding: "9px 9px",
                    borderLeft: `2px solid ${HZ_INK}`,
                    background: lang === "en" ? HZ_INK : HZ_BG,
                    color: lang === "en" ? HZ_BG : HZ_INK,
                  }}
                >
                  EN
                </span>
              </button>
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
            {lang === "en" ? (
              <>
                {"書いている"}
                <span className="hz-mark">{"。"}</span>
              </>
            ) : (
              <>
                YOU&rsquo;RE WRITING<span className="hz-mark">.</span>
              </>
            )}
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
                  fontFamily:
                    "'Inter Tight', 'Helvetica Neue', Helvetica, Arial",
                  width: "max-content",
                  maxWidth: "100%",
                }}
              >
                <span data-hz-hero-line className="hz-split">
                  {lang === "en"
                    ? "Even when"
                    : "\u66f8\u3044\u3066\u306a\u3044"}
                </span>
                <span data-hz-hero-line className="hz-split">
                  {lang === "en"
                    ? "you\u2019re idle,"
                    : "\u6642\u9593\u3082\u3001"}
                </span>
                <span
                  data-hz-hero-line
                  data-hz-hero-marker
                  className="hz-mark hz-split hz-hero-marker"
                >
                  {lang === "en"
                    ? "you\u2019re writing."
                    : "\u66f8\u3044\u3066\u3044\u308b\u3002"}
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
                    ELECTRON · LOCAL · CLI · BYOK
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
                      {lang === "en" ? "WHY ──" : "EN ──"}
                    </div>
                    <p
                      style={{
                        fontSize: 22,
                        lineHeight: 1.35,
                        margin: 0,
                        fontWeight: 600,
                      }}
                    >
                      {lang === "en" ? (
                        <>
                          The fidget{" "}
                          <span
                            className="hz-mark"
                            style={{ padding: "0 6px" }}
                          >
                            is the work.
                          </span>
                        </>
                      ) : (
                        <>
                          Even when you're not writing,{" "}
                          <span
                            className="hz-mark"
                            style={{ padding: "0 6px" }}
                          >
                            you're writing.
                          </span>
                        </>
                      )}
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
                      {lang === "en"
                        ? "IDLE MOVES — TIDYING CODEX, EYEING THE MAP, CHATTING WITH AI — FEED THE NEXT LINE."
                        : "THE FIDGET IS THE WORK. IDLE MOVES FEED THE NEXT LINE."}
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
                      {lang === "en" ? "HOW ──" : "JA ──"}
                    </div>
                    <p style={{ fontSize: 16, lineHeight: 1.85, margin: 0 }}>
                      {lang === "en" ? (
                        <>
                          The golden rule of writing tools is to never break
                          your focus.
                          <br />
                          Grimodex turns even the time outside that focus into
                          writing.
                          <br />
                          Tidying the Codex, eyeing the Map, chatting with the
                          AI —{" "}
                          <span
                            className="hz-mark"
                            style={{ padding: "0 4px" }}
                          >
                            it all feeds the next line.
                          </span>
                        </>
                      ) : (
                        <>
                          執筆ツールの王道は、集中を邪魔しないこと。
                          <br />
                          Grimodex は、集中の外側にある時間まで執筆に変える。
                          <br />
                          Codex を整える時間も、Map を眺める時間も、AI
                          と雑談する時間も——
                          <span
                            className="hz-mark"
                            style={{ padding: "0 4px" }}
                          >
                            全部、次の一行に効く。
                          </span>
                        </>
                      )}
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
                        <b>ELECTRON</b>
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
                          v2.0.10
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
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 40,
            }}
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
                  kicker_en: { ja: "WRITE · 書く", en: "WRITE" },
                  title: {
                    ja: ["書き手は、", "あなたのまま。"],
                    en: ["You stay", "the writer."],
                  },
                  title_en: "Your voice stays your own.",
                  body: {
                    ja: "自分の文章で本文を進める。AI は「必要なときだけ呼ぶ」道具で、ハンドルを奪わない。",
                    en: "Move the prose forward in your own words. The AI is a tool you call only when needed — it never grabs the wheel.",
                  },
                  chips: ["Editor", "Scenes", "Snippets"],
                  out: { ja: "一行が積まれる。", en: "One more line lands." },
                  out_en: "Lines accumulate.",
                  accent: "+1 LINE",
                  flow: "↓ feeds 02",
                },
                {
                  no: "02",
                  kicker_en: { ja: "STRUCTURE · 構造的重力", en: "STRUCTURE" },
                  title: {
                    ja: ["構造化への、", "重力。"],
                    en: ["Structure", "has gravity."],
                  },
                  title_en: "A gravity toward structure.",
                  body: {
                    ja: "Structural Gravity（構造的重力）— 書いた本文を、構造化する力。Codex の言及が Matrix の格子に並び、シーンが Timeline の点に変わる。Phase（物語進行のスナップショット）を切り替えれば、Codex の値が時系列で変化していく。",
                    en: "Structural Gravity — the force that structures the prose you've written. Codex mentions line up in the Matrix grid, scenes become points on the Timeline, and switching Phase (a snapshot of story progress) shifts Codex values across time.",
                  },
                  chips: ["Codex", "Phase", "Matrix", "Timeline"],
                  out: { ja: "構造が見える。", en: "The skeleton shows." },
                  out_en: "See the skeleton.",
                  accent: "+1 GRAVITY",
                  flow: "↓ feeds 03",
                },
                {
                  no: "03",
                  kicker_en: { ja: "TALK · 壁打ち", en: "TALK" },
                  title: {
                    ja: ["AI には書かせず、", "アイデアを揉む。"],
                    en: ["Don't ghostwrite —", "knead the ideas."],
                  },
                  title_en: "Spar with AI. Don't ghostwrite.",
                  body: {
                    ja: "Chat はシーンごとに独立。AI はそのシーンの本文・関連 Codex・未回収の伏線等を見た状態で答える。ブレスト、設定を煮詰め、物語を強化する。",
                    en: "Chat is independent per scene. The AI answers having seen that scene's prose, the relevant Codex, and any unpaid foreshadowing. Brainstorm, distill settings, and strengthen the story.",
                  },
                  chips: ["Chat", "ChatHistory", "Foreshadow"],
                  out: { ja: "設定が深くなる。", en: "The world deepens." },
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
                        ── {lpText(f.kicker_en, lang)}
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
                        {lpText(f.title, lang).map((line, k, lines) => (
                          <span key={k} style={{ display: "block" }}>
                            {k === lines.length - 1 ? (
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
                      {lang === "ja" && (
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
                      )}
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
                        {lpText(f.body, lang)}
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
                          {lpText(f.out, lang)}
                        </span>
                        {lang === "ja" && (
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
                        )}
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
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 40,
            }}
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
                  {
                    key: "plotter",
                    label: "PLOTTER",
                    desc: { ja: "先に構造を作る", en: "Structure first" },
                  },
                  {
                    key: "pantser",
                    label: "PANTSER",
                    desc: { ja: "探索しながら書く", en: "Write to explore" },
                  },
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
                        {lpText(mode.desc, lang)}
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
                  {lang === "en"
                    ? "Same destination. Different route."
                    : "終点は同じ。経路は別。"}
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
                        {lang === "ja" && (
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
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 13,
                          lineHeight: 1.55,
                          opacity: 0.78,
                          marginTop: 10,
                        }}
                      >
                        {lpText(s.t, lang)}
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
            style={{
              display: "grid",
              gridTemplateColumns: "180px 1fr",
              gap: 40,
            }}
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
                    key={u.en}
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
                        <span>
                          {lang === "en"
                            ? `“${lpText(u.pain, lang)}”`
                            : `「${lpText(u.pain, lang)}」`}
                        </span>
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
                        {lpText(u.title, lang)}
                      </div>
                      {lang === "ja" && (
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
                      )}
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
                      {lpText(u.body, lang)}
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
            {lang === "en"
              ? "30-DAY FULL TRIAL · LOCAL-FIRST · BRING YOUR OWN AI KEY"
              : "30日間フル機能トライアル · ローカルファースト · 自分のAIキーで"}
          </p>
          {/* PRICE — 景表法対応の「予告」形式。取り消し線での比較表示はしない。
              発売日 2026-07-26 から1か月の発売記念価格を表示する。 */}
          <div
            style={{
              maxWidth: 640,
              margin: "40px auto 0",
              border: `2px solid ${HZ_INK}`,
              padding: "22px 26px",
              textAlign: "left",
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".1em",
                opacity: 0.65,
                marginBottom: 10,
              }}
            >
              {lang === "en"
                ? "GRIMODEX v2.0.10 · ONE-TIME PURCHASE"
                : "GRIMODEX v2.0.10 · 買い切り"}
            </div>
            <div
              style={{
                fontSize: 23,
                fontWeight: 800,
                letterSpacing: -0.5,
                lineHeight: 1.35,
                marginBottom: 12,
              }}
            >
              {lang === "en" ? (
                <>
                  Launch price{" "}
                  <span className="hz-mark" style={{ padding: "0 6px" }}>
                    ¥6,900
                  </span>{" "}
                  <span
                    style={{ fontSize: 15, fontWeight: 400, opacity: 0.75 }}
                  >
                    through August 26, 2026. Regular price ¥8,900 from August
                    27.
                  </span>
                </>
              ) : (
                <>
                  発売記念価格{" "}
                  <span className="hz-mark" style={{ padding: "0 6px" }}>
                    ¥6,900
                  </span>{" "}
                  <span
                    style={{ fontSize: 15, fontWeight: 400, opacity: 0.75 }}
                  >
                    （2026年8月26日まで）。8月27日以降は通常価格 ¥8,900。
                  </span>
                </>
              )}
            </div>
            <ul
              style={{
                margin: 0,
                paddingLeft: 20,
                fontSize: 14,
                lineHeight: 1.8,
                opacity: 0.85,
              }}
            >
              <li>
                {lang === "en"
                  ? "30-day full-feature trial — every feature, no purchase required."
                  : "30日間フル機能トライアル（購入不要ですべての機能が使えます）。"}
              </li>
              <li>
                {lang === "en"
                  ? "One-time purchase; paid upgrade only per major version."
                  : "買い切り。メジャーバージョンごとに有償アップグレード。"}
              </li>
              <li>
                {lang === "en"
                  ? "Purchase is available only from the installed desktop app after you confirm it starts on your computer."
                  : "購入は、デスクトップアプリが起動することを確認した後、アプリ内からのみ行えます。"}
              </li>
            </ul>
          </div>
          <div
            className="hz-cta-actions"
            style={{
              display: "flex",
              flexWrap: "wrap",
              justifyContent: "center",
              alignItems: "stretch",
              gap: 18,
              marginTop: 44,
            }}
          >
            <a
              href="https://grimodex-try.pages.dev/"
              target="_blank"
              rel="noreferrer"
              className="hz-shadow"
              style={{
                background: HZ_BG,
                color: HZ_INK,
                border: `2px solid ${HZ_INK}`,
                padding: "22px 30px",
                textAlign: "left",
                cursor: "pointer",
                display: "inline-flex",
                flex: "1 1 320px",
                flexDirection: "column",
                gap: 5,
                maxWidth: 360,
                minWidth: 0,
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
                ↗ WEB EDITOR
              </div>
              <div
                style={{ fontWeight: 800, fontSize: 26, letterSpacing: -0.5 }}
              >
                {lang === "en" ? "Try in your browser" : "ブラウザで試す"}
              </div>
              <div
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 10,
                  textTransform: "uppercase",
                  opacity: 0.6,
                }}
              >
                {lang === "en"
                  ? "No install · Browser-local trial"
                  : "インストール不要 · ブラウザ内に保存"}
              </div>
            </a>
            <a
              href="https://github.com/kazormia296/Grimodex-Releases/releases/latest"
              className="hz-shadow"
              style={{
                background: HZ_HL,
                color: HZ_INK,
                border: `2px solid ${HZ_INK}`,
                padding: "22px 30px",
                textAlign: "left",
                cursor: "pointer",
                display: "inline-flex",
                flex: "1 1 320px",
                flexDirection: "column",
                gap: 5,
                maxWidth: 360,
                minWidth: 0,
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
              <div
                style={{ fontWeight: 800, fontSize: 26, letterSpacing: -0.5 }}
              >
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

          <div
            style={{
              maxWidth: 760,
              margin: "32px auto 0",
              border: `2px solid ${HZ_INK}`,
              background: HZ_HL,
              padding: "18px 22px",
              textAlign: "left",
            }}
          >
            <div
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 11,
                textTransform: "uppercase",
                letterSpacing: ".1em",
                opacity: 0.65,
                marginBottom: 14,
              }}
            >
              {lang === "en"
                ? "PURCHASE IN THE DESKTOP APP"
                : "デスクトップアプリ内で購入"}
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                lineHeight: 1.75,
              }}
            >
              {lang === "en"
                ? "Install and launch Grimodex first. After confirming that it works on your computer, open Settings > License > Purchase a license. This website does not link directly to checkout."
                : "まずGrimodexをインストールして起動してください。お使いのPCで動作することを確認した後、「設定 > ライセンス > ライセンスを購入」から決済へ進めます。このWebサイトから決済ページへ直接移動することはできません。"}
            </p>
            <p
              style={{
                margin: "10px 0 0",
                fontSize: 13,
                lineHeight: 1.7,
                opacity: 0.75,
              }}
            >
              {lang === "en"
                ? "Checkout and license delivery are handled by Polar, our authorized reseller. The checkout screen and confirmation email may appear in English."
                : "決済とライセンスキーの発行は、ライセンス管理事業者のPolarが行います。チェックアウト画面と購入確認メールは英語で表示される場合があります。"}
            </p>
          </div>

          <div style={{ marginTop: 80 }}>
            <HZBar
              items={[
                { t: "GRIMODEX", k: true },
                { t: "v2.0.10" },
                { t: "ELECTRON" },
                {
                  t: "GITHUB ↗",
                  href: "https://github.com/kazormia296/Grimodex",
                },
                {
                  t: "WIKI ↗",
                  href: "https://github.com/kazormia296/Grimodex/wiki",
                },
                { t: "DISCORD ↗", href: "https://discord.gg/ufPXC48kfX" },
                { t: "© 2026", hl: true },
              ]}
            />
          </div>
        </section>
      </LPFrame>
    </LPLangContext.Provider>
  );
}
window.LPVariantH = LPVariantH;
