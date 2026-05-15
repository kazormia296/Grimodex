/* eslint-disable */
/**
 * H · SWISS × ZINE — D's clean massive base, with G's highest-impact zine accents:
 *   yellow #fff200 highlight on key words, JetBrains Mono uppercase labels,
 *   bordered chips, a zbar of verbs, brutalist box-shadow CTA buttons.
 *   Whitespace stays Swiss; punctuation goes zine.
 */

const HZ_INK = "#0a0a0a";
const HZ_BG = "#ffffff";
const HZ_HL = "var(--hz-hl, #fff200)";

function HChip({ children, hl, on }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      border: `1.5px solid ${HZ_INK}`, padding: "3px 9px",
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
      textTransform: "uppercase", letterSpacing: ".06em",
      background: hl ? HZ_HL : on ? HZ_INK : HZ_BG,
      color: on ? HZ_BG : HZ_INK,
    }}>{children}</span>
  );
}

function HZBar({ items }) {
  return (
    <div style={{ display: "flex", borderTop: `2px solid ${HZ_INK}`, borderBottom: `2px solid ${HZ_INK}` }}>
      {items.map((it, i) => {
        const Component = it.href ? "a" : "div";
        return (
        <Component key={i} href={it.href} target={it.href ? "_blank" : undefined} rel={it.href ? "noreferrer" : undefined} style={{
          flex: it.k ? "0 0 auto" : 1,
          padding: "10px 18px",
          borderRight: i < items.length - 1 ? `2px solid ${HZ_INK}` : "none",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em",
          background: it.k ? HZ_INK : it.hl ? HZ_HL : HZ_BG,
          color: it.k ? HZ_BG : HZ_INK,
          fontWeight: it.k ? 700 : 400,
          textDecoration: "none",
        }}>{it.t}</Component>
        );
      })}
    </div>
  );
}

function HSectionMark({ tag, kicker }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 24 }}>
      <span style={{
        background: HZ_INK, color: HZ_BG, padding: "4px 8px",
        fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
        textTransform: "uppercase", letterSpacing: ".1em", fontWeight: 700,
      }}>{tag}</span>
      <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", color: "rgba(10,10,10,0.55)" }}>
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
      gsap.set(el, { autoAlpha: 1, y: 0, rotateX: 0, clipPath: "inset(0% 0% 0% 0%)" });
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
    <div ref={ref} style={{ ...style, opacity: 0, willChange: "transform, opacity, clip-path" }}>
      {children}
    </div>
  );
}

