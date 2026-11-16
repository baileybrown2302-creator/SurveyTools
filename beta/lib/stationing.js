/* ══════════════════════════════════════════════════════════════
   Field Tools — shared stationing core
   Used by stationing.html (Station / Offset) and alignment_photo.html (Station Photos).
   LandXML alignments, NAD83 state plane projection, live station/offset
   from phone GPS, compass heading, per-project setup.
   Requires db.js + lib/alignments.js (ftGetSetting / ftSetSetting / ftGetAllProjects / ftProjectTitle).
   Each page defines optional hooks: onStationUpdate(), onProjectChange().
   ══════════════════════════════════════════════════════════════ */
'use strict';

// ───────── utils ─────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const fmtNum = (v, d = 1) => (v == null || !isFinite(v)) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
let _toastTimer;
function toast(msg, ms = 2200) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(_toastTimer); _toastTimer = setTimeout(() => t.classList.remove('show'), ms); }
function busy(on, msg = 'Working…') { $('busy').textContent = msg; $('busy').classList.toggle('hidden', !on); }
function hook(name, ...a) { if (typeof window[name] === 'function') return window[name](...a); }

// Inject shared overlay / toast / busy markup
(function chrome() {
  const html = `<div id="overlay" class="overlay hidden"><div class="sheet" id="sheet"></div></div>
  <div id="busy" class="busy hidden">Working…</div><div class="toast" id="toast"></div>`;
  const add = () => { if (!$('overlay')) document.body.insertAdjacentHTML('beforeend', html); $('overlay').addEventListener('click', e => { if (e.target === $('overlay')) closeSheet(); }); };
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
function openSheet(html, z = 200) { $('sheet').innerHTML = html; $('overlay').style.zIndex = z; $('overlay').classList.remove('hidden'); }
function closeSheet() { $('overlay').classList.add('hidden'); $('sheet').innerHTML = ''; }

// Alignment storage + LandXML parsing live in lib/alignments.js (also used by Project Manager)
const { apDB, apGetAll, apGet, apPut, apDel, parseLandXML, buildPolyline, displaySta, fmtSta } = FTAlign;

// ───────── settings: global (G) + per project (PS()) ─────────
const G_DEFAULTS = { projId: '', decl: 12.4, stampNE: false, stampLL: false, stampHdg: true, planWidth: 300, compass: false };
const P_DEFAULTS = { zone: 'NV_W', units: 'usft', cf: 1, baseN: 0, baseE: 0, shiftN: 0, shiftE: 0, lockId: '', target: null,
  custom: { lat0: 34.75, lon0: -118.5833333333, k0: 0.9999, lat1: 0, lat2: 0, fe: 800000, fn: 4000000 } };
let G = { ...G_DEFAULTS }, PSET = {};
async function loadSettings() {
  const s = await ftGetSetting('ftStationing', null);
  if (s) { G = Object.assign({ ...G_DEFAULTS }, s.g); PSET = s.p || {}; return; }
  const old = await ftGetSetting('stationPhotos', null); // migrate first beta
  if (old) { ['decl', 'stampNE', 'stampLL', 'stampHdg', 'planWidth'].forEach(k => { if (k in old) G[k] = old[k]; }); G.projId = old.projId || '';
    PSET.__legacy = {}; Object.keys(P_DEFAULTS).forEach(k => { if (k in old) PSET.__legacy[k] = old[k]; }); }
}
function saveSettings() { ftSetSetting('ftStationing', { g: G, p: PSET }); }
function PS() {
  const id = G.projId || '__none';
  if (!PSET[id]) { PSET[id] = {}; if (PSET.__legacy) { Object.assign(PSET[id], PSET.__legacy); delete PSET.__legacy; } }
  const ps = PSET[id];
  // fill any missing keys (Project Manager uploads may store only units/zone)
  for (const [k, v] of Object.entries(P_DEFAULTS)) if (!(k in ps)) ps[k] = JSON.parse(JSON.stringify(v));
  ps.custom = Object.assign(JSON.parse(JSON.stringify(P_DEFAULTS.custom)), ps.custom);
  return ps;
}

// ═════════ PROJECTS ═════════
let projects = [];
async function loadProjects() {
  try { projects = (await ftGetAllProjects()).filter(p => !p.archived); } catch (e) { projects = []; }
  projects.sort((a, b) => ftProjectTitle(a).localeCompare(ftProjectTitle(b), undefined, { numeric: true }));
  if (G.projId && !projects.find(p => p.id === G.projId)) G.projId = '';
  if (!G.projId && projects.length === 1) { G.projId = projects[0].id; saveSettings(); }
}
const projectTitle = () => { const p = projects.find(x => x.id === G.projId); return p ? ftProjectTitle(p) : ''; };
function renderProjectBar() {
  const el = $('projBar'); if (!el) return;
  el.innerHTML = `<span>📁</span><select id="projSelect">
    <option value="">${projects.length ? '— Select a project —' : '— No projects yet —'}</option>
    ${projects.map(p => `<option value="${esc(p.id)}" ${p.id === G.projId ? 'selected' : ''}>${esc(ftProjectTitle(p))}</option>`).join('')}
    <option value="__new">＋ New project…</option></select>`;
  $('projSelect').onchange = async e => {
    const v = e.target.value;
    if (v === '__new') { location.href = 'project_manager.html'; return; }
    G.projId = v; saveSettings(); await switchProject();
  };
}
async function switchProject() {
  autoId = null; hx = hy = null;
  await claimOrphans(); await loadAligns();
  if (fix) pos = projectLL(fix.lat, fix.lon);
  computeAll(); renderSetupPanel(); hook('onProjectChange'); notify();
}
// Records from before projects existed get adopted by the first project selected.
async function claimOrphans() {
  if (!G.projId) return;
  for (const a of await apGetAll('alignments')) if (!a.projId) { a.projId = G.projId; await apPut('alignments', a); }
  for (const p of await apGetAll('photos')) if (!p.projId) { p.projId = G.projId; await apPut('photos', p); }
}

// ═════════ PROJECTIONS (GRS80 / NAD83) ═════════
const ELL = { a: 6378137, f: 1 / 298.257222101 };
ELL.e2 = ELL.f * (2 - ELL.f); ELL.e = Math.sqrt(ELL.e2); ELL.ep2 = ELL.e2 / (1 - ELL.e2);
const ZONES = {
  NV_E: { lat0: 34.75, lon0: -115.5833333333, k0: 0.9999, fe: 200000, fn: 8000000 },
  NV_C: { lat0: 34.75, lon0: -116.6666666667, k0: 0.9999, fe: 500000, fn: 6000000 },
  NV_W: { lat0: 34.75, lon0: -118.5833333333, k0: 0.9999, fe: 800000, fn: 4000000 },
};
function meridionalArc(phi) {
  const e2 = ELL.e2, e4 = e2 * e2, e6 = e4 * e2;
  return ELL.a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * e2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi)
    + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
}
function tmForward(latDeg, lonDeg, p) {
  const phi = latDeg * D2R, lam = lonDeg * D2R, lam0 = p.lon0 * D2R;
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = ELL.a / Math.sqrt(1 - ELL.e2 * sin * sin);
  const T = tan * tan, C = ELL.ep2 * cos * cos, A = (lam - lam0) * cos;
  const M = meridionalArc(phi), M0 = meridionalArc(p.lat0 * D2R);
  const x = p.k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ELL.ep2) * A ** 5 / 120);
  const y = p.k0 * (M - M0 + N * tan * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ELL.ep2) * A ** 6 / 720));
  return { E: x + p.fe, N: y + p.fn };
}
function lccForward(latDeg, lonDeg, p) {
  const e = ELL.e;
  const m = f => Math.cos(f) / Math.sqrt(1 - ELL.e2 * Math.sin(f) ** 2);
  const t = f => Math.tan(Math.PI / 4 - f / 2) / Math.pow((1 - e * Math.sin(f)) / (1 + e * Math.sin(f)), e / 2);
  const p1 = p.lat1 * D2R, p2 = p.lat2 * D2R, p0 = p.lat0 * D2R;
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1) : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * Math.pow(t(p1), n));
  const rho = ELL.a * F * Math.pow(t(latDeg * D2R), n), rho0 = ELL.a * F * Math.pow(t(p0), n);
  const th = n * (lonDeg - p.lon0) * D2R;
  return { E: p.fe + rho * Math.sin(th), N: p.fn + rho0 - rho * Math.cos(th) };
}
const UNIT_M = { usft: 1200 / 3937, ift: 0.3048, m: 1 };
const UNIT_LBL = { usft: 'ft', ift: 'ft', m: 'm' };
const uLbl = () => UNIT_LBL[PS().units];
// lat/lon → project N/E (grid → ground → check-in shift), project units
function projectLL(lat, lon) {
  const ps = PS();
  const g = (ps.zone === 'TM') ? tmForward(lat, lon, ps.custom) : (ps.zone === 'LCC') ? lccForward(lat, lon, ps.custom) : tmForward(lat, lon, ZONES[ps.zone]);
  const u = UNIT_M[ps.units], cf = +ps.cf || 1;
  let N = g.N / u, E = g.E / u;
  N = ps.baseN + (N - ps.baseN) / cf; E = ps.baseE + (E - ps.baseE) / cf;
  return { N: N + (+ps.shiftN || 0), E: E + (+ps.shiftE || 0) };
}
// Grid azimuth of true north at a location (degrees). trueAz = gridAz − this.
function gridNorthOffset(lat, lon) {
  const a = projectLL(lat, lon), b = projectLL(lat + 0.001, lon);
  return Math.atan2(b.E - a.E, b.N - a.N) * R2D;
}

