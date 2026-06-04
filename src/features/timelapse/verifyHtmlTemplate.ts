/**
 * Standalone HTML chain verifier — bundled into the zip export so the
 * recipient does not need this app to re-check chain continuity.
 *
 * Important honesty notes (also surfaced in the page itself):
 * - This checks that the **log** wasn't retroactively edited.
 * - It does NOT prove any text was human-written. A user could keep typing
 *   AI-generated prose by hand and the chain would still verify.
 *
 * Distribution format (matches src/features/timelapse/zipExport.ts):
 *   /authorship-report.html
 *   /authorship-report.json
 *   /chain.json             ← array of { sequence, prevHash, hash, domain,
 *                             opType, entityId, timestamp, payload }
 *   /verify.html            ← this file
 *
 * The page lets the user drop the entire zip OR a chain.json file directly.
 * Recomputation runs in the browser via Web Crypto (`subtle.digest`).
 */

export const VERIFY_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Authorship chain verifier</title>
<style>
:root { color-scheme: light dark; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Noto Sans JP", sans-serif; margin: 2rem auto; max-width: 760px; padding: 0 1rem; line-height: 1.5; }
h1 { font-size: 1.3rem; margin-bottom: 0.4rem; }
.subtitle { color: #666; font-size: 0.85rem; margin-bottom: 1.5rem; }
.drop { border: 2px dashed #ccc; border-radius: 12px; padding: 2rem 1rem; text-align: center; color: #666; }
.drop.hover { background: rgba(0,127,255,0.06); border-color: #59f; color: #444; }
.result { margin-top: 1.5rem; padding: 1rem; border-radius: 8px; font-size: 0.95rem; }
.result.ok { background: rgba(0,180,0,0.1); color: #036; }
.result.bad { background: rgba(255,0,0,0.08); color: #a20; }
.muted { color: #666; font-size: 0.8rem; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; }
footer { margin-top: 2.5rem; padding-top: 1rem; border-top: 1px solid #eee; color: #888; font-size: 0.75rem; }
@media (prefers-color-scheme: dark) {
  body { background: #111; color: #ddd; }
  .drop { border-color: #444; color: #aaa; }
  .drop.hover { background: rgba(80,127,255,0.12); border-color: #79f; color: #ddd; }
  .result.ok { background: rgba(0,180,0,0.15); color: #afd; }
  .result.bad { background: rgba(255,80,80,0.15); color: #fbb; }
  footer { border-top-color: #222; color: #999; }
}
</style>
</head>
<body>
<h1>Authorship chain verifier</h1>
<p class="subtitle">Re-computes the sha256 hash chain to check that the log itself has not been retroactively edited.</p>

<div id="drop" class="drop">Drop the exported zip — or <code>chain.json</code> — here.<br/><span class="muted">Files never leave your browser.</span></div>
<input id="file" type="file" accept=".zip,application/zip,.json" style="display:none"/>

<div id="result"></div>

<footer>
A clean result means the log is internally consistent — it does <strong>not</strong> prove
any text was written by a human. Anyone with this app can keep producing chain-valid events
of any content. Treat it as a self-disclosure record, not a proof of authorship.
</footer>

<script>
const drop = document.getElementById('drop');
const result = document.getElementById('result');
const fileInput = document.getElementById('file');

['dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('hover'); }));
['dragleave','drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('hover')));
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (f) handleFile(f);
});

async function handleFile(file) {
  result.innerHTML = '<p class="muted">Reading ' + escapeHtml(file.name) + ' &hellip;</p>';
  try {
    let chainJsonText = '';
    if (file.name.toLowerCase().endsWith('.json')) {
      chainJsonText = await file.text();
    } else {
      const buf = new Uint8Array(await file.arrayBuffer());
      chainJsonText = await extractFromZip(buf, 'chain.json');
    }
    const chain = JSON.parse(chainJsonText);
    if (!Array.isArray(chain)) throw new Error('chain.json must be an array');
    const v = await verifyChain(chain);
    if (v.ok) {
      result.innerHTML = '<div class="result ok"><strong>Chain OK.</strong><br/>' + escapeHtml(String(chain.length)) + ' events verified end-to-end.</div>';
    } else {
      result.innerHTML = '<div class="result bad"><strong>Chain broken at sequence ' + escapeHtml(String(v.brokenAt)) + '.</strong><br/>' + escapeHtml(v.reason || '') + '</div>';
    }
  } catch (e) {
    result.innerHTML = '<div class="result bad"><strong>Could not read file.</strong><br/>' + escapeHtml(String(e.message || e)) + '</div>';
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substring(i*2, i*2+2), 16);
  return out;
}
function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += b[i].toString(16).padStart(2,'0');
  return s;
}
async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(d);
}
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function verifyChain(events) {
  let prev = null;
  for (const ev of events) {
    const evPrev = hexToBytes(ev.prevHash);
    if (prev && !bytesEqual(prev, evPrev)) {
      return { ok: false, brokenAt: ev.sequence, reason: 'prevHash mismatch' };
    }
    const canon = {
      projectId: ev.projectId,
      sceneId: ev.sceneId ?? null,
      domain: ev.domain,
      opType: ev.opType,
      entityType: ev.entityType ?? null,
      entityId: ev.entityId ?? null,
      payload: ev.payload,
      sessionId: ev.sessionId,
      sequence: ev.sequence,
      timestamp: ev.timestamp,
      prevHash: ev.prevHash,
    };
    const computed = await sha256(new TextEncoder().encode(JSON.stringify(canon)));
    const stored = hexToBytes(ev.hash);
    if (!bytesEqual(computed, stored)) {
      return { ok: false, brokenAt: ev.sequence, reason: 'hash mismatch' };
    }
    prev = stored;
  }
  return { ok: true };
}

// Minimal store-only (uncompressed) ZIP extractor — sufficient for our zip
// (fflate's zipSync with level 0 produces store entries).
async function extractFromZip(bytes, filename) {
  let i = 0;
  while (i < bytes.length - 4) {
    const sig = (bytes[i] | (bytes[i+1] << 8) | (bytes[i+2] << 16) | (bytes[i+3] << 24)) >>> 0;
    if (sig === 0x04034b50) {
      const method = bytes[i+8] | (bytes[i+9] << 8);
      const compSize = (bytes[i+18] | (bytes[i+19] << 8) | (bytes[i+20] << 16) | (bytes[i+21] << 24)) >>> 0;
      const uncompSize = (bytes[i+22] | (bytes[i+23] << 8) | (bytes[i+24] << 16) | (bytes[i+25] << 24)) >>> 0;
      const nameLen = bytes[i+26] | (bytes[i+27] << 8);
      const extraLen = bytes[i+28] | (bytes[i+29] << 8);
      const name = new TextDecoder().decode(bytes.subarray(i+30, i+30+nameLen));
      const dataStart = i + 30 + nameLen + extraLen;
      if (name === filename) {
        if (method !== 0) throw new Error('zip entry "' + filename + '" is compressed (method ' + method + '); please supply chain.json directly');
        return new TextDecoder().decode(bytes.subarray(dataStart, dataStart + uncompSize));
      }
      i = dataStart + compSize;
    } else {
      i += 1;
    }
  }
  throw new Error(filename + ' not found in zip');
}
</script>
</body>
</html>
`;
