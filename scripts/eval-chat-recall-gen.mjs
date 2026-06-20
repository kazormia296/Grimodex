/**
 * chat episodic-recall 較正コーパスの **OpenRouter 拡張ジェネレータ**。
 *
 * seed corpus(src/features/chat/calibration/corpus.json)は手書きで小さい。較正を
 * 硬くするには「実在しそうな小説執筆チャット」の事例を増やす必要があるが、シーン/Codex
 * と違いチャットには元データが無い。そこで LLM(OpenRouter)に schema どおりの事例を
 * 生成させ、corpus.json へ追記する(id は g{n}_ 前置で seed と衝突させない)。
 *
 * 生成後の流れ(較正本体は LLM 不要・ローカル ONNX):
 *   1. OPENROUTER_API_KEY=... node scripts/eval-chat-recall-gen.mjs        # corpus 追記
 *   2. EMBED_RES_DIR=/workspace/src-tauri/resources/semantic node scripts/chatRecallLiveEmbed.mjs
 *   3. pnpm test --run src/features/chat/calibration/chatRecallCalibration.eval.test.ts
 *
 * env:
 *   OPENROUTER_API_KEY (必須) / OPEN_ROUTER_API_KEY も可
 *   OPENROUTER_MODEL  (既定 openai/gpt-4o-mini)
 *   CHAT_GEN_SCENARIOS (各言語の生成シナリオ数。既定 6)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CORPUS = path.join(ROOT, "src/features/chat/calibration/corpus.json");

const KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY;
if (!KEY) {
  console.error(
    "OPENROUTER_API_KEY (or OPEN_ROUTER_API_KEY) is required.\n" +
      "  例: OPENROUTER_API_KEY=sk-... node scripts/eval-chat-recall-gen.mjs",
  );
  process.exit(1);
}
const MODEL = process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini";
const N = Number(process.env.CHAT_GEN_SCENARIOS ?? 6);
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

const LANG_NAME = { ja: "Japanese", en: "English" };

function systemPrompt() {
  return [
    "You generate evaluation data for a NOVEL-WRITING assistant's chat episodic-recall (long-term memory).",
    "The recall system searches a project's PAST chat messages and injects the relevant ones into a new turn.",
    "You output realistic writer↔assistant conversation fragments PLUS queries with ground-truth labels.",
    "Return STRICT JSON only — no prose, no code fences.",
  ].join(" ");
}

function userPrompt(lang, n) {
  return `Generate ${n} independent SCENARIOS for a fantasy/literary novel-writing project, in ${LANG_NAME[lang]}.

Each scenario is a small topic cluster of past chat messages plus one or more queries.

Output JSON shape EXACTLY:
{
  "messages": [
    { "id": "<unique>", "role": "user"|"assistant", "text": "<one chat message>",
      "insertedToEditor": <bool>, "extractedCount": <int 0..3> }
  ],
  "cases": [
    { "id": "<unique>", "query": "<a later question that should recall the substantive messages>",
      "gold": ["<messageId>", ...] }
  ]
}

Rules (critical for label quality — a recall eval is only as good as its SEPARABILITY):
- Each scenario must be about a DISTINCT, CONCRETE topic with UNIQUE invented proper nouns
  (specific character/place/item names, numbers, dates). NEVER use vague writing-craft chatter
  like "themes", "friendship", "courage", "self-discovery", "depth" — those make scenarios
  semantically overlap and ruin the eval. Two scenarios must not share a topic.
- Span varied topics ACROSS scenarios: a magic mechanic, one named character's concrete past,
  a named location's layout, a faction's goal, a specific timeline/event, an object's property,
  a named creature, a political conflict, etc. Make them concrete enough that a reader could
  tell them apart from a single sentence.
- Per scenario: 3-5 messages. Mix roles (user states facts/decisions; assistant proposes
  concrete specifics).
- SIGNAL DISCIPLINE (realistic, sparse): at MOST ONE message per scenario may have
  insertedToEditor=true, and at MOST ONE may have extractedCount=1 (a genuinely recorded
  decision/fact). Most messages have insertedToEditor=false and extractedCount=0. Do NOT
  sprinkle signals broadly.
- Include exactly one PLAIN assistant message per scenario: an on-topic but content-thin
  acknowledgement ("Nice, that works well."). It MUST NOT appear in any gold list.
- One query per scenario, phrased as a writer recalling that concrete topic later; gold = the
  SUBSTANTIVE messages of THAT scenario only (never the plain distractor, never other
  scenarios' messages, never pure-agreement lines).
- Add ${Math.max(2, Math.round(n / 3))} NO-MATCH cases ("gold": []) on topics CLEARLY OUTSIDE
  any fiction project (e.g. Python exceptions, filing taxes, football scores, car maintenance).
  CRITICAL: a no-match case is a QUERY ONLY. Do NOT add ANY message about the no-match topic —
  the topic must be ENTIRELY ABSENT from the "messages" pool (otherwise the query correctly
  matches it and the gold=[] label is wrong). No-match topics appear ONLY as queries.
- Every id globally unique. Messages 1-3 sentences, natural ${LANG_NAME[lang]}.

Return ONLY the JSON object.`;
}

async function callLLM(messages) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kazormia296/Grimodex",
      "X-Title": "Grimodex chat-recall corpus gen",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.7,
      max_tokens: 8192,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function parseLoose(content) {
  // response_format=json_object でも保険で fence/前後ノイズを剥がす。
  const s = content.indexOf("{");
  const e = content.lastIndexOf("}");
  if (s < 0 || e < 0) throw new Error("no JSON object in LLM output");
  return JSON.parse(content.slice(s, e + 1));
}

function validateScenario(obj) {
  if (!Array.isArray(obj.messages) || !Array.isArray(obj.cases))
    throw new Error("missing messages/cases arrays");
  const ids = new Set(obj.messages.map((m) => m.id));
  for (const m of obj.messages) {
    if (!m.id || !["user", "assistant"].includes(m.role) || !m.text?.trim())
      throw new Error(`bad message ${JSON.stringify(m)}`);
    m.insertedToEditor = Boolean(m.insertedToEditor);
    m.extractedCount = Math.max(0, Math.min(3, Number(m.extractedCount) || 0));
  }
  for (const c of obj.cases) {
    if (!c.id || typeof c.query !== "string" || !Array.isArray(c.gold))
      throw new Error(`bad case ${JSON.stringify(c)}`);
    for (const g of c.gold)
      if (!ids.has(g)) throw new Error(`case ${c.id} gold ${g} not in messages`);
  }
  return obj;
}

const corpus = JSON.parse(fs.readFileSync(CORPUS, "utf8"));

for (const lang of ["ja", "en"]) {
  console.log(`[${lang}] generating ${N} scenarios via ${MODEL} …`);
  const content = await callLLM([
    { role: "system", content: systemPrompt() },
    { role: "user", content: userPrompt(lang, N) },
  ]);
  const gen = validateScenario(parseLoose(content));

  // id を g{n}_ 前置して seed と衝突回避。gold 参照も付け替える。
  const existing = new Set(corpus[lang].messages.map((m) => m.id));
  const remap = new Map();
  let k = 0;
  for (const m of gen.messages) {
    let nid = `g_${lang}_${k++}`;
    while (existing.has(nid)) nid = `g_${lang}_${k++}`;
    remap.set(m.id, nid);
    existing.add(nid);
    corpus[lang].messages.push({ ...m, id: nid });
  }
  let ci = corpus[lang].cases.length;
  for (const c of gen.cases) {
    corpus[lang].cases.push({
      id: `gq_${lang}_${ci++}`,
      query: c.query,
      gold: c.gold.map((g) => remap.get(g)).filter(Boolean),
    });
  }
  console.log(
    `[${lang}] +${gen.messages.length} messages, +${gen.cases.length} cases`,
  );
}

fs.writeFileSync(CORPUS, JSON.stringify(corpus, null, 2) + "\n");
console.log(
  `wrote ${CORPUS} (ja: ${corpus.ja.messages.length} msg / ${corpus.ja.cases.length} cases, en: ${corpus.en.messages.length} msg / ${corpus.en.cases.length} cases)`,
);
console.log(
  "next: re-embed (chatRecallLiveEmbed.mjs) then re-run chatRecallCalibration.eval",
);