function internalSta(al, display) {
  const eqs = al.eqs || [], ss = al.poly.ss;
  const regions = [{ from: -Infinity, to: eqs.length ? eqs[0].internal : Infinity, map: d => d }];
  eqs.forEach((q, i) => regions.push({ from: q.internal, to: i + 1 < eqs.length ? eqs[i + 1].internal : Infinity, map: d => q.internal + (d - q.ahead) }));
  for (const r of regions) { const s = r.map(display); if (s >= r.from - 1e-6 && s <= r.to + 1e-6 && s >= ss[0] - 1e-6 && s <= ss[ss.length - 1] + 1e-6) return s; }
  for (const r of regions) { const s = r.map(display); if (s >= r.from - 1e-6 && s <= r.to + 1e-6) return s; }
  return display;
}
function fmtOff(off, units) {
  if (off == null || !isFinite(off)) return '—';
  const u = units === 'm' ? ' m' : "'";
  if (Math.abs(off) < 0.05) return '0.0' + u + ' CL';
  return Math.abs(off).toFixed(1) + u + (off > 0 ? ' RT' : ' LT');
}
function parseSta(t, units) {
  t = String(t).trim().replace(/^sta\.?\s*/i, ''); if (!t) return NaN;
  const neg = t.startsWith('-'); if (neg) t = t.slice(1);
  const m = t.match(/^(\d+)\+(\d+(?:\.\d*)?)$/);
  const v = m ? +m[1] * (units === 'm' ? 1000 : 100) + +m[2] : parseFloat(t);
  return neg ? -v : v;
}
// Point onto polyline → {sta internal, off (+right), dist, inRange}
function stationOffset(poly, px, py) {
  const { xs, ys, ss } = poly, n = xs.length;
  let best = null, bestD2 = Infinity;
  for (let i = 0; i < n - 1; i++) {
    const ax = xs[i], ay = ys[i], dx = xs[i + 1] - ax, dy = ys[i + 1] - ay, L2 = dx * dx + dy * dy;
    if (L2 === 0) continue;
    const t = ((px - ax) * dx + (py - ay) * dy) / L2, tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const d2 = (px - ax - tc * dx) ** 2 + (py - ay - tc * dy) ** 2;
    if (d2 < bestD2 - 1e-9) { bestD2 = d2; best = { i, t, tc }; }
  }
  if (!best) return null;
  const { i } = best, ax = xs[i], ay = ys[i], dx = xs[i + 1] - ax, dy = ys[i + 1] - ay, L = Math.hypot(dx, dy);
  let t = best.tc, inRange = true;
  if (i === 0 && best.t < 0) { t = best.t; inRange = false; }
  if (i === n - 2 && best.t > 1) { t = best.t; inRange = false; }
  return { sta: ss[i] + t * (ss[i + 1] - ss[i]), off: -(dx * (py - ay) - dy * (px - ax)) / L, dist: Math.sqrt(bestD2), inRange };
}
// Point at internal station + offset (+right)
function pointAt(poly, sta, off) {
  const { xs, ys, ss } = poly, n = xs.length;
  let i;
  if (sta <= ss[0]) i = 0; else if (sta >= ss[n - 1]) i = n - 2;
  else { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ss[m] <= sta) lo = m; else hi = m; } i = lo; }
  const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], L = Math.hypot(dx, dy), ds = ss[i + 1] - ss[i];
  const t = ds ? (sta - ss[i]) / ds : 0;
  return { x: xs[i] + t * dx + off * dy / L, y: ys[i] + t * dy - off * dx / L };
}

