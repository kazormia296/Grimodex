/* eslint-disable */
/**
 * H · SWISS × ZINE — D's clean massive base, with G's highest-impact zine accents:
 *   yellow #fff200 highlight on key words, JetBrains Mono uppercase labels,
 *   bordered chips, a zbar of verbs, brutalist box-shadow CTA buttons.
 *   Whitespace stays Swiss; punctuation goes zine.
 */

const HZ_INK = "#0a0a0a";
const HZ_BG = "#ffffff";
const HZ_RULE = "rgba(10,10,10,0.12)";
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
      {items.map((it, i) => (
        <div key={i} style={{
          flex: it.k ? "0 0 auto" : 1,
          padding: "10px 18px",
          borderRight: i < items.length - 1 ? `2px solid ${HZ_INK}` : "none",
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em",
          background: it.k ? HZ_INK : it.hl ? HZ_HL : HZ_BG,
          color: it.k ? HZ_BG : HZ_INK,
          fontWeight: it.k ? 700 : 400,
        }}>{it.t}</div>
      ))}
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

function LPVariantH() {
  const [selectedPanel, setSelectedPanel] = useState(0);
  const [workflowMode, setWorkflowMode] = useState("plotter");

  const panelDetails = [
    { name: "Scenes", copy: "章とシーンを管理し、いま書く場所へすぐ戻れる入口。長い原稿でも迷子になりにくい。" },
    { name: "Editor", copy: "本文を書く中心。AI挿入や帰属ラベルを保持しながら、通常の原稿として編集できる。" },
    { name: "AI Chat", copy: "本文を書かせるだけではなく、設定確認・表現案・構成相談・校閲をその場で揉める相談席。" },
    { name: "Chat History", copy: "シーンごとの相談履歴を残し、以前の判断や候補案へ戻りやすくする。" },
    { name: "Codex", copy: "人物、用語、世界観、アイデアを本文と並行して育てる設定資産の置き場。" },
    { name: "Codex Quick", copy: "チャットや本文から浮かんだ思いつきを、手早くCodexへ送るための軽い入口。" },
    { name: "Map", copy: "章、シーン、断片、アイデアを配置で見渡す。書けない時は本文ではなく地図を触れる。" },
    { name: "Timeline", copy: "出来事の順序や前後関係を確認し、物語時間の混線をほどく。" },
    { name: "Snippets", copy: "使い回したい断片、候補文、会話から拾った素材を本文の横に置いておける。" },
    { name: "Attribution", copy: "human / ai / unknown の由来を確認する作業用の記録。第三者証明ではなく推敲の補助。" },
    { name: "Kouetsu", copy: "校閲・検討用の視点を置く場所。矛盾、表現、読み味を本文の横で確認する。" },
    { name: "Foreshadow", copy: "伏線や回収予定を別枠で持ち、忘れたくない意図を作品資産として扱う。" },
    { name: "Grid", copy: "章やシーンを表として俯瞰し、抜け・偏り・密度を確認する。" },
    { name: "Matrix", copy: "人物、章、テーマなど複数軸の関係を整理し、複雑な作品をほどく。" },
    { name: "Trash Bin", copy: "消した要素を一時的に退避し、必要なら戻せる安全地帯。" },
  ];

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
        .hz-shadow{box-shadow:5px 5px 0 ${HZ_INK}}
      `}</style>

      {/* NAV */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, background: HZ_BG, borderTop: `4px solid ${HZ_INK}`, borderBottom: `2px solid ${HZ_INK}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "16px 48px", color: HZ_INK }}>
          <a href="#hero" style={{ display: "inline-flex", width: 190, color: HZ_INK }}>
            <img src="assets/grimodex-logo.svg" alt="Grimodex" style={{ width: "100%", height: "auto", display: "block" }} />
          </a>
          <div style={{ display: "flex", gap: 24, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em" }}>
            <a href="#hero" style={{ color: HZ_INK, textDecoration: "none" }}>A HERO</a>
            <a href="#workspace" style={{ color: HZ_INK, textDecoration: "none" }}>B WORKSPACE</a>
            <a href="#moves" style={{ color: HZ_INK, textDecoration: "none" }}>C MOVES</a>
            <a href="#workflow" style={{ color: HZ_INK, textDecoration: "none" }}>D WORKFLOW</a>
            <a href="#for" style={{ color: HZ_INK, textDecoration: "none" }}>E FOR</a>
          </div>
          <div style={{ justifySelf: "end", display: "flex", alignItems: "center", gap: 12 }}>
            <a href="#download" className="hz-shadow" style={{ background: HZ_INK, color: HZ_BG, border: `2px solid ${HZ_INK}`, padding: "10px 18px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".08em", textDecoration: "none" }}>
              ↓ DOWNLOAD
            </a>
          </div>
        </div>
      </div>

      {/* HERO */}
      <section id="hero" style={{ padding: "120px 48px 80px", color: HZ_INK, position: "relative" }}>
        <div>
          <div>
            <_Rev2>
              <h1 style={{
                margin: 0,
                fontSize: "clamp(72px, 13vw, 200px)", lineHeight: 0.88,
                fontWeight: 800, letterSpacing: "-0.035em",
                fontFamily: "'Inter Tight', 'Helvetica Neue', Helvetica, Arial",
              }}>
                書いていない<br />
                時間も、<br />
                <span className="hz-mark">書いている。</span>
              </h1>
            </_Rev2>
            <_Rev2 delay={80}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 28, flexWrap: "wrap" }}>
                <span style={{ background: HZ_INK, color: HZ_BG, padding: "4px 10px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em" }}>A / 01</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".18em" }}>
                  A <span className="hz-mark" style={{ padding: "0 6px" }}>WRITING FIDGET IDE</span>
                </span>
                <span style={{ flex: 1, height: 1, background: HZ_INK, opacity: 0.25, minWidth: 40 }} />
                <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(10,10,10,0.55)", textTransform: "uppercase", letterSpacing: ".12em" }}>TAURI · LOCAL · CLI · BYOK</span>
              </div>
            </_Rev2>
            <_Rev2 delay={120}>
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
                    <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${HZ_INK}` }}><span>AI</span><b>LOCAL / CLI / BYOK</b></div>
                    <div style={{ display: "flex", justifyContent: "space-between" }}><span>STATUS</span><b style={{ background: HZ_HL, padding: "0 4px" }}>BETA</b></div>
                  </div>
                </div>
              </div>
            </_Rev2>
            <_Rev2 delay={220}>
              <div style={{ display: "flex", gap: 14, marginTop: 56, alignItems: "center", flexWrap: "wrap" }}>
                <a href="#download" className="hz-shadow" style={{ background: HZ_INK, color: HZ_BG, border: `2px solid ${HZ_INK}`, padding: "18px 28px", fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".06em", textDecoration: "none" }}>
                  ↓ DOWNLOAD ダウンロード
                </a>
                <a href="#workflow" className="hz-shadow" style={{ background: HZ_HL, color: HZ_INK, border: `2px solid ${HZ_INK}`, padding: "18px 24px", fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700, cursor: "pointer", textTransform: "uppercase", letterSpacing: ".06em", textDecoration: "none" }}>
                  SEE WORKFLOWS →
                </a>
                <HChip>MAC ·dmg</HChip><HChip>WIN ·msi</HChip><HChip>LINUX ·AppImage</HChip>
              </div>
            </_Rev2>
          </div>
        </div>
      </section>

      {/* ZBAR — writing verbs (zine fingerprint) */}
      <HZBar items={[
        { t: "VERBS", k: true },
        { t: "DRAFT" },
        { t: "ASK" },
        { t: "EXTRACT", hl: true },
        { t: "ARRANGE" },
        { t: "REVISE" },
      ]} />

      {/* WORKSPACE */}
      <section id="workspace" style={{ padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="B / 02" kicker="WORKSPACE" />
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 24px" }}>
                <span className="hz-mark">15 PANELS.</span><br />ONE DESK.
              </h2>
            </_Rev2>
            <p style={{ fontSize: 16, lineHeight: 1.65, opacity: 0.8, maxWidth: 640, marginBottom: 40 }}>
              Editor、Scenes、AI Chat、Codex、Map、Timeline、Snippets、Attribution、Foreshadow、Grid、Matrix などを Dockview で自由配置。執筆・整理・相談を、作品ごとの机に組み替える。
            </p>
            <div className="hz-shadow" style={{ border: `2px solid ${HZ_INK}` }}>
              <div style={{ background: "#f6f3ec", minHeight: 360, display: "grid", gridTemplateColumns: "220px 1fr 280px", color: HZ_INK }}>
                <div style={{ borderRight: `1px solid ${HZ_RULE}`, padding: 22 }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".12em", color: "rgba(10,10,10,0.48)", textTransform: "uppercase", marginBottom: 18 }}>Selected Panel</div>
                  <h3 style={{ fontSize: 32, lineHeight: 1, margin: 0, letterSpacing: -1 }}>{panelDetails[selectedPanel].name}</h3>
                  <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 18 }}>{panelDetails[selectedPanel].copy}</p>
                </div>
                <div style={{ padding: 28, borderRight: `1px solid ${HZ_RULE}` }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".12em", color: "rgba(10,10,10,0.48)", textTransform: "uppercase", marginBottom: 16 }}>Preview</div>
                  <div style={{ border: `2px solid ${HZ_INK}`, background: HZ_BG, minHeight: 230, padding: 20 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ff5f57" }} />
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#ffbd2e" }} />
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#28c840" }} />
                      <span style={{ marginLeft: 10, fontFamily: "'JetBrains Mono', monospace", fontSize: 10, color: "rgba(10,10,10,0.48)" }}>grimodex · panel-focus</span>
                    </div>
                    <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: -2, lineHeight: 0.95 }}>
                      {panelDetails[selectedPanel].name}
                    </div>
                    <div style={{ marginTop: 18, height: 8, width: "70%", background: HZ_HL }} />
                    <div style={{ marginTop: 26, display: "grid", gap: 10 }}>
                      {[0, 1, 2].map((line) => (
                        <div key={line} style={{ height: 12, width: `${86 - line * 16}%`, background: "rgba(10,10,10,0.12)" }} />
                      ))}
                    </div>
                  </div>
                </div>
                <div style={{ padding: 22 }}>
                  <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, letterSpacing: ".12em", color: "rgba(10,10,10,0.48)", textTransform: "uppercase", marginBottom: 14 }}>Detail</div>
                  <p style={{ fontSize: 15, lineHeight: 1.7, margin: 0 }}>
                    パネルを押すと、左のプレビューと説明が切り替わります。実スクリーンショットが用意できたら、この枠だけ画像に差し替えられます。
                  </p>
                </div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", border: `2px solid ${HZ_INK}`, borderTop: 0, marginTop: 0 }}>
              {COPY.panels.map((p, i) => {
                const accent = i === selectedPanel;
                return (
                  <button key={p} onClick={() => setSelectedPanel(i)} style={{
                    borderRight: (i % 5) < 4 ? `2px solid ${HZ_INK}` : "none",
                    borderBottom: i < 10 ? `2px solid ${HZ_INK}` : "none",
                    padding: "16px 14px",
                    background: accent ? HZ_HL : HZ_BG,
                    textAlign: "left",
                    cursor: "pointer",
                    color: HZ_INK,
                    font: "inherit",
                  }}>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 10, textTransform: "uppercase", letterSpacing: ".06em", opacity: 0.6 }}>P/{String(i + 1).padStart(2, "0")}</div>
                    <div style={{ fontWeight: 800, fontSize: 18, letterSpacing: -0.3, marginTop: 4 }}>{p}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* THREE MOVES — D layout, G accents */}
      <section id="moves" style={{ borderTop: `2px solid ${HZ_INK}`, padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="C / 03" kicker="THREE MOVES" />
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 56px" }}>
                THREE MOVES<br />THAT <span className="hz-mark">COMPOUND.</span>
              </h2>
            </_Rev2>
            {COPY.features.slice(0, 3).map((f, i) => (
              <_Rev2 key={f.no} delay={i * 80}>
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
              </_Rev2>
            ))}
          </div>
        </div>
      </section>

      {/* WORKFLOW */}
      <section id="workflow" style={{ borderTop: `2px solid ${HZ_INK}`, padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="D / 04" kicker="WORKFLOW" />
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 48px" }}>
                PLOTTER OR<br />
                <span className="hz-mark">PANTSER.</span>
              </h2>
            </_Rev2>
            <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
              {[
                { key: "plotter", label: "PLOTTER", desc: "先に構造を作る" },
                { key: "pantser", label: "PANTSER", desc: "探索しながら書く" },
              ].map((mode) => {
                const active = workflowMode === mode.key;
                return (
                  <button
                    key={mode.key}
                    onClick={() => setWorkflowMode(mode.key)}
                    style={{
                      background: active ? HZ_HL : HZ_BG,
                      color: HZ_INK,
                      border: `2px solid ${HZ_INK}`,
                      padding: "12px 16px",
                      minWidth: 180,
                      textAlign: "left",
                      cursor: "pointer",
                      fontFamily: "'JetBrains Mono', monospace",
                      boxShadow: active ? `4px 4px 0 ${HZ_INK}` : "none",
                    }}
                  >
                    <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: ".08em" }}>{mode.label}</div>
                    <div style={{ fontSize: 11, marginTop: 4, opacity: 0.7 }}>{mode.desc}</div>
                  </button>
                );
              })}
            </div>
            <div style={{ border: `2px solid ${HZ_INK}` }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
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
      <section id="for" style={{ borderTop: `2px solid ${HZ_INK}`, padding: "100px 48px", color: HZ_INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: 40 }}>
          <HSectionMark tag="E / 05" kicker="FOR" />
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 800, letterSpacing: -4, margin: "0 0 48px" }}>
                WHY WRITE<br /><span className="hz-mark">HERE?</span>
              </h2>
            </_Rev2>
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
      <section id="download" style={{ borderTop: `4px solid ${HZ_INK}`, padding: "120px 48px", color: HZ_INK, textAlign: "center" }}>
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
            { t: "GITHUB ↗" },
            { t: "DOCS ↗" },
            { t: "© 2026", hl: true },
          ]} />
        </div>
      </section>
    </LPFrame>
  );
}
window.LPVariantH = LPVariantH;
