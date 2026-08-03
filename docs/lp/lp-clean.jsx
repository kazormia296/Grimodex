/* eslint-disable */
/**
 * Clean + Massive batch — 3 variants.
 * D · SWISS BLANC      — pure white, near-monochrome, Helvetica-feel mass
 * E · EDITORIAL LIGHT  — off-white, oversized serif numerals, hairline grids
 * F · SOFT MODERN      — quiet gradient ground, Inter Tight mass, single accent
 *
 * Reuses: COPY, Reveal, Marquee, PanelMock, LPFrame from lp-variants.jsx.
 */

const { useEffect: useEffD, useRef: useRefD, useState: useStateD } = React;

// Tiny shared reveal — kept local to avoid name collision
function _Rev2({ children, style, delay = 0 }) {
  const ref = useRefD(null);
  const [shown, setShown] = useStateD(false);
  useEffD(() => {
    const el = ref.current; if (!el) return;
    const io = new IntersectionObserver(
      (es) => es.forEach((e) => e.isIntersecting && setShown(true)),
      { threshold: 0.15, root: el.closest("[data-artboard-scroll]") || null },
    );
    io.observe(el); return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ ...style, opacity: shown ? 1 : 0, transform: shown ? "translateY(0)" : "translateY(22px)", transition: `all 750ms cubic-bezier(.2,.8,.2,1) ${delay}ms` }}>
      {children}
    </div>
  );
}

/* ============================================================
   D · SWISS BLANC — pure white, mass via type-only
   ============================================================ */