// ═════════ LIVE STATE ═════════
let aligns = [], fix = null, pos = null, heading = null, gpsCourse = null, results = [], current = null, autoId = null;
const unitsOf = al => (al && al.units) || PS().units;
async function loadAligns() {
  const rows = G.projId ? (await apGetAll('alignments')).filter(r => r.projId === G.projId) : [];
  aligns = rows.map(r => ({ ...r, poly: buildPolyline(r, r.units || PS().units) }));
  aligns.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (PS().lockId && !aligns.find(a => a.id === PS().lockId)) { PS().lockId = ''; saveSettings(); }
}
function computeAll() {
  results = []; current = null;
  if (!pos) return;
  for (const al of aligns) { if (al.visible === false) continue; const r = stationOffset(al.poly, pos.E, pos.N); if (r) results.push({ al, r }); }
  if (!results.length) return;
  const locked = PS().lockId && results.find(x => x.al.id === PS().lockId);
  if (locked) { current = locked; return; }
  const score = x => x.r.inRange ? x.r.dist : x.r.dist + 1e6;
  let best = results.reduce((a, b) => score(b) < score(a) ? b : a);
  const prev = autoId && results.find(x => x.al.id === autoId);
  if (prev && prev !== best && score(prev) - score(best) < 2) best = prev;
  autoId = best.al.id; current = best;
}
let _notifyPending = false;
function notify() { if (_notifyPending) return; _notifyPending = true; requestAnimationFrame(() => { _notifyPending = false; renderChips(); hook('onStationUpdate'); }); }