function LPVariantH() {
  const [workflowMode, setWorkflowMode] = useState("plotter");
  const panelPreviewRef = useRef(null);
  const workflowGridRef = useRef(null);
  const pagingLockRef = useRef(false);
  const heroTitleRef = useRef(null);
  const heroMetaRef = useRef(null);
  const heroBodyRef = useRef(null);

  useEffect(() => {
    const gsap = window.gsap;
    if (!gsap || !HMotionOK()) return undefined;

    const hoverListeners = [];
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".hz-nav-link",
        { y: -18, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.5, stagger: 0.045, ease: "back.out(1.8)", delay: 0.15 },
      );
      gsap.fromTo(
        ".hz-micro",
        { y: 22, autoAlpha: 0, rotate: -1.5 },
        { y: 0, autoAlpha: 1, rotate: 0, duration: 0.56, stagger: 0.04, ease: "power3.out", delay: 0.5 },
      );

      gsap.utils.toArray(".hz-pop").forEach((target) => {
        const enter = () => gsap.to(target, { y: -4, scale: 1.035, duration: 0.18, ease: "power2.out" });
        const leave = () => gsap.to(target, { y: 0, scale: 1, duration: 0.18, ease: "power2.out" });
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
    const heroBits = [
      heroMetaRef.current,
      heroBodyRef.current,
    ].filter(Boolean);
    if (!title || !gsap) return undefined;

    const lines = title.querySelectorAll("[data-hz-hero-line]");
    const marker = title.querySelector("[data-hz-hero-marker]");
    if (!HMotionOK()) {
      gsap.set([title, ...heroBits], { clearProps: "all", autoAlpha: 1 });
      gsap.set(lines, { autoAlpha: 1, y: 0, rotateX: 0 });
      gsap.set(marker, { "--hero-marker-scale": 1 });
      return undefined;
    }

    const ctx = gsap.context(() => {
      const rect = title.getBoundingClientRect();
      const navHeight =
        document.querySelector("[data-hz-nav]")?.getBoundingClientRect().height ?? 0;
      const centeredX = window.innerWidth / 2 - (rect.left + rect.width / 2);
      const groupRects = [
        rect,
        ...heroBits.map((element) => element.getBoundingClientRect()),
      ];
      const groupTop = Math.min(...groupRects.map((groupRect) => groupRect.top));
      const groupBottom = Math.max(...groupRects.map((groupRect) => groupRect.bottom));
      const groupHeight = groupBottom - groupTop;
      const availableHeight = window.innerHeight - navHeight;
      const centerCorrection = Math.min(96, Math.max(48, availableHeight * 0.065));
      const finalY = navHeight + (availableHeight - groupHeight) / 2 - groupTop + centerCorrection;

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

      gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .to(lines, {
          autoAlpha: 1,
          y: 0,
          rotateX: 0,
          duration: 0.9,
          stagger: 0.48,
        })
        .to(marker, {
          "--hero-marker-scale": 1,
          duration: 0.68,
          ease: "power3.out",
        }, "+=0")
        .to(title, {
          x: 0,
          duration: 1.18,
          ease: "expo.inOut",
        }, "+=0.18")
        .to(heroBits, {
          autoAlpha: 1,
          y: finalY,
          duration: 0.72,
          stagger: 0.12,
          ease: "power3.out",
        }, "+=0.06");
    }, title);

    return () => ctx.revert();
  }, []);

  useEffect(() => {
    const gsap = window.gsap;
    const target = panelPreviewRef.current;
    if (!gsap || !target || !HMotionOK()) return undefined;

    const tween = gsap.fromTo(
      target,
      { x: -12, autoAlpha: 0.65, filter: "contrast(1.35)" },
      { x: 0, autoAlpha: 1, filter: "contrast(1)", duration: 0.32, ease: "power3.out" },
    );
    return () => tween.kill();
  }, []);

  useEffect(() => {
    const gsap = window.gsap;
    const target = workflowGridRef.current;
    if (!gsap || !target || !HMotionOK()) return undefined;

    const tween = gsap.fromTo(
      target.children,
      { y: 26, autoAlpha: 0, rotate: -1.5 },
      { y: 0, autoAlpha: 1, rotate: 0, duration: 0.38, stagger: 0.055, ease: "back.out(1.7)" },
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
      const navOffset = getNavOffset();
      return pages.reduce(
        (best, page, index) => {
          const distance = Math.abs(page.getBoundingClientRect().top - navOffset);
          return distance < best.distance ? { distance, index } : best;
        },
        { distance: Number.POSITIVE_INFINITY, index: 0 },
      ).index;
    };

    const goToPage = (direction) => {
      const pages = getPages();
      if (pages.length === 0 || pagingLockRef.current) return false;

      const current = getCurrentIndex(pages);
      const next = Math.min(Math.max(current + direction, 0), pages.length - 1);
      if (next === current) return false;

      pagingLockRef.current = true;
      window.scrollTo({
        top: Math.max(0, pages[next].offsetTop - getNavOffset()),
        behavior: HMotionOK() ? "smooth" : "auto",
      });
      window.setTimeout(() => {
        pagingLockRef.current = false;
      }, HMotionOK() ? 720 : 120);
      return true;
    };

    const onWheel = (event) => {
      if (Math.abs(event.deltaY) < 18 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (pagingLockRef.current) return;
      if (goToPage(event.deltaY > 0 ? 1 : -1)) {
        event.preventDefault();
      }
    };

    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      if (["ArrowDown", "PageDown", " "].includes(event.key)) {
        if (goToPage(1)) event.preventDefault();
      }
      if (["ArrowUp", "PageUp"].includes(event.key)) {
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
      { n: "01", k: "PLAN", t: "先に構造を作る" },
      { n: "02", k: "CODEX", t: "設定・人物を固める" },
      { n: "03", k: "MAP", t: "章とシーンを配置" },
      { n: "04", k: "DRAFT", t: "設計に沿って書く" },
    ],
    pantser: [
      { n: "01", k: "DRAFT", t: "探索しながら書く" },
      { n: "02", k: "CHAT", t: "詰まった所を相談" },
      { n: "03", k: "EXTRACT", t: "思いつきを資産化" },
      { n: "04", k: "ARRANGE", t: "あとから整理する" },
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
      title: "本文の横に、作品世界を置く。",
      en: "Manuscript + World",
      body: "本文、キャラクター設定、世界観、用語、メモ、AIとの相談を分断せずに扱える。設定を見失う問題に効く。",
      chip: "CODEX",
    },
    {
      title: "長編に、地図を。",
      en: "Structure Map",
      body: "章構成、シーン、伏線、キャラの登場状況、情報開示の流れを俯瞰できる。物語の迷子を減らす。",
      chip: "MAP",
    },
    {
      title: "書くのはあなた。揺さぶるのはAI。",
      en: "AI as Support",
      body: "矛盾チェック、展開相談、キャラの反応確認、シーンの目的整理に使える。作者の主導権を奪わず、思考を補助する。",
      chip: "AI CHAT",
    },
    {
      title: "シーンの意味まで、見える化する。",
      en: "Scene Function",
      body: "脚本ならビートや会話の役割、TRPGならNPCや未回収要素。完成原稿だけでなく、進行中の物語構造を扱える。",
      chip: "BEATS",
    },
    {
      title: "脱線も、次の一行になる。",
      en: "Creative Fuel",
      body: "思いつき、没セリフ、未使用設定、AIとの雑談、ゴミ箱行きの文章も後から再利用できる。",
      chip: "SNIPPETS",
    },
  ];

  return (
    <LPFrame bg={HZ_BG} fontFamily="'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif">
      <style>{`
        .hz-mark{background:${HZ_HL};padding:0 10px;display:inline-block;line-height:0.95}
        .hz-hero-marker{--hero-marker-scale:0;background:transparent;position:relative;isolation:isolate;overflow:visible}
        .hz-hero-marker::before{content:"";position:absolute;left:0;right:0;bottom:.04em;height:.92em;background:${HZ_HL};transform:scaleX(var(--hero-marker-scale));transform-origin:left center;z-index:-1}
        .hz-shadow{box-shadow:5px 5px 0 ${HZ_INK}}
        .hz-split{display:block;width:max-content;transform-style:preserve-3d}
        .hz-pop{transform-origin:50% 80%;will-change:transform}
        .hz-page{min-height:calc(100vh - 76px);scroll-snap-align:start;scroll-snap-stop:always;display:flex;flex-direction:column;justify-content:center}
        html{scroll-snap-type:y mandatory;scroll-behavior:smooth}
      `}</style>

      {/* NAV */}
      <div data-hz-nav style={{ position: "sticky", top: 0, zIndex: 30, background: HZ_BG, borderTop: `4px solid ${HZ_INK}`, borderBottom: `2px solid ${HZ_INK}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "16px 48px", color: HZ_INK }}>
          <a href="#hero" style={{ display: "inline-flex", width: 190, color: HZ_INK }}>
            <img src="assets/grimodex-logo.svg" alt="Grimodex" style={{ width: "100%", height: "auto", display: "block" }} />
          </a>
          <div style={{ display: "flex", gap: 24, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>
            <a className="hz-nav-link" href="#hero" style={{ color: HZ_INK, textDecoration: "none" }}>A HERO</a>
            <a className="hz-nav-link" href="#workspace" style={{ color: HZ_INK, textDecoration: "none" }}>B WORKSPACE</a>
            <a className="hz-nav-link" href="#moves" style={{ color: HZ_INK, textDecoration: "none" }}>C MOVES</a>
            <a className="hz-nav-link" href="#workflow" style={{ color: HZ_INK, textDecoration: "none" }}>D WORKFLOW</a>
            <a className="hz-nav-link" href="#for" style={{ color: HZ_INK, textDecoration: "none" }}>E FOR</a>
          </div>
          <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 12 }}>
            <a href="#download" className="hz-shadow hz-pop" style={{ background: HZ_INK, color: HZ_BG, border: `2px solid ${HZ_INK}`, padding: "10px 18px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".08em", textDecoration: "none" }}>
              ↓ DOWNLOAD
            </a>
          </div>
        </div>
      </div>

      {/* HERO */}
      <section data-hz-page id="hero" className="hz-page" style={{ padding: "48px 48px 56px", color: HZ_INK, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "relative", zIndex: 1 }}>
          <div>
            <h1
              ref={heroTitleRef}
              data-hz-hero-title
              style={{
                margin: 0,
                fontSize: "clamp(72px, 13vw, 200px)", lineHeight: 0.88,
                fontWeight: 800, letterSpacing: "-0.035em",
                fontFamily: "'Inter Tight', 'Helvetica Neue', Helvetica, Arial",
                width: "max-content",
              }}
            >
              <span data-hz-hero-line className="hz-split">{"\u66f8\u3044\u3066\u306a\u3044"}</span>
              <span data-hz-hero-line className="hz-split">{"\u6642\u9593\u3082\u3001"}</span>
              <span
                data-hz-hero-line
                data-hz-hero-marker
                className="hz-mark hz-split hz-hero-marker"
              >
                {"\u66f8\u3044\u3066\u3044\u308b\u3002"}
              </span>
            </h1>
            <div ref={heroMetaRef} data-hz-hero-meta>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
                <span className="hz-micro" style={{ background: HZ_INK, color: HZ_BG, padding: "4px 10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em" }}>A / 01</span>
                <span className="hz-micro" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".18em" }}>
                  A <span className="hz-mark" style={{ padding: "0 6px" }}>WRITING FIDGET IDE</span>
                </span>
                <span style={{ flex: 1, height: 1, background: HZ_INK, opacity: 0.25, minWidth: 40 }} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(10,10,10,0.55)", textTransform: "uppercase", letterSpacing: ".12em" }}>TAURI · LOCAL · CLI · BYOK</span>
              </div>
            </div>
            <div ref={heroBodyRef} data-hz-hero-body>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 48, marginTop: 56, alignItems: "start" }}>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", color: "rgba(10,10,10,0.55)", marginBottom: 8 }}>EN ──</div>
                  <p style={{ fontSize: 22, lineHeight: 1.35, margin: 0, fontWeight: 600 }}>
                    Even when you're not writing, <span className="hz-mark" style={{ padding: "0 6px" }}>you're writing.</span>
                  </p>
                  <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.7, color: "rgba(10,10,10,0.6)", marginTop: 14, textTransform: "uppercase", letterSpacing: ".04em" }}>
                    THE FIDGET IS THE WORK. IDLE MOVES FEED THE NEXT LINE.
                  </p>
                </div>
                <div>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", color: "rgba(10,10,10,0.55)", marginBottom: 8 }}>JA ──</div>
                  <p style={{ fontSize: 16, lineHeight: 1.85, margin: 0 }}>
                    執筆ツールの王道は、集中を邪魔しないこと。<br />
                    Grimodex は、集中の外側にある時間まで執筆に変える。<br />
                    Codex を整える時間も、Map を眺める時間も、AI と雑談する時間も——<span className="hz-mark" style={{ padding: "0 4px" }}>全部、次の一行に効く。</span>
                  </p>
                </div>
                {/* Spec sheet — the zine fingerprint */}
                <div style={{ border: `2px solid ${HZ_INK}`, padding: "12px 16px", minWidth: 220, position: "relative" }}>
                  <span style={{ position: "absolute", top: -10, left: 10, background: HZ_BG, padding: "0 6px", fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em" }}>SPEC</span>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 2, textTransform: "uppercase", letterSpacing: ".04em" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${HZ_INK}` }}><span>RUNTIME</span><b>TAURI v2</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${HZ_INK}` }}><span>STORAGE</span><b>LOCAL</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${HZ_INK}` }}><span>AI</span><b>MCP / LOCAL / CLI / BYOK</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>STATUS</span><b style={{ background: HZ_HL, padding: "0 4px" }}>BETA</b></div>
                  </div>
                </div>
              </div>
            </div>
              </div>
        </div>
      </section>

      {/* ZBAR — writing verbs (zine fingerprint) */}
      {/* WORKSPACE */}
      <section data-hz-page id="workspace" className="hz-page" style={{ padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="B / 02" kicker="WORKSPACE" />
          <div>
            <HReveal>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 24px" }}>
                <span className="hz-mark">15 PANELS.</span><br />ONE DESK.
              </h2>
            </HReveal>
            <p style={{ fontSize: 16, lineHeight: 1.65, opacity: 0.8, maxWidth: 640, marginBottom: 40 }}>
              Editor、Scenes、AI Chat、Codex、Map、Timeline、Snippets、Attribution、Foreshadow、Grid、Matrix などを Dockview で自由配置。執筆・整理・相談を、作品ごとの机に組み替える。
            </p>
            <div className="hz-shadow" style={{ border: `2px solid ${HZ_INK}` }}>
              <div style={{ background: "#f6f3ec", padding: 22, color: HZ_INK }}>
                <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".12em", color: "rgba(10,10,10,0.48)", textTransform: "uppercase", marginBottom: 14 }}>
                  App window · layout presets
                </div>
                <div ref={panelPreviewRef} style={{ border: `2px solid ${HZ_INK}`, background: HZ_BG, overflow: "hidden", willChange: "transform, opacity, filter" }}>
                  <LPAppShellPreview accent={HZ_INK} activeIndicator="#fff200" minHeight={400} />
                </div>
                <p style={{ fontSize: 13, lineHeight: 1.65, opacity: 0.85, margin: "16px 0 0" }}>
                  タイトルバーは本番に近い構成（ロゴ・ワークスペース・履歴・エクスポート・レイアウトプリセット・パネル表示・設定）。中央のプリセットボタンで <b>Write / Plan / Chat / Proofread / Condense</b> を切り替えると、下の Dock グリドが組み換わります。
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* THREE MOVES — D layout, G accents */}
      <section data-hz-page id="moves" className="hz-page" style={{ padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="C / 03" kicker="THREE MOVES" />
          <div>
            <HReveal>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 56px" }}>
                THREE MOVES<br />THAT <span className="hz-mark">COMPOUND.</span>
              </h2>
            </HReveal>
            {COPY.features.slice(0, 3).map((f, i) => (
              <HReveal key={f.no} delay={i * 0.08}>
                <div style={{
                  borderTop: `2px solid ${HZ_INK}`,
                  padding: "44px 0",
                  display: "grid", gridTemplateColumns: "100px 1fr 1fr 120px", gap: 32,
                  alignItems: "start",
                }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 64, fontWeight: 800, lineHeight: 0.9, letterSpacing: -3 }}>
                    {f.no}
                  </div>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", opacity: 0.55, marginBottom: 12 }}>
                      ── {f.kicker_en}
                    </div>
                    <h3 style={{ fontSize: 44, lineHeight: 1, fontWeight: 800, letterSpacing: -1.5, margin: 0, textTransform: "none" }}>
                      {f.title_ja.map((line, k) => (
                        <span key={k} style={{ display: "block" }}>
                          {k === f.title_ja.length - 1
                            ? <span className="hz-mark" style={{ padding: "0 6px" }}>{line}</span>
                            : line}
                        </span>
                      ))}
                    </h3>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, opacity: 0.55, marginTop: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>{f.title_en}</div>
                  </div>
                  <div>
                    <p style={{ fontSize: 15, lineHeight: 1.75, margin: 0 }}>{f.body_ja}</p>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                    <HChip>0{i + 1} / 03</HChip>
                    <HChip hl>{["CODEX", "MAP", "AI CHAT"][i]}</HChip>
                  </div>
                </div>
              </HReveal>
            ))}
          </div>
        </div>
      </section>

      {/* WORKFLOW */}
      <section data-hz-page id="workflow" className="hz-page" style={{ padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="D / 04" kicker="WORKFLOW" />
          <div>
            <HReveal>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 48px" }}>
                PLOTTER OR<br />
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
                    onClick={(event) => handleWorkflowModeClick(mode.key, event)}
                    style={{
                      background: active ? HZ_HL : HZ_BG,
                      color: HZ_INK,
                      border: `2px solid ${HZ_INK}`,
                      padding: "12px 16px",
                      minWidth: 180,
                      textAlign: "left",
                      cursor: "pointer",
                      fontFamily: "'JetBrains Mono', monospace",
                      boxShadow: active ? `4px 4px 0 ${HZ_INK}` : `0 0 0 ${HZ_INK}`,
                      transformOrigin: "50% 80%",
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}>{mode.label}</div>
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>{mode.desc}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ border: `2px solid ${HZ_INK}` }}>
              <div ref={workflowGridRef} style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
                {activeWorkflow.map((s, i) => (
                  <div key={s.n} style={{
                    borderRight: i < 3 ? `2px solid ${HZ_INK}` : "none",
                    padding: "32px 24px", minHeight: 220, position: "relative",
                    background: i === 0 ? HZ_HL : HZ_BG,
                  }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", opacity: 0.7 }}>STEP {s.n}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontWeight: 800, fontSize: 36, letterSpacing: -1, marginTop: 6 }}>{s.k}</div>
                    <div style={{ fontSize: 14, opacity: 0.75, marginTop: 8 }}>{s.t}</div>
                    {i < 3 && (
                      <div style={{ position: "absolute", right: -14, top: "50%", transform: "translateY(-50%)", width: 26, height: 26, background: HZ_BG, border: `2px solid ${HZ_INK}`, borderRadius: "50%", display: "grid", placeItems: "center", fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 800, zIndex: 2 }}>→</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ marginTop: 18 }}>
              <HZBar items={[
                { t: "NO SINGLE FLOW", k: true },
                { t: workflowMode === "pantser" ? "PANTSER ACTIVE" : "PANTSER" },
                { t: workflowMode === "plotter" ? "PLOTTER ACTIVE" : "PLOTTER" },
                { t: "HYBRID", hl: true },
                { t: "↳ GRIMODEX :: FITS THE DRAFT" },
              ]} />
            </div>
          </div>
        </div>
      </section>

      {/* USE CASES */}
      <section data-hz-page id="for" className="hz-page" style={{ padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="E / 05" kicker="FOR" />
          <div>
            <HReveal>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 48px" }}>
                WHY WRITE<br /><span className="hz-mark">HERE?</span>
              </h2>
            </HReveal>
            <div style={{ border: `2px solid ${HZ_INK}` }}>
              {advantageRows.map((u, i) => (
                <div key={u.title} style={{
                  borderBottom: i < advantageRows.length - 1 ? `2px solid ${HZ_INK}` : "none",
                  display: "grid", gridTemplateColumns: "70px 280px 1fr 110px", gap: 0,
                  alignItems: "stretch",
                }}>
                  <div style={{ borderRight: `2px solid ${HZ_INK}`, padding: "20px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 22, fontWeight: 800, display: "flex", alignItems: "center" }}>
                    0{i + 1}
                  </div>
                  <div style={{ borderRight: `2px solid ${HZ_INK}`, padding: "20px 18px" }}>
                    <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: -0.5, lineHeight: 1.12 }}>{u.title}</div>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, opacity: 0.6, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 6 }}>{u.en}</div>
                  </div>
                  <div style={{ padding: "20px 18px", borderRight: `2px solid ${HZ_INK}`, fontSize: 14, lineHeight: 1.7 }}>
                    {u.body}
                  </div>
                  <div style={{ padding: "20px 14px", display: "flex", alignItems: "center", justifyContent: "center", background: i === 0 ? HZ_HL : HZ_BG }}>
                    <HChip>{u.chip}</HChip>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA — D's massive scale, G's brutalist buttons */}
      <section data-hz-page id="download" className="hz-page" style={{ padding: "120px 48px", color: HZ_INK, textAlign: "center" }}>
        <h2 style={{ fontSize: 220, lineHeight: 0.86, fontWeight: 800, letterSpacing: -8, margin: 0 }}>
          WRITE<br />
          <span className="hz-mark" style={{ padding: "0 18px" }}>DIFFERENTLY.</span>
        </h2>
        <p style={{ fontSize: 16, opacity: 0.65, marginTop: 28, fontFamily: "'JetBrains Mono', monospace", textTransform: "uppercase", letterSpacing: ".08em" }}>
          FREE (BETA) · LOCAL-FIRST · BRING YOUR OWN AI KEY
        </p>
        <div style={{ display: "flex", justifyContent: "center", marginTop: 44 }}>
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
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em", opacity: 0.65 }}>↓ DOWNLOAD</div>
            <div style={{ fontWeight: 800, fontSize: 26, letterSpacing: -0.5 }}>GitHub Releases</div>
            <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", opacity: 0.6 }}>macOS / Windows / Linux</div>
          </a>
        </div>
        <div style={{ marginTop: 80 }}>
          <HZBar items={[
            { t: "GRIMODEX", k: true },
            { t: "BETA" },
            { t: "TAURI v2" },
            { t: "GITHUB ↗", href: "https://github.com/kazormia296/Grimodex" },
            { t: "DOCS ↗" },
            { t: "© 2026", hl: true },
          ]} />
        </div>
      </section>

    </LPFrame>
  );
}
window.LPVariantH = LPVariantH;