function LPVariantD() {
  const BG = "#ffffff";
  const INK = "#0a0a0a";
  const RULE = "rgba(10,10,10,0.12)";
  const ACC = "#0033ff"; // a single Klein-blue accent

  return (
    <LPFrame bg={BG} fontFamily="'Inter Tight', 'Helvetica Neue', Helvetica, Arial, sans-serif">
      {/* NAV */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, background: BG, borderBottom: `1px solid ${RULE}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "20px 48px", color: INK }}>
          <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: -0.2 }}>Grimodex</div>
          <div style={{ display: "flex", gap: 28, fontSize: 12, opacity: 0.7 }}>
            <span>Features</span><span>Loop</span><span>Cases</span><span>FAQ</span>
          </div>
          <div style={{ justifySelf: "end", fontSize: 12 }}>
            <span style={{ marginRight: 14, opacity: 0.6 }}>v2.0.10</span>
            <button style={{ background: INK, color: BG, border: 0, padding: "10px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", letterSpacing: 0.2 }}>
              Download ↓
            </button>
          </div>
        </div>
      </div>

      {/* HERO — Swiss vertical grid, all type */}
      <section style={{ padding: "120px 48px 80px", color: INK, position: "relative" }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 40, alignItems: "flex-start" }}>
          <div style={{ fontSize: 11, lineHeight: 1.5, opacity: 0.55 }}>
            <div style={{ fontWeight: 700, marginBottom: 14, color: ACC }}>01 / Hero</div>
            <div>A Writing</div>
            <div>Fidget IDE</div>
            <div style={{ marginTop: 10, opacity: 0.6 }}>Electron · Local-first</div>
          </div>
          <div>
            <_Rev2>
              <h1 style={{
                margin: 0,
                fontSize: 184,
                lineHeight: 0.86,
                fontWeight: 700,
                letterSpacing: -7,
                fontFamily: "'Inter Tight', 'Helvetica Neue', Helvetica, Arial",
              }}>
                書いていない<br />
                時間も、<br />
                書いている。
              </h1>
            </_Rev2>
            <_Rev2 delay={120}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 60, marginTop: 56, maxWidth: 920 }}>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.5, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>EN</div>
                  <p style={{ fontSize: 22, lineHeight: 1.35, margin: 0, fontWeight: 500 }}>
                    Even when you're not writing, you're writing.
                  </p>
                  <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.7, marginTop: 14 }}>
                    Chat with AI. Codex extracts the world. The next prompt knows more. Long-form fiction, with a flywheel.
                  </p>
                </div>
                <div>
                  <div style={{ fontSize: 11, opacity: 0.5, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>JA</div>
                  <p style={{ fontSize: 22, lineHeight: 1.5, margin: 0, fontWeight: 500 }}>
                    Codex を整える時間も、Map をぼんやり眺める時間も、AI と雑談する時間も — 全部、次の一行に効く。
                  </p>
                </div>
              </div>
            </_Rev2>
            <_Rev2 delay={220}>
              <div style={{ display: "flex", gap: 18, marginTop: 64, alignItems: "center" }}>
                <button style={{ background: INK, color: BG, border: 0, padding: "20px 32px", fontSize: 16, fontWeight: 600, cursor: "pointer", letterSpacing: 0.2 }}>
                  Download ↓
                </button>
                <button style={{ background: BG, color: INK, border: `1px solid ${INK}`, padding: "20px 32px", fontSize: 16, fontWeight: 500, cursor: "pointer" }}>
                  See the loop →
                </button>
                <span style={{ fontSize: 12, opacity: 0.5, marginLeft: 8 }}>macOS · Windows · Linux · Local-first · BYOK</span>
              </div>
            </_Rev2>
          </div>
        </div>

        {/* Hairline metrics */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 24, display: "flex", justifyContent: "space-between", padding: "0 48px", fontSize: 10, opacity: 0.4, letterSpacing: 1, textTransform: "uppercase" }}>
          <span>v2.0.10 — 2026</span>
          <span>1280 × ∞</span>
          <span>Section 01 / 06</span>
        </div>
      </section>

      {/* WORKSPACE — restrained */}
      <section style={{ borderTop: `1px solid ${RULE}`, padding: "100px 48px", color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 40 }}>
          <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1, textTransform: "uppercase" }}>02 / Workspace</div>
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 700, letterSpacing: -4, margin: "0 0 24px" }}>
                A workspace. <span style={{ opacity: 0.4 }}>One brain.</span>
              </h2>
            </_Rev2>
            <p style={{ fontSize: 16, lineHeight: 1.6, opacity: 0.75, maxWidth: 600, marginBottom: 48 }}>
              Editor、AI Chat、Codex、Map、Timeline、Beats、Snippets、Foreshadow、Matrix、Scenes、Grid、Linter — Dockview で自由配置。
            </p>
            <PanelMock theme="light" accent={ACC} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", borderTop: `1px solid ${RULE}`, marginTop: 32 }}>
              {COPY.panels.map((p, i) => (
                <div key={p} style={{ borderRight: (i % 6) < 5 ? `1px solid ${RULE}` : "none", borderBottom: i < 6 ? `1px solid ${RULE}` : "none", padding: "14px 12px", fontSize: 12 }}>
                  <div style={{ opacity: 0.4, fontSize: 10 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div style={{ fontWeight: 600, marginTop: 2 }}>{p}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* THREE FEATURES */}
      <section style={{ borderTop: `1px solid ${RULE}`, padding: "100px 48px", color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 40 }}>
          <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1, textTransform: "uppercase" }}>03 / Three moves</div>
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 700, letterSpacing: -4, margin: "0 0 64px" }}>
                The three moves<br />
                that <span style={{ color: ACC }}>compound.</span>
              </h2>
            </_Rev2>
            {COPY.features.slice(0, 3).map((f, i) => (
              <_Rev2 key={f.no} delay={i * 100}>
                <div style={{ borderTop: `1px solid ${RULE}`, padding: "40px 0", display: "grid", gridTemplateColumns: "60px 1fr 1fr", gap: 32 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.5 }}>{f.no}</div>
                  <div>
                    <div style={{ fontSize: 11, letterSpacing: 1, opacity: 0.5, textTransform: "uppercase", marginBottom: 12 }}>{f.kicker_en}</div>
                    <h3 style={{ fontSize: 44, lineHeight: 1, fontWeight: 700, letterSpacing: -1.5, margin: 0 }}>
                      {f.title_ja.map((line, k) => (<span key={k} style={{ display: "block" }}>{line}</span>))}
                    </h3>
                    <div style={{ fontSize: 14, opacity: 0.5, marginTop: 12 }}>{f.title_en}</div>
                  </div>
                  <div>
                    <p style={{ fontSize: 14, lineHeight: 1.65, margin: "0 0 12px" }}>{f.body_ja}</p>
                    <p style={{ fontSize: 12, lineHeight: 1.6, opacity: 0.55, margin: 0 }}>{f.body_en}</p>
                  </div>
                </div>
              </_Rev2>
            ))}
          </div>
        </div>
      </section>

      {/* LOOP */}
      <section style={{ borderTop: `1px solid ${RULE}`, padding: "100px 48px", color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 40 }}>
          <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1, textTransform: "uppercase" }}>04 / The loop</div>
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 700, letterSpacing: -4, margin: "0 0 48px" }}>
                A flywheel,<br />not a prompt.
              </h2>
            </_Rev2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderTop: `1px solid ${INK}`, borderBottom: `1px solid ${INK}` }}>
              {[
                { n: "01", k: "Write", t: "本文を書く" },
                { n: "02", k: "Chat", t: "AI と話す" },
                { n: "03", k: "Extract", t: "Codex に抽出" },
                { n: "04", k: "Reference", t: "次の文脈に効く" },
              ].map((s, i) => (
                <div key={s.n} style={{ borderRight: i < 3 ? `1px solid ${RULE}` : "none", padding: "32px 24px", minHeight: 200 }}>
                  <div style={{ fontSize: 11, color: ACC, letterSpacing: 1, marginBottom: 12 }}>{s.n}</div>
                  <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: -1 }}>{s.k}</div>
                  <div style={{ fontSize: 13, opacity: 0.6, marginTop: 8 }}>{s.t}</div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 14, opacity: 0.7, marginTop: 24, lineHeight: 1.65, maxWidth: 620 }}>
              毎回 0 から始めるプロンプトじゃない。あなたが書いた世界が、毎回プロンプトに乗る。だから 30 万字でも破綻しない。
            </p>
          </div>
        </div>
      </section>

      {/* USE CASES — minimal table */}
      <section style={{ borderTop: `1px solid ${RULE}`, padding: "100px 48px", color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 40 }}>
          <div style={{ fontSize: 11, opacity: 0.55, letterSpacing: 1, textTransform: "uppercase" }}>05 / For</div>
          <div>
            <_Rev2>
              <h2 style={{ fontSize: 112, lineHeight: 0.92, fontWeight: 700, letterSpacing: -4, margin: "0 0 48px" }}>
                For people who<br />keep making worlds.
              </h2>
            </_Rev2>
            <div style={{ borderTop: `1px solid ${INK}` }}>
              {COPY.usecases.map((u, i) => (
                <div key={u.ja} style={{ borderBottom: `1px solid ${RULE}`, display: "grid", gridTemplateColumns: "60px 220px 1fr", gap: 32, padding: "20px 0", alignItems: "baseline" }}>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div>
                    <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{u.ja}</div>
                    <div style={{ fontSize: 11, opacity: 0.55 }}>{u.en}</div>
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.6 }}>{u.desc_ja}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section style={{ borderTop: `1px solid ${INK}`, padding: "120px 48px", color: INK, textAlign: "center" }}>
        <h2 style={{ fontSize: 220, lineHeight: 0.86, fontWeight: 700, letterSpacing: -8, margin: 0 }}>
          Write<br /><span style={{ color: ACC }}>differently.</span>
        </h2>
        <p style={{ fontSize: 16, opacity: 0.65, marginTop: 28 }}>Local-first · Bring your own AI key.</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 36, flexWrap: "wrap" }}>
          {["macOS .dmg", "Windows .msi", "Linux .AppImage"].map((p) => (
            <button key={p} style={{ background: INK, color: BG, border: 0, padding: "20px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>
              ↓ {p}
            </button>
          ))}
        </div>
        <div style={{ marginTop: 80, fontSize: 11, opacity: 0.4, letterSpacing: 1, textTransform: "uppercase" }}>
          Grimodex · Electron · Local-first · BYOK
        </div>
      </section>
    </LPFrame>
  );
}
window.LPVariantD = LPVariantD;

/* ============================================================
   E · EDITORIAL LIGHT — off-white, hairline grid, oversized serif numerals
   ============================================================ */
function LPVariantE() {
  const BG = "#f6f3ec";
  const INK = "#1a1815";
  const RULE = "rgba(26,24,21,0.14)";
  const ACC = "#b8390e"; // burnt orange — single editorial accent

  return (
    <LPFrame bg={BG} fontFamily="'Inter Tight', 'Helvetica Neue', Arial, sans-serif">
      {/* NAV */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, background: BG, borderBottom: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", padding: "18px 56px", gap: 24, color: INK }}>
          <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 26, letterSpacing: -0.5 }}>Grimodex</div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 28, fontSize: 12, opacity: 0.65 }}>
            <span>Features</span><span>Loop</span><span>Cases</span><span>FAQ</span>
          </div>
          <button style={{ background: "transparent", color: INK, border: `1px solid ${INK}`, padding: "8px 16px", fontSize: 12, cursor: "pointer", borderRadius: 99 }}>
            Download ↓
          </button>
        </div>
      </div>

      {/* HERO */}
      <section style={{ padding: "100px 56px 60px", color: INK }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 48, alignItems: "flex-start" }}>
          <div style={{
            fontFamily: "'Instrument Serif', serif",
            fontStyle: "italic",
            fontSize: 320,
            lineHeight: 0.78,
            color: ACC,
            fontWeight: 400,
            letterSpacing: -10,
          }}>
            01.
          </div>
          <div style={{ paddingTop: 12 }}>
            <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55, marginBottom: 28 }}>
              ── A Writing Fidget IDE
            </div>
            <_Rev2>
              <h1 style={{
                margin: 0,
                fontSize: 152,
                lineHeight: 0.88,
                fontWeight: 700,
                letterSpacing: -5,
              }}>
                書いていない<br />
                時間も、<br />
                <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, color: ACC }}>書いている。</span>
              </h1>
            </_Rev2>
            <_Rev2 delay={120}>
              <p style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 24, lineHeight: 1.35, marginTop: 28, opacity: 0.7, maxWidth: 540 }}>
                Even when you're not writing, you're writing.
              </p>
              <p style={{ fontSize: 16, lineHeight: 1.65, marginTop: 18, maxWidth: 540 }}>
                Codex を整える時間も、Map をぼんやり眺める時間も、AI と雑談する時間も — 全部、次の一行に効く。執筆ツールの王道は「集中を邪魔しない」こと。Grimodex は逆を行く。
              </p>
            </_Rev2>
            <_Rev2 delay={220}>
              <div style={{ display: "flex", gap: 14, marginTop: 36, alignItems: "center" }}>
                <button style={{ background: INK, color: BG, border: 0, padding: "18px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer", borderRadius: 99 }}>
                  Download ↓
                </button>
                <span style={{ fontSize: 12, opacity: 0.55 }}>v2.0.10 · macOS · Windows · Linux · Local-first · BYOK</span>
              </div>
            </_Rev2>
          </div>
        </div>
      </section>

      {/* PULL QUOTE / EDITORIAL */}
      <section style={{ padding: "60px 56px 100px", color: INK, borderTop: `1px solid ${RULE}` }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 60, alignItems: "center" }}>
          <p style={{ fontFamily: "'Instrument Serif', serif", fontSize: 60, lineHeight: 1.05, fontStyle: "italic", margin: 0, fontWeight: 400, color: INK }}>
            <span style={{ color: ACC }}>"</span>The world thickens<br />while you tinker.<span style={{ color: ACC }}>"</span>
          </p>
          <div style={{ fontSize: 14, lineHeight: 1.7, opacity: 0.75, maxWidth: 480 }}>
            <p style={{ margin: 0 }}>
              書く以外の時間を、罪悪感なしに過ごせる執筆ツール。AI とのチャット、Codex の整理、Map のブレスト、タイムライン眺め — フィジェットそれ自体が、次の生成の文脈になる。
            </p>
            <div style={{ marginTop: 18, fontSize: 11, opacity: 0.5, letterSpacing: 1.5, textTransform: "uppercase" }}>
              ── On the philosophy
            </div>
          </div>
        </div>
      </section>

      {/* WORKSPACE */}
      <section style={{ padding: "80px 56px", color: INK, borderTop: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 12 }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 64, color: ACC, lineHeight: 0.9, fontWeight: 400 }}>02.</span>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55 }}>The Workspace</span>
        </div>
        <_Rev2>
          <h2 style={{ fontSize: 96, lineHeight: 0.92, fontWeight: 700, letterSpacing: -3.5, margin: "0 0 32px" }}>
            A workspace.<br />
            <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400 }}>Your</span> arrangement.
          </h2>
        </_Rev2>
        <PanelMock theme="light" accent={ACC} />
      </section>

      {/* FEATURES */}
      <section style={{ padding: "80px 56px", color: INK, borderTop: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 64, color: ACC, lineHeight: 0.9, fontWeight: 400 }}>03.</span>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55 }}>Three moves that compound</span>
        </div>
        {COPY.features.slice(0, 3).map((f, i) => (
          <_Rev2 key={f.no} delay={i * 100}>
            <div style={{ borderTop: `1px solid ${RULE}`, padding: "44px 0", display: "grid", gridTemplateColumns: "100px 1fr 1fr", gap: 36 }}>
              <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 64, color: ACC, lineHeight: 0.9, fontWeight: 400 }}>0{i + 1}</div>
              <div>
                <div style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55, marginBottom: 12 }}>{f.kicker_en}</div>
                <h3 style={{ fontSize: 44, fontWeight: 700, letterSpacing: -1.5, lineHeight: 1, margin: "0 0 12px" }}>
                  {f.title_ja.map((line, k) => (<span key={k} style={{ display: "block" }}>{line}</span>))}
                </h3>
                <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 16, opacity: 0.7 }}>{f.title_en}</div>
              </div>
              <div>
                <p style={{ fontSize: 15, lineHeight: 1.65, margin: 0 }}>{f.body_ja}</p>
              </div>
            </div>
          </_Rev2>
        ))}
      </section>

      {/* LOOP — minimal table */}
      <section style={{ padding: "80px 56px", color: INK, borderTop: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 16 }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 64, color: ACC, lineHeight: 0.9, fontWeight: 400 }}>04.</span>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55 }}>The Flywheel</span>
        </div>
        <_Rev2>
          <h2 style={{ fontSize: 96, lineHeight: 0.92, fontWeight: 700, letterSpacing: -3.5, margin: "0 0 48px" }}>
            A loop, <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, color: ACC }}>not</span> a prompt.
          </h2>
        </_Rev2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", borderTop: `1px solid ${INK}`, borderBottom: `1px solid ${INK}` }}>
          {[
            { n: "i", k: "Write", t: "本文を書く" },
            { n: "ii", k: "Chat", t: "AI と話す" },
            { n: "iii", k: "Extract", t: "Codex に抽出" },
            { n: "iv", k: "Reference", t: "次に効く" },
          ].map((s, i) => (
            <div key={s.n} style={{ borderRight: i < 3 ? `1px solid ${RULE}` : "none", padding: "28px 22px", minHeight: 180 }}>
              <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 24, color: ACC }}>{s.n}.</div>
              <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: -0.5, marginTop: 6 }}>{s.k}</div>
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 4 }}>{s.t}</div>
            </div>
          ))}
        </div>
      </section>

      {/* USE CASES */}
      <section style={{ padding: "80px 56px", color: INK, borderTop: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginBottom: 32 }}>
          <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 64, color: ACC, lineHeight: 0.9, fontWeight: 400 }}>05.</span>
          <span style={{ fontSize: 11, letterSpacing: 2, textTransform: "uppercase", opacity: 0.55 }}>For the world-makers</span>
        </div>
        <div style={{ borderTop: `1px solid ${INK}` }}>
          {COPY.usecases.map((u, i) => (
            <div key={u.ja} style={{ borderBottom: `1px solid ${RULE}`, display: "grid", gridTemplateColumns: "80px 240px 1fr", gap: 36, padding: "22px 0", alignItems: "baseline" }}>
              <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 22, color: ACC }}>{String.fromCharCode(0x2160 + i)}</div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{u.ja}</div>
                <div style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 13, opacity: 0.6 }}>{u.en}</div>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6 }}>{u.desc_ja}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section style={{ padding: "120px 56px", textAlign: "center", color: INK, borderTop: `1px solid ${INK}` }}>
        <p style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontSize: 28, marginBottom: 0, opacity: 0.6 }}>So,</p>
        <h2 style={{ fontSize: 200, lineHeight: 0.86, fontWeight: 700, letterSpacing: -7, margin: "8px 0 28px" }}>
          Write <span style={{ fontFamily: "'Instrument Serif', serif", fontStyle: "italic", fontWeight: 400, color: ACC }}>differently.</span>
        </h2>
        <p style={{ fontSize: 16, opacity: 0.7, marginBottom: 36 }}>Local-first · Bring your own AI key.</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {["macOS .dmg", "Windows .msi", "Linux .AppImage"].map((p) => (
            <button key={p} style={{ background: INK, color: BG, border: 0, padding: "18px 26px", fontSize: 14, fontWeight: 600, cursor: "pointer", borderRadius: 99 }}>
              ↓ {p}
            </button>
          ))}
        </div>
      </section>
    </LPFrame>
  );
}
window.LPVariantE = LPVariantE;

/* ============================================================
   F · SOFT MODERN — quiet ground, generous spacing, single accent
   ============================================================ */
function LPVariantF() {
  const BG = "#fafafa";
  const INK = "#0e0d12";
  const RULE = "rgba(14,13,18,0.08)";
  const ACC = "#534AB7";

  return (
    <LPFrame bg={BG} fontFamily="'Inter Tight', 'Inter', system-ui, sans-serif">
      <style>{`
        .f-glow {
          background: radial-gradient(ellipse 60% 70% at 70% 30%, rgba(83,74,183,0.12), transparent 60%),
                      radial-gradient(ellipse 80% 50% at 10% 80%, rgba(255,140,80,0.08), transparent 60%);
        }
      `}</style>

      {/* NAV */}
      <div style={{ position: "sticky", top: 0, zIndex: 30, background: "rgba(250,250,250,0.85)", backdropFilter: "blur(12px)", borderBottom: `1px solid ${RULE}` }}>
        <div style={{ display: "flex", alignItems: "center", padding: "16px 56px", gap: 28, color: INK }}>
          <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: -0.3 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, background: ACC, borderRadius: 2, marginRight: 8, transform: "translateY(-1px)" }} />
            Grimodex
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 28, fontSize: 13, opacity: 0.7 }}>
            <span>Features</span><span>Loop</span><span>Cases</span><span>Pricing</span><span>FAQ</span>
          </div>
          <button style={{ background: INK, color: BG, border: 0, padding: "10px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer", borderRadius: 8 }}>
            Download
          </button>
        </div>
      </div>

      {/* HERO */}
      <section className="f-glow" style={{ padding: "140px 56px 100px", color: INK, position: "relative" }}>
        <_Rev2>
          <div style={{ display: "inline-block", padding: "6px 14px", border: `1px solid ${RULE}`, borderRadius: 99, fontSize: 12, color: INK, opacity: 0.7, marginBottom: 36, background: BG }}>
            <span style={{ display: "inline-block", width: 6, height: 6, background: "#27c08e", borderRadius: "50%", marginRight: 8, transform: "translateY(-1px)" }} />
            v2.0.10 · A Writing Fidget IDE / ライティング・フィジェット・IDE
          </div>
        </_Rev2>
        <_Rev2 delay={80}>
          <h1 style={{
            margin: 0,
            fontSize: 168,
            lineHeight: 0.86,
            fontWeight: 700,
            letterSpacing: -7,
            maxWidth: 1100,
          }}>
            書いていない時間も、<br />
            <span style={{ background: `linear-gradient(120deg, ${ACC}, #ff6e3c 70%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>
              書いている。
            </span>
          </h1>
        </_Rev2>
        <_Rev2 delay={180}>
          <p style={{ fontSize: 22, lineHeight: 1.45, maxWidth: 720, marginTop: 36, color: INK, opacity: 0.78, fontWeight: 400 }}>
            Codex を整える時間も、Map をぼんやり眺める時間も、AI と雑談する時間も — 全部、次の一行に効く。フィジェットそのものが、原稿を太らせる。
          </p>
          <p style={{ fontSize: 14, opacity: 0.55, marginTop: 14 }}>
            Even when you're not writing, you're writing. The fidget is the work.
          </p>
        </_Rev2>
        <_Rev2 delay={280}>
          <div style={{ display: "flex", gap: 14, marginTop: 44, alignItems: "center", flexWrap: "wrap" }}>
            <button style={{ background: INK, color: BG, border: 0, padding: "16px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer", borderRadius: 12, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ display: "inline-block", width: 8, height: 8, background: BG, borderRadius: 2, opacity: 0.5 }} />
              Download ダウンロード
            </button>
            <button style={{ background: "transparent", color: INK, border: `1px solid ${RULE}`, padding: "16px 24px", fontSize: 15, fontWeight: 500, cursor: "pointer", borderRadius: 12 }}>
              See the loop →
            </button>
            <span style={{ fontSize: 13, opacity: 0.55, marginLeft: 6 }}>macOS · Windows · Linux · Local-first · BYOK</span>
          </div>
        </_Rev2>

        {/* Hero shot — under the type */}
        <div style={{ marginTop: 80, position: "relative" }}>
          <div style={{ position: "absolute", inset: -40, background: "radial-gradient(ellipse 60% 50% at 50% 60%, rgba(83,74,183,0.18), transparent 65%)", filter: "blur(20px)" }} />
          <PanelMock theme="light" accent={ACC} />
        </div>
      </section>

      {/* WORKSPACE — chip rail */}
      <section style={{ padding: "80px 56px", color: INK }}>
        <div style={{ fontSize: 12, opacity: 0.55, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>02 / Workspace</div>
        <_Rev2>
          <h2 style={{ fontSize: 80, lineHeight: 0.95, fontWeight: 700, letterSpacing: -2.5, margin: "0 0 16px" }}>
            A workspace. <span style={{ color: ACC }}>Your arrangement.</span>
          </h2>
        </_Rev2>
        <p style={{ fontSize: 16, opacity: 0.7, maxWidth: 640, lineHeight: 1.6, marginBottom: 32 }}>
          Editor、AI Chat、Codex、Map、Timeline、Beats、Snippets、Foreshadow、Matrix、Scenes、Grid、Linter — Dockview で自由配置。脳の形に合わせる。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {COPY.panels.map((p, i) => (
            <div key={p} style={{
              padding: 18,
              background: i === 3 ? ACC : "#fff",
              color: i === 3 ? "#fff" : INK,
              borderRadius: 14,
              border: `1px solid ${RULE}`,
              fontSize: 14,
              fontWeight: 600,
              boxShadow: "0 1px 2px rgba(0,0,0,0.03)",
            }}>
              <div style={{ fontSize: 10, opacity: 0.55, letterSpacing: 1, marginBottom: 4 }}>0{i + 1}</div>
              {p}
            </div>
          ))}
        </div>
      </section>

      {/* FEATURES — card grid */}
      <section style={{ padding: "80px 56px", color: INK }}>
        <div style={{ fontSize: 12, opacity: 0.55, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>03 / Three moves</div>
        <_Rev2>
          <h2 style={{ fontSize: 80, lineHeight: 0.95, fontWeight: 700, letterSpacing: -2.5, margin: "0 0 48px" }}>
            Three moves that <span style={{ color: ACC }}>compound.</span>
          </h2>
        </_Rev2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 18 }}>
          {COPY.features.slice(0, 3).map((f, i) => (
            <_Rev2 key={f.no} delay={i * 80}>
              <div style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 18, padding: 28, height: "100%", display: "flex", flexDirection: "column", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
                  <div style={{ width: 32, height: 32, borderRadius: 10, background: `${ACC}18`, color: ACC, display: "grid", placeItems: "center", fontSize: 12, fontWeight: 700 }}>
                    {f.no}
                  </div>
                  <div style={{ fontSize: 11, letterSpacing: 1.2, textTransform: "uppercase", opacity: 0.6 }}>{f.kicker_en}</div>
                </div>
                <h3 style={{ fontSize: 28, lineHeight: 1.05, letterSpacing: -1, fontWeight: 700, margin: "0 0 12px" }}>
                  {f.title_ja.map((line, k) => (<span key={k} style={{ display: "block" }}>{line}</span>))}
                </h3>
                <p style={{ fontSize: 14, lineHeight: 1.6, opacity: 0.78, margin: 0 }}>{f.body_ja}</p>
                <div style={{ marginTop: "auto", paddingTop: 16, fontSize: 12, color: ACC, fontWeight: 500 }}>
                  {f.title_en} →
                </div>
              </div>
            </_Rev2>
          ))}
        </div>
      </section>

      {/* LOOP */}
      <section style={{ padding: "80px 56px", color: INK }}>
        <div style={{ fontSize: 12, opacity: 0.55, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>04 / The flywheel</div>
        <_Rev2>
          <h2 style={{ fontSize: 80, lineHeight: 0.95, fontWeight: 700, letterSpacing: -2.5, margin: "0 0 48px" }}>
            A flywheel, <span style={{ color: ACC }}>not</span> a prompt.
          </h2>
        </_Rev2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
          {[
            { n: "01", k: "Write", t: "本文を書く" },
            { n: "02", k: "Chat", t: "AI と話す" },
            { n: "03", k: "Extract", t: "Codex に抽出" },
            { n: "04", k: "Reference", t: "次に効く" },
          ].map((s, i) => (
            <div key={s.n} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 16, padding: 24, position: "relative", minHeight: 180 }}>
              <div style={{ fontSize: 11, color: ACC, letterSpacing: 1, fontWeight: 700, marginBottom: 12 }}>STEP {s.n}</div>
              <div style={{ fontSize: 32, fontWeight: 700, letterSpacing: -0.8 }}>{s.k}</div>
              <div style={{ fontSize: 13, opacity: 0.7, marginTop: 8 }}>{s.t}</div>
              {i < 3 && (
                <div style={{ position: "absolute", right: -10, top: "50%", transform: "translateY(-50%)", width: 22, height: 22, background: BG, borderRadius: "50%", border: `1px solid ${RULE}`, display: "grid", placeItems: "center", fontSize: 12, color: ACC, fontWeight: 700, zIndex: 2 }}>
                  →
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* USE CASES */}
      <section style={{ padding: "80px 56px", color: INK }}>
        <div style={{ fontSize: 12, opacity: 0.55, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 14 }}>05 / For</div>
        <_Rev2>
          <h2 style={{ fontSize: 80, lineHeight: 0.95, fontWeight: 700, letterSpacing: -2.5, margin: "0 0 48px" }}>
            For people who keep <span style={{ color: ACC }}>making worlds.</span>
          </h2>
        </_Rev2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
          {COPY.usecases.map((u, i) => (
            <div key={u.ja} style={{ background: "#fff", border: `1px solid ${RULE}`, borderRadius: 14, padding: 20, minHeight: 220, display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 11, color: ACC, fontWeight: 600, marginBottom: 10 }}>0{i + 1}</div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: -0.4 }}>{u.ja}</div>
              <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 10 }}>{u.en}</div>
              <div style={{ fontSize: 12, lineHeight: 1.55, opacity: 0.78, marginTop: "auto" }}>{u.desc_ja}</div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="f-glow" style={{ padding: "140px 56px", textAlign: "center", color: INK }}>
        <_Rev2>
          <h2 style={{ fontSize: 168, lineHeight: 0.88, fontWeight: 700, letterSpacing: -7, margin: 0 }}>
            Write <span style={{ background: `linear-gradient(120deg, ${ACC}, #ff6e3c)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>differently.</span>
          </h2>
        </_Rev2>
        <p style={{ fontSize: 17, opacity: 0.7, marginTop: 28, marginBottom: 36 }}>Local-first · Bring your own AI key.</p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          {["macOS .dmg", "Windows .msi", "Linux .AppImage"].map((p) => (
            <button key={p} style={{ background: INK, color: BG, border: 0, padding: "18px 28px", fontSize: 15, fontWeight: 600, cursor: "pointer", borderRadius: 12 }}>
              ↓ {p}
            </button>
          ))}
        </div>
      </section>
    </LPFrame>
  );
}
window.LPVariantF = LPVariantF;