// ═════════ GPS ═════════
function startGPS() {
  if (!('geolocation' in navigator)) { const c = $('gpsChip'); if (c) { c.textContent = 'GPS not available'; c.className = 'chip bad'; } return; }
  navigator.geolocation.watchPosition(p => {
    fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, time: p.timestamp };
    gpsCourse = (p.coords.speed != null && p.coords.speed > 0.7 && p.coords.heading != null && !isNaN(p.coords.heading)) ? p.coords.heading : null;
    pos = projectLL(fix.lat, fix.lon);
    computeAll(); notify();
  }, err => { const c = $('gpsChip'); if (c) { c.textContent = err.code === 1 ? 'GPS: permission denied' : 'GPS: ' + (err.message || 'error'); c.className = 'chip bad'; } },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

// ═════════ COMPASS ═════════
let compassOn = false, hx = null, hy = null, lastHeadingAt = 0;
function headingFromEuler(alpha, beta, gamma) {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  let e = -(ca * sg + sa * sb * cg), n = ca * sb * cg - sa * sg;      // back camera (device −Z)
  if (Math.hypot(e, n) < 0.5) { e = -sa * cb; n = ca * cb; }         // phone near flat → top edge
  return (Math.atan2(e, n) * R2D + 360) % 360;
}
function feedHeading(mag) {
  const tru = (mag + (+G.decl || 0) + 360) % 360, x = Math.sin(tru * D2R), y = Math.cos(tru * D2R);
  if (hx == null) { hx = x; hy = y; } else { hx = hx * 0.75 + x * 0.25; hy = hy * 0.75 + y * 0.25; }
  heading = (Math.atan2(hx, hy) * R2D + 360) % 360; lastHeadingAt = Date.now(); notify();
}
const onOrientIOS = e => { if (e.webkitCompassHeading != null && e.webkitCompassHeading >= 0) feedHeading(e.webkitCompassHeading); };
const onOrientAbs = e => { if (e.alpha != null && e.beta != null) feedHeading(headingFromEuler(e.alpha, e.beta, e.gamma || 0)); };
const needsCompassTap = () => typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
async function enableCompass() {
  if (compassOn) return;
  try {
    if (needsCompassTap()) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { toast('Compass permission denied'); return; }
      window.addEventListener('deviceorientation', onOrientIOS);
    } else if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrientAbs);
    else window.addEventListener('deviceorientation', e => { if (e.absolute) onOrientAbs(e); else onOrientIOS(e); });
    compassOn = true; G.compass = true; saveSettings();
    setTimeout(() => { if (!lastHeadingAt) toast('No compass data from this device'); notify(); }, 2500);
    notify();
  } catch (err) { toast('Compass unavailable: ' + err.message); }
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const fmtHdg = h => h == null ? '—' : DIRS[Math.round(h / 45) % 8] + ' ' + Math.round(h) + '°';
const headingNow = () => (heading != null && Date.now() - lastHeadingAt < 5000) ? heading : null;

function renderChips() {
  const gc = $('gpsChip');
  if (gc && fix) { gc.textContent = `GPS ±${Math.round(fix.acc / UNIT_M[PS().units])} ${uLbl()}`; gc.className = 'chip ' + (fix.acc <= 10 ? 'ok' : fix.acc > 30 ? 'bad' : ''); }
  const cc = $('compassChip');
  if (cc) {
    if (compassOn) { cc.textContent = '🧭 ' + (headingNow() != null ? fmtHdg(headingNow()) : 'no data'); cc.className = 'chip ' + (headingNow() != null ? 'ok' : ''); }
    cc.onclick = () => enableCompass();
  }
}

