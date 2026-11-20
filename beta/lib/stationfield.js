/* ══════════════════════════════════════════════════════════════
   Field Tools — station entry helper (window.FTSta)
   • Checks and tidies typed stations: "STA 10+50", "1050", "10+5" → "10+50", "10+05"
   • 📍 button that fills station (and offset) from GPS using the project's alignments
   Needs db.js and lib/alignments.js on the page.
   ══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
// "STA 10+50.25", "10+50", "1050.2", "119+00:3" → { v, zone, dec } · empty → null · unreadable → { v: NaN }
function parse(text) {
  let t = String(text ?? '').trim();
  if (!t) return null;
  t = t.replace(/^sta\.?\s*/i, '').replace(/\s+/g, '');
  let zone = '';
  const z = t.match(/:(\d+)$/); if (z) { zone = z[1]; t = t.slice(0, z.index); }
  const neg = t.startsWith('-'); if (neg) t = t.slice(1);
  let v, dec = 0;
  const m = t.match(/^(\d+)\+(\d{1,2})(?:\.(\d+))?$/);
  if (m) { v = +m[1] * 100 + +(m[2] + (m[3] ? '.' + m[3] : '')); dec = m[3] ? m[3].length : 0; }
  else if (/^\d+(\.\d+)?$/.test(t)) { v = parseFloat(t); dec = (t.split('.')[1] || '').length; }
  else return { v: NaN };
  return { v: neg ? -v : v, zone, dec: Math.min(dec, 2) };
}
// 1050.3 → "10+50.3" (handles rounding carry: 1099.96 → "11+00.0")
function fmt(v, dec = 0) {
  if (v == null || !isFinite(v)) return '';
  const neg = v < 0, a = Math.abs(v), p = Math.pow(10, dec);
  const r = Math.round(a * p) / p, st = Math.floor(r / 100 + 1e-9), rem = r - st * 100;
  const remS = rem.toFixed(dec), [ip, dp] = remS.split('.');
  return (neg ? '-' : '') + st + '+' + ip.padStart(2, '0') + (dp ? '.' + dp : '');
}
function normalize(text) {
  const p = parse(text);
  if (p === null) return '';
  if (!isFinite(p.v)) return null;
  return fmt(p.v, p.dec) + (p.zone ? ':' + p.zone : '');
}
// mark a field good/bad
function flag(input, bad) {
  input.style.borderColor = bad ? 'var(--accent-red, #ef4444)' : '';
  let h = input.parentNode.querySelector('.ftsta-msg');
  if (bad) {
    if (!h) { h = document.createElement('div'); h.className = 'ftsta-msg'; h.style.cssText = 'font-size:0.72em;color:var(--accent-red,#ef4444);font-weight:700;margin-top:3px;'; input.parentNode.appendChild(h); }
    h.textContent = 'Not a station — use 10+50 or 1050';
  } else if (h) h.remove();
}
// tidy on leaving the field; fire input/change so the page picks up the normalized text
function check(input) {
  const n = normalize(input.value);
  if (n === null) { flag(input, true); return false; }
  flag(input, false);
  if (n !== input.value) { input.value = n; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }
  return true;
}
// Watch station inputs (now and future) by selector; skip(input) can opt a field out (e.g. mile-marker mode)
function watch(selector, skip) {
  document.addEventListener('focusout', e => {
    const el = e.target;
    if (el && el.matches && el.matches(selector) && !(skip && skip(el))) check(el);
  });
}
// 📍 button: fill station (+ optional offset field) from GPS against the project's alignments
function gpsButton(input, opts) {
  if (!input || input.dataset.ftstaGps) return;
  input.dataset.ftstaGps = '1';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:6px;align-items:stretch;';
  input.parentNode.insertBefore(wrap, input); wrap.appendChild(input); input.style.flex = '1'; input.style.minWidth = '0';
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = '📍'; b.title = 'Fill from my GPS position';
  b.style.cssText = 'flex:0 0 44px;border-radius:9px;border:1.5px solid var(--border-secondary,#d1d5db);background:var(--bg-tertiary,#f9fafb);font-size:1.1em;cursor:pointer;';
  wrap.appendChild(b);
  b.addEventListener('click', () => fill(input, opts, b));
}
function note(input, text, bad) {
  const host = input.parentNode.parentNode;   // the field group around the input + 📍 row
  let h = host.querySelector(':scope > .ftsta-gps');
  if (!h) { h = document.createElement('div'); h.className = 'ftsta-gps'; h.style.cssText = 'font-size:0.72em;font-weight:700;margin-top:3px;'; host.appendChild(h); }
  h.style.color = bad ? 'var(--accent-red,#ef4444)' : 'var(--text-muted,#6b7280)';
  h.textContent = text;
  clearTimeout(h._t); h._t = setTimeout(() => h.remove(), bad ? 6000 : 8000);
}
async function fill(input, opts, btn) {
  const projId = opts.getProjectId && opts.getProjectId();
  if (!projId) return note(input, 'Pick a project first', true);
  if (typeof FTAlign === 'undefined') return note(input, 'Station lookup not available', true);
  if ((await FTAlign.getForProject(projId)).length === 0) return note(input, 'No alignments for this project — upload one in Project Manager', true);
  if (!navigator.geolocation) return note(input, 'GPS not available', true);
  btn.disabled = true; btn.textContent = '⏳';
  navigator.geolocation.getCurrentPosition(async p => {
    btn.disabled = false; btn.textContent = '📍';
    const r = await FTAlign.locate(projId, p.coords.latitude, p.coords.longitude);
    if (!r) return note(input, 'Could not match an alignment', true);
    const far = r.dist * (FTAlign.UNIT_M[r.units] || 0.3048) > 1500;
    if (far) return note(input, 'You are far from this project\'s alignments — check the project setup', true);
    input.value = fmt(r.sta, opts.decimals ?? 1) + (r.zone ? ':' + r.zone : '');
    flag(input, false);
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    if (opts.offsetInput) {
      const u = r.units === 'm' ? ' m' : "'", a = Math.abs(r.off);
      opts.offsetInput.value = a < 0.05 ? '0.0' + u + ' CL' : a.toFixed(1) + u + (r.off > 0 ? ' Rt' : ' Lt');
      opts.offsetInput.dispatchEvent(new Event('input', { bubbles: true })); opts.offsetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const accFt = p.coords.accuracy / (FTAlign.UNIT_M[r.units] || 0.3048);
    note(input, `From GPS ±${Math.round(accFt)} ${r.units === 'm' ? 'm' : 'ft'} · ${r.alignName}${r.inRange ? '' : ' (beyond its ends)'}`);
  }, e => { btn.disabled = false; btn.textContent = '📍'; note(input, e.code === 1 ? 'Location permission denied' : 'No GPS fix — try again', true); },
  { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}
window.FTSta = { parse, fmt, normalize, check, watch, gpsButton };
})();