// ═════════ PLAN VIEW ═════════
function zoomPlan(f) { G.planWidth = Math.min(20000, Math.max(40, G.planWidth * f)); saveSettings(); notify(); }
function drawPlan(cv, opts = {}) {
  if (!cv || !cv.offsetParent) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (!W) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  const lineCol = css.getPropertyValue('--plan-line').trim(), txtCol = css.getPropertyValue('--text-muted').trim(), accent = css.getPropertyValue('--accent-blue').trim();
  const tgt = opts.target;
  let cx, cy;
  if (pos) { cx = pos.E; cy = pos.N; }
  else if (tgt) { cx = tgt.x; cy = tgt.y; }
  else if (aligns.length) { const b = aligns[0].poly.bbox; cx = (b[0] + b[2]) / 2; cy = (b[1] + b[3]) / 2; }
  else { ctx.fillStyle = txtCol; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('No alignments loaded', W / 2, H / 2); return; }
  let width = G.planWidth;
  if (tgt && pos && opts.fitTarget) width = Math.max(width, Math.hypot(tgt.x - pos.E, tgt.y - pos.N) * 2.6);
  const sc = W / width, tx = x => W / 2 + (x - cx) * sc, ty = y => H / 2 - (y - cy) * sc, half = width * 0.75;
  const curAl = opts.highlight || (current && current.al);
  for (const al of aligns) {
    if (al.visible === false) continue;
    const b = al.poly.bbox; if (b[2] < cx - half || b[0] > cx + half || b[3] < cy - half || b[1] > cy + half) continue;
    const isCur = curAl === al, { xs, ys, ss } = al.poly;
    ctx.strokeStyle = isCur ? accent : lineCol; ctx.lineWidth = isCur ? 3 : 1.5;
    ctx.beginPath(); for (let i = 0; i < xs.length; i++) { const X = tx(xs[i]), Y = ty(ys[i]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); } ctx.stroke();
    if (isCur) {
      const u = unitsOf(al), per = width > 3000 ? (u === 'm' ? 1000 : 1000) : 100;
      ctx.fillStyle = accent; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'left';
      for (let i = 0; i < xs.length - 1; i++) {
        const d0 = displaySta(al, ss[i]), d1 = displaySta(al, ss[i + 1]);
        if (d1 - d0 > per * 50) continue;
        for (let k = Math.ceil(d0 / per) * per; k <= d1; k += per) {
          const t = (k - d0) / ((d1 - d0) || 1), X = tx(xs[i] + t * (xs[i + 1] - xs[i])), Y = ty(ys[i] + t * (ys[i + 1] - ys[i]));
          if (X < -20 || X > W + 20 || Y < -20 || Y > H + 20) continue;
          const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = -dx / L;
          ctx.beginPath(); ctx.moveTo(X - nx * 6, Y - ny * 6); ctx.lineTo(X + nx * 6, Y + ny * 6); ctx.stroke();
          ctx.fillText(fmtSta(k, u).replace(/\.\d+$/, ''), X + 8, Y - 4);
        }
      }
    }
  }
  if (tgt) {
    const X = tx(tgt.x), Y = ty(tgt.y);
    if (pos) { ctx.strokeStyle = '#dc2626'; ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(W / 2, H / 2); ctx.lineTo(X, Y); ctx.stroke(); ctx.setLineDash([]); }
    ctx.strokeStyle = '#dc2626'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(X - 8, Y - 8); ctx.lineTo(X + 8, Y + 8); ctx.moveTo(X + 8, Y - 8); ctx.lineTo(X - 8, Y + 8); ctx.stroke();
  }
  if (pos) {
    const X = W / 2, Y = H / 2;
    if (fix) { const r = fix.acc / UNIT_M[PS().units] * sc; if (r > 4 && r < W) { ctx.fillStyle = 'rgba(59,130,246,0.12)'; ctx.beginPath(); ctx.arc(X, Y, r, 0, 7); ctx.fill(); } }
    const h = headingNow();
    if (h != null) { const a = (h + gridNorthOffset(fix.lat, fix.lon)) * D2R; ctx.fillStyle = 'rgba(59,130,246,0.35)'; ctx.beginPath(); ctx.moveTo(X, Y); ctx.arc(X, Y, 40, a - Math.PI / 2 - 0.35, a - Math.PI / 2 + 0.35); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = '#2563eb'; ctx.strokeStyle = 'white'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(X, Y, 7, 0, 7); ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = txtCol; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'right'; ctx.fillText('Grid N ↑', W - 8, 16);
  ctx.textAlign = 'left'; ctx.fillText(`≈ ${Math.round(width).toLocaleString()} ${uLbl()} across`, 8, H - 8);
}

// ═════════ ALIGNMENT PICKER ═════════
let _pickerCb = null;
function openAlignPicker(cb, curId, z) {
  _pickerCb = cb || null;
  const sel = cb ? curId : (PS().lockId || '');
  const row = (id, label, meta) => `<div class="pick-item ${sel === id ? 'cur' : ''}" onclick="pickAlign('${id}')"><span>${label}</span><span class="pm">${meta}</span></div>`;
  let html = `<div class="sheet-title">Alignment <button class="sheet-close" onclick="closeSheet()">×</button></div>`;
  html += row('', '🎯 Auto — nearest alignment', !cb && current && !PS().lockId ? esc(current.al.name) : '');
  const list = aligns.filter(a => a.visible !== false).map(al => ({ al, r: pos ? stationOffset(al.poly, pos.E, pos.N) : null })).sort((a, b) => (a.r ? a.r.dist : 0) - (b.r ? b.r.dist : 0));
  for (const { al, r } of list) html += row(al.id, esc(al.name), r ? `${fmtSta(displaySta(al, r.sta), unitsOf(al))} · ${fmtOff(r.off, unitsOf(al))}` : '');
  if (!aligns.length) html += '<div class="empty">No alignments loaded for this project.</div>';
  openSheet(html, z || 200);
}
function pickAlign(id) {
  closeSheet();
  if (_pickerCb) { const cb = _pickerCb; _pickerCb = null; cb(id); return; }
  PS().lockId = id; saveSettings(); computeAll(); notify();
  toast(id ? 'Locked to ' + aligns.find(a => a.id === id).name : 'Auto: nearest alignment');
}

// ═════════ SHARED SETUP PANEL ═════════
function renderSetupPanel() {
  const el = $('setupPanel'); if (!el) return;
  if (!G.projId) {
    el.innerHTML = `<div class="card"><div class="card-title">No project selected</div>
      <div class="hint" style="font-size:0.85em;margin-bottom:10px;">Alignments and coordinate settings are saved per project. Pick a project at the top, or create one in Project Manager.</div>
      <a class="btn btn-primary" href="project_manager.html" style="text-decoration:none;">📁 Open Project Manager</a></div>`;
    return;
  }
  const ps = PS(), c = ps.custom;
  el.innerHTML = `
  <div class="card">
    <div class="card-title">Alignments — this project <button class="btn btn-primary btn-sm" onclick="$('xmlInput').click()">＋ Import LandXML</button></div>
    <input type="file" id="xmlInput" accept=".xml,.landxml,text/xml,application/xml" multiple class="hidden">
    <div id="alignList">${aligns.length ? aligns.map(a => { const ss = a.poly.ss, u = unitsOf(a); return `<div class="al-item">
      <input type="checkbox" ${a.visible !== false ? 'checked' : ''} onchange="toggleAlign('${a.id}', this.checked)" style="width:20px;height:20px;">
      <div class="al-info"><div class="al-name">${esc(a.name)}</div>
      <div class="al-meta">${fmtSta(displaySta(a, ss[0]), u)} → ${fmtSta(displaySta(a, ss[ss.length - 1]), u)} · ${a.els.length} el${a.eqs && a.eqs.length ? ' · ' + a.eqs.length + ' eq' : ''} · ${esc(a.file)}</div></div>
      <button class="btn btn-secondary btn-sm" onclick="removeAlign('${a.id}')">✕</button></div>`; }).join('') : '<div class="hint" style="font-size:0.85em;padding:6px 0 10px;">No alignments for this project yet.</div>'}</div>
    <div class="hint">Lines, curves, spirals and station equations. Export from TBC or Civil 3D as LandXML. Uncheck an alignment to hide it.</div>
  </div>
  <div class="card">
    <div class="card-title">Coordinate System — this project</div>
    <div class="field-group"><label class="label">Projection</label>
      <select class="input" id="csZone">
        <option value="NV_W">NAD83 Nevada West (2703)</option><option value="NV_C">NAD83 Nevada Central (2702)</option><option value="NV_E">NAD83 Nevada East (2701)</option>
        <option value="TM">Custom Transverse Mercator</option><option value="LCC">Custom Lambert Conformal (2SP)</option></select></div>
    <div id="customProj" class="${ps.zone === 'TM' || ps.zone === 'LCC' ? '' : 'hidden'}">
      <div class="row2"><div class="field-group"><label class="label">Origin lat (°)</label><input class="input" id="cpLat0" inputmode="decimal" value="${c.lat0}"></div>
        <div class="field-group"><label class="label">Central meridian (°)</label><input class="input" id="cpLon0" inputmode="decimal" value="${c.lon0}"></div></div>
      <div class="row2 ${ps.zone === 'TM' ? '' : 'hidden'}"><div class="field-group"><label class="label">Scale k₀</label><input class="input" id="cpK0" inputmode="decimal" value="${c.k0}"></div><div></div></div>
      <div class="row2 ${ps.zone === 'LCC' ? '' : 'hidden'}"><div class="field-group"><label class="label">Std parallel 1 (°)</label><input class="input" id="cpLat1" inputmode="decimal" value="${c.lat1}"></div>
        <div class="field-group"><label class="label">Std parallel 2 (°)</label><input class="input" id="cpLat2" inputmode="decimal" value="${c.lat2}"></div></div>
      <div class="row2"><div class="field-group"><label class="label">False easting (m)</label><input class="input" id="cpFE" inputmode="decimal" value="${c.fe}"></div>
        <div class="field-group"><label class="label">False northing (m)</label><input class="input" id="cpFN" inputmode="decimal" value="${c.fn}"></div></div>
    </div>
    <div class="field-group"><label class="label">Coordinate units</label>
      <select class="input" id="csUnits"><option value="usft">US survey feet</option><option value="ift">International feet</option><option value="m">Meters</option></select>
      <div class="hint">${new Set(aligns.map(a => a.units)).size > 1 ? '⚠ Files have different units — check your exports.' : aligns.length ? 'Set from the LandXML file.' : 'Set automatically from the LandXML file.'}</div></div>
    <div class="field-group"><label class="label">Combined factor (Ground = Grid ÷ CF)</label>
      <input class="input" id="csCF" inputmode="decimal" placeholder="1.00000000" value="${ps.cf === 1 ? '' : ps.cf}">
      <div class="hint">Leave blank if the alignment is in grid coordinates. For ground (surface) coordinates, enter the project combined factor.</div></div>
    <div class="row2"><div class="field-group"><label class="label">Scale about N</label><input class="input" id="csBaseN" inputmode="decimal" placeholder="0" value="${ps.baseN || ''}"></div>
      <div class="field-group"><label class="label">Scale about E</label><input class="input" id="csBaseE" inputmode="decimal" placeholder="0" value="${ps.baseE || ''}"></div></div>
    <div class="hint" style="margin-top:-6px;margin-bottom:12px;">Base point for the scale. Leave 0,0 unless the project scaled about a specific point.</div>
    <div class="field-group"><label class="label">Check-in shift</label>
      <div class="kv" style="margin-bottom:8px;"><span>ΔN</span><span>${fmtNum(ps.shiftN, 2)}</span><span>ΔE</span><span>${fmtNum(ps.shiftE, 2)}</span></div>
      <div class="btn-row"><button class="btn btn-secondary btn-sm" style="flex:1" onclick="openCalibrate()">📌 Check in on a known point</button><button class="btn btn-secondary btn-sm" onclick="clearShift()">Clear</button></div>
      <div class="hint">Stand on a point you know (control, or a station/offset) and the app shifts GPS to match. Corrects datum, scale and phone GPS bias near that spot.</div></div>
  </div>
  <div class="card">
    <div class="card-title">Compass</div>
    <div class="field-group"><label class="label">Magnetic declination (° East)</label><input class="input" id="decl" inputmode="decimal" value="${G.decl}">
      <div class="hint">Phone compasses read magnetic north. Northern Nevada is about 12–13° E. Applies to all projects.</div></div>
  </div>`;
  $('csZone').value = ps.zone; $('csUnits').value = ps.units;
  $('xmlInput').addEventListener('change', e => { if (e.target.files.length) importLandXML([...e.target.files]); e.target.value = ''; });
  ['csZone', 'csUnits', 'csCF', 'csBaseN', 'csBaseE', 'decl', 'cpLat0', 'cpLon0', 'cpK0', 'cpLat1', 'cpLat2', 'cpFE', 'cpFN'].forEach(id => $(id) && $(id).addEventListener('change', onSetupChange));
}
function onSetupChange() {
  const num = (id, d) => { const v = $(id) ? parseFloat($(id).value) : NaN; return isFinite(v) ? v : d; };
  const ps = PS();
  ps.zone = $('csZone').value; ps.units = $('csUnits').value;
  const cf = num('csCF', 1); ps.cf = cf > 0.9 && cf < 1.1 ? cf : 1;
  ps.baseN = num('csBaseN', 0); ps.baseE = num('csBaseE', 0); G.decl = num('decl', 12.4);
  ps.custom = { lat0: num('cpLat0', ps.custom.lat0), lon0: num('cpLon0', ps.custom.lon0), k0: num('cpK0', ps.custom.k0), lat1: num('cpLat1', ps.custom.lat1), lat2: num('cpLat2', ps.custom.lat2), fe: num('cpFE', ps.custom.fe), fn: num('cpFN', ps.custom.fn) };
  saveSettings(); renderSetupPanel();
  if (fix) pos = projectLL(fix.lat, fix.lon);
  hx = hy = null; computeAll(); notify();
}
async function importLandXML(files) {
  if (!G.projId) return toast('Select a project first');
  let added = 0;
  for (const f of files) {
    try {
      const res = parseLandXML(await f.text(), f.name);
      if (!aligns.length && !added) { if (res.units) PS().units = res.units; if (res.csHint) PS().zone = res.csHint; }
      for (const a of res.alignments) {
        const rec = { id: uid(), projId: G.projId, name: a.name, file: f.name, units: res.units || PS().units, staStart: a.staStart, els: a.els, eqs: a.eqs, visible: true, imported: Date.now() };
        const dup = aligns.find(x => x.name === a.name && x.file === f.name);
        if (dup) { rec.id = dup.id; rec.visible = dup.visible; }
        await apPut('alignments', rec); added++;
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, 4000); }
  }
  saveSettings(); await loadAligns(); renderSetupPanel();
  if (fix) pos = projectLL(fix.lat, fix.lon);
  computeAll(); notify();
  if (added) toast(`Imported ${added} alignment${added > 1 ? 's' : ''}`);
}
async function toggleAlign(id, on) { const a = aligns.find(x => x.id === id); a.visible = on; const { poly, ...rec } = a; await apPut('alignments', rec); computeAll(); notify(); }
async function removeAlign(id) {
  const a = aligns.find(x => x.id === id); if (!confirm(`Remove ${a.name} from this project?`)) return;
  await apDel('alignments', id); await loadAligns(); renderSetupPanel(); computeAll(); notify();
}
// Check-in on a known point
let _calMode = 'ne';
function openCalibrate() {
  if (!fix) return toast('Waiting for GPS…');
  const al = current ? current.al : aligns[0]; _calMode = 'ne';
  openSheet(`
    <div class="sheet-title">Check in on a known point <button class="sheet-close" onclick="closeSheet()">×</button></div>
    <div class="hint" style="font-size:0.85em;margin-bottom:12px;">Stand on the point and let GPS settle (now ±${(fix.acc / UNIT_M[PS().units]).toFixed(1)} ${uLbl()}). This replaces any previous shift for this project.</div>
    <div class="mode-tabs" style="margin:0 0 12px;">
      <button class="mode-tab active" id="calTabNE" onclick="calTab('ne')">Known N / E</button>
      <button class="mode-tab" id="calTabSO" onclick="calTab('so')" ${aligns.length ? '' : 'disabled'}>Known Sta / Offset</button></div>
    <div id="calNE"><div class="row2">
      <div class="field-group"><label class="label">Northing</label><input class="input" id="calN" inputmode="decimal"></div>
      <div class="field-group"><label class="label">Easting</label><input class="input" id="calE" inputmode="decimal"></div></div></div>
    <div id="calSO" class="hidden">
      <div class="field-group"><label class="label">Alignment</label><select class="input" id="calAl">${aligns.map(a => `<option value="${a.id}" ${al && a.id === al.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>
      <div class="row2"><div class="field-group"><label class="label">Station</label><input class="input" id="calSta" placeholder="145+32.00"></div>
        <div class="field-group"><label class="label">Offset (− Lt / + Rt)</label><input class="input" id="calOff" placeholder="0.00" inputmode="decimal"></div></div></div>
    <button class="btn btn-green" onclick="applyCalibrate()">Set shift</button>`);
}
function calTab(m) { _calMode = m; $('calTabNE').classList.toggle('active', m === 'ne'); $('calTabSO').classList.toggle('active', m === 'so'); $('calNE').classList.toggle('hidden', m !== 'ne'); $('calSO').classList.toggle('hidden', m !== 'so'); }
function applyCalibrate() {
  const ps = PS(), cur = projectLL(fix.lat, fix.lon), gpsN = cur.N - ps.shiftN, gpsE = cur.E - ps.shiftE;
  let kN, kE;
  if (_calMode === 'ne') { kN = parseFloat($('calN').value); kE = parseFloat($('calE').value); }
  else {
    const al = aligns.find(a => a.id === $('calAl').value), ds = parseSta($('calSta').value, unitsOf(al)), off = parseFloat($('calOff').value) || 0;
    if (!al || !isFinite(ds)) return toast('Enter a station');
    const p = pointAt(al.poly, internalSta(al, ds), off); kN = p.y; kE = p.x;
  }
  if (!isFinite(kN) || !isFinite(kE)) return toast('Enter both values');
  const dN = kN - gpsN, dE = kE - gpsE, d = Math.hypot(dN, dE);
  if (d * UNIT_M[ps.units] > 150 && !confirm(`That's a ${Math.round(d)} ${uLbl()} shift — usually a zone, unit or scale problem. Apply anyway?`)) return;
  ps.shiftN = dN; ps.shiftE = dE; saveSettings(); closeSheet(); renderSetupPanel();
  pos = projectLL(fix.lat, fix.lon); computeAll(); notify();
  toast(`Shift set: ΔN ${dN.toFixed(2)}, ΔE ${dE.toFixed(2)}`);
}
function clearShift() { const ps = PS(); ps.shiftN = 0; ps.shiftE = 0; saveSettings(); renderSetupPanel(); if (fix) pos = projectLL(fix.lat, fix.lon); computeAll(); notify(); toast('Shift cleared'); }

// ═════════ PAGE PLUMBING ═════════
function initTheme() {
  const btn = $('themeBtn'); if (!btn) return;
  if (document.documentElement.getAttribute('data-theme') === 'high-contrast') btn.textContent = '☀️ Light';
  btn.addEventListener('click', () => {
    const isHC = document.documentElement.getAttribute('data-theme') === 'high-contrast';
    document.documentElement.setAttribute('data-theme', isHC ? '' : 'high-contrast');
    btn.textContent = isHC ? '🌙 Dark' : '☀️ Light';
    localStorage.setItem('ft_theme', isHC ? '' : 'high-contrast'); ftSetSetting('surveyTheme', isHC ? '' : 'high-contrast'); notify();
  });
}
function initTabs(names) {
  const sw = t => {
    document.querySelectorAll('.mode-tab[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    names.forEach(k => $('tab-' + k).classList.toggle('hidden', k !== t));
    window.scrollTo(0, 0); notify(); hook('onTabChange', t);
  };
  document.querySelectorAll('.mode-tab[data-tab]').forEach(b => b.addEventListener('click', () => sw(b.dataset.tab)));
  window.switchTab = sw;
}
async function stationingInit() {
  initTheme();
  await loadSettings();
  const qp = new URLSearchParams(location.search).get('project'); if (qp) { G.projId = qp; saveSettings(); }
  await loadProjects();
  renderProjectBar(); await claimOrphans();
  try { await loadAligns(); } catch (e) { console.error(e); toast('Could not load alignments'); }
  renderSetupPanel();
  startGPS();
  if (!needsCompassTap() && G.compass) enableCompass();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  window.addEventListener('resize', notify);
  window.addEventListener('pageshow', e => { if (e.persisted) { loadProjects().then(() => { renderProjectBar(); switchProject(); }); } });
  hook('onProjectChange'); notify();
}
