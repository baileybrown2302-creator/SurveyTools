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
const { apDB, apGetAll, apGet, apPut, apDel, parseLandXML, buildPolyline, displaySta, fmtSta, convertAlign, UNIT_NAME } = FTAlign;
const { projectWith, ELL, ZONES, fmtOff, internalSta, lccForward, lccInverse, meridionalArc, parseSta, parseStaSide, pointAt, resolveSta, staRegions, staSide, stationOffset, tmForward, tmInverse, zoneOf } = FTAlign;


// ───────── settings: global (G) + per project (PS()) ─────────
const G_DEFAULTS = { projId: '', decl: 12.4, stampNE: false, stampLL: false, stampHdg: true, planWidth: 300, compass: false, mapLayer: '', mapPerp: true };
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
const UNIT_M = { usft: 1200 / 3937, ift: 0.3048, m: 1 };
const UNIT_LBL = { usft: 'ft', ift: 'ft', m: 'm' };
const uLbl = () => UNIT_LBL[PS().units];
// lat/lon → project N/E (grid → ground → check-in shift), project units
function projectLL(lat, lon) { return projectWith(PS(), lat, lon); }
// project N/E → lat/lon (undo check-in shift, ground→grid, units, projection)
function gridToLL(N, E) {
  const ps = PS(), u = UNIT_M[ps.units], cf = +ps.cf || 1;
  let n = N - (+ps.shiftN || 0), e = E - (+ps.shiftE || 0);
  n = ps.baseN + (n - ps.baseN) * cf; e = ps.baseE + (e - ps.baseE) * cf;
  n *= u; e *= u;
  if (ps.zone === 'LCC') return lccInverse(e, n, ps.custom);
  return tmInverse(e, n, ps.zone === 'TM' ? ps.custom : ZONES[ps.zone]);
}
// Grid azimuth of true north at a location (degrees). trueAz = gridAz − this.
function gridNorthOffset(lat, lon) {
  const a = projectLL(lat, lon), b = projectLL(lat + 0.001, lon);
  return Math.atan2(b.E - a.E, b.N - a.N) * R2D;
}

// Station equations: regions of continuous internal stationing, each with its own display stationing.
const sideTxt = side => !side ? '' : /^\d+$/.test(side) ? ':' + side : ' ' + side;
const fmtStaEq = (al, internal) => fmtSta(displaySta(al, internal), unitsOf(al)) + sideTxt(staSide(al, internal));
// Equation / zone table for an alignment
function zoneTableHtml(al) {
  const u = unitsOf(al), R = staRegions(al), ss = al.poly.ss, lo = ss[0], hi = ss[ss.length - 1];
  let h = '<div class="kv">';
  R.forEach((r, k) => {
    const a = Math.max(r.from, lo), b = Math.min(r.to, hi);
    if (b >= a) h += `<span>Zone ${k + 1}</span><span>${fmtSta(r.toDisp(a), u)} → ${fmtSta(r.toDisp(b), u)}</span>`;
    const q = (al.eqs || [])[k];
    if (q && q.internal >= lo && q.internal <= hi) { const bk = isFinite(q.back) ? q.back : q.internal;
      h += `<span style="font-weight:500;color:var(--text-muted)">&nbsp;Eq ${k + 1}</span><span style="color:var(--text-muted)">${fmtSta(bk, u)} BK = ${fmtSta(q.ahead, u)} AH${q.ahead < bk ? ' (overlap)' : q.ahead > bk ? ' (gap)' : ''}</span>`; }
  });
  return h + '</div>';
}
function showZones(id) {
  const al = aligns.find(a => a.id === id); if (!al) return;
  openSheet(`<div class="sheet-title">${esc(al.name)} — station equations <button class="sheet-close" onclick="closeSheet()">×</button></div>
    ${zoneTableHtml(al)}
    <div class="hint" style="margin-top:12px;">Where a station exists more than once (overlapping equations) it's shown with its zone, like <b>119+00:3</b>. Type stations the same way to pick a zone — same notation as Trimble Access.</div>`);
}

// ═════════ LIVE STATE ═════════
let aligns = [], fix = null, pos = null, heading = null, gpsCourse = null, results = [], current = null, autoId = null;
// The project's unit setting governs everything (stationing format, distances, projection).
const unitsOf = () => PS().units;
async function loadAligns() {
  const rows = G.projId ? (await apGetAll('alignments')).filter(r => r.projId === G.projId) : [];
  // keep each stored alignment's units in step with the project setting (Project Manager reads them)
  for (let i = 0; i < rows.length; i++) {
    const fixed = FTAlign.fixUnitLabel(rows[i], PS().zone);   // repair metric values stored with a feet label (or vice versa)
    if (fixed !== rows[i] || fixed.units !== PS().units) { rows[i] = convertAlign(fixed, PS().units); await apPut('alignments', rows[i]); }
  }
  aligns = rows.map(r => ({ ...r, poly: buildPolyline(r, PS().units) }));
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
let gpsWatchId = null, gpsDenied = false;
function startGPS() {
  if (!('geolocation' in navigator)) { const c = $('gpsChip'); if (c) { c.textContent = 'GPS not available'; c.className = 'chip bad'; } return; }
  if (gpsWatchId != null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
  gpsWatchId = navigator.geolocation.watchPosition(p => {
    gpsDenied = false;
    fix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, alt: p.coords.altitude, time: p.timestamp };
    gpsCourse = (p.coords.speed != null && p.coords.speed > 0.7 && p.coords.heading != null && !isNaN(p.coords.heading)) ? p.coords.heading : null;
    pos = projectLL(fix.lat, fix.lon);
    computeAll(); notify();
  }, err => {
    if (err.code === 1) gpsDenied = true;
    const c = $('gpsChip'); if (c) { c.textContent = err.code === 1 ? 'GPS: denied — tap to retry' : 'GPS: ' + (err.code === 3 ? 'no fix yet' : (err.message || 'error')) + ' — tap to retry'; c.className = 'chip bad'; }
    if (err.code === 1 && retryingGPS) { retryingGPS = false; gpsHelp(); }
  },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

// Tap the GPS chip: ask again (the phone only re-prompts if access isn't blocked in its settings)
let retryingGPS = false;
function retryGPS() {
  const c = $('gpsChip'); if (c) { c.textContent = 'GPS: asking…'; c.className = 'chip'; }
  retryingGPS = true; startGPS();
  setTimeout(() => { retryingGPS = false; }, 8000);
}
function gpsHelp() {
  const android = /Android/i.test(navigator.userAgent);
  openSheet(`<div class="sheet-title">Location is blocked <button class="sheet-close" onclick="closeSheet()">×</button></div>
    <div class="hint" style="font-size:0.88em;line-height:1.5;margin-bottom:12px;">The phone is blocking location for this app, so it can't ask again from here. Turn it back on in the phone's settings, then tap the GPS bubble again.</div>
    <div class="hint" style="font-size:0.88em;line-height:1.5;margin-bottom:14px;">${android
      ? '<b>Android (Chrome):</b> tap ⋮ → <b>Settings</b> → <b>Site settings</b> → <b>Location</b>, find this site under Blocked and set it to <b>Allow</b>. Also check phone <b>Settings → Location</b> is on, and that Chrome is allowed location (Settings → Apps → Chrome → Permissions → Location).'
      : '<b>iPhone:</b> <b>Fix that usually works:</b> open the app\'s web address in <b>Safari</b>, tap the <b>aA</b> (page menu) button in the address bar → <b>Website Settings</b>, and set <b>Location</b> to <b>Allow</b>. Also check Settings → Apps → Safari → <b>Location</b> isn\'t set to Deny. Then close this app fully and reopen it.<br><br>Otherwise: Settings → <b>Privacy &amp; Security → Location Services</b> must be on. Then scroll to <b>Safari Websites</b> and set it to <b>While Using the App</b> (and Precise Location on). If it still won\'t ask, close the app fully and reopen it.'}</div>
    <button class="btn btn-primary" onclick="closeSheet();retryGPS()">Try again</button>`);
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
// iOS Safari: needs a tap + requestPermission, gives webkitCompassHeading.
// Android Chrome: has deviceorientationabsolute and needs no prompt (newer Chrome also exposes
// requestPermission but may answer "denied" without asking — so it is never used there).
const hasAbsolute = () => 'ondeviceorientationabsolute' in window;
// A computer with no touch screen has no compass: don't pop up help on its own there
const noCompassDevice = () => !(navigator.maxTouchPoints > 0) && !/Android|iPhone|iPad/i.test(navigator.userAgent);
const needsCompassTap = () => !hasAbsolute() && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function';
function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientAbs);
  window.removeEventListener('deviceorientation', onOrientIOS);
  if (onOrientAny) window.removeEventListener('deviceorientation', onOrientAny);
  compassOn = false; hx = hy = null; lastHeadingAt = 0; heading = null;
}
let onOrientAny = null;
async function enableCompass(restart) {
  if (compassOn && !restart) return;
  if (compassOn) stopCompass();
  const cc = $('compassChip'); if (cc) { cc.textContent = '🧭 asking…'; cc.className = 'chip'; }
  try {
    if (hasAbsolute()) window.addEventListener('deviceorientationabsolute', onOrientAbs);
    else if (needsCompassTap()) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { if (cc) { cc.textContent = '🧭 Denied — tap to retry'; cc.className = 'chip btnchip bad'; } compassHelp(true); return; }
      window.addEventListener('deviceorientation', onOrientIOS);
    } else { onOrientAny = e => { if (e.webkitCompassHeading != null) onOrientIOS(e); else if (e.absolute) onOrientAbs(e); }; window.addEventListener('deviceorientation', onOrientAny); }
    compassOn = true; G.compass = true; saveSettings();
    setTimeout(() => { if (!lastHeadingAt && (restart || !noCompassDevice())) compassHelp(false); notify(); }, 3000);
    notify();
  } catch (err) { if (cc) { cc.textContent = '🧭 Tap to enable compass'; cc.className = 'chip btnchip bad'; } compassHelp(true, err.message); }
}
function compassHelp(denied, msg) {
  const android = /Android/i.test(navigator.userAgent);
  openSheet(`<div class="sheet-title">Compass not available <button class="sheet-close" onclick="closeSheet()">×</button></div>
    <div class="hint" style="font-size:0.88em;line-height:1.5;margin-bottom:12px;">${denied ? 'The phone blocked access to the motion sensors.' : 'No compass readings are coming from this phone.'}${msg ? ' (' + esc(msg) + ')' : ''}</div>
    <div class="hint" style="font-size:0.88em;line-height:1.5;margin-bottom:14px;">${android
      ? '<b>Android (Chrome):</b> tap ⋮ → <b>Settings</b> → <b>Site settings</b> → <b>Motion sensors</b>, and make sure it is <b>allowed</b> (and this site is not in the Blocked list). Then close and reopen the app.'
      : '<b>iPhone:</b> <b>Fix that usually works:</b> open the app\'s web address in <b>Safari</b>, tap the <b>aA</b> (page menu) button in the address bar → <b>Website Settings</b>, and set <b>Motion &amp; Orientation</b> to <b>Allow</b>. Also check Settings → Apps → Safari → <b>Motion &amp; Orientation Access</b> isn\'t set to Deny. Then close this app fully and reopen it.<br><br>Otherwise: once you tap Don\'t Allow, iOS won\'t ask again until the app is restarted. Swipe the app away to close it fully, reopen it, tap the compass bubble and choose <b>Allow</b>. If it still never asks: Settings → <b>Apps → Safari → Advanced → Website Data</b>, delete this site\'s data (clears its permissions — export your projects first), or check Settings → Privacy &amp; Security → <b>Motion &amp; Fitness</b> is on.'}
    <br><br>Without a compass, Navigate still points the arrow using your GPS direction once you start walking.</div>
    <div class="btn-row"><button class="btn btn-secondary" onclick="closeSheet()">OK</button><button class="btn btn-primary" onclick="closeSheet();enableCompass(true)">Try again</button></div>`);
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const fmtHdg = h => h == null ? '—' : DIRS[Math.round(h / 45) % 8] + ' ' + Math.round(h) + '°';
const headingNow = () => (heading != null && Date.now() - lastHeadingAt < 5000) ? heading : null;

function renderChips() {
  const gc = $('gpsChip');
  if (gc) gc.onclick = () => { if (gpsDenied && navigator.permissions) navigator.permissions.query({ name: 'geolocation' }).then(st => st.state === 'denied' ? gpsHelp() : retryGPS()).catch(retryGPS); else retryGPS(); };
  if (gc && fix && !gpsDenied) { gc.textContent = `GPS ±${Math.round(fix.acc / UNIT_M[PS().units])} ${uLbl()}`; gc.className = 'chip ' + (fix.acc <= 10 ? 'ok' : fix.acc > 30 ? 'bad' : ''); }
  const cc = $('compassChip');
  if (cc) {
    if (compassOn) { cc.textContent = '🧭 ' + (headingNow() != null ? fmtHdg(headingNow()) : (noCompassDevice() ? 'none on this computer' : 'no data — tap')); cc.className = 'chip ' + (headingNow() != null ? 'ok' : 'bad'); }
    cc.onclick = () => enableCompass(true);   // tap again any time to restart / re-ask
  }
}

// ═════════ MAP VIEW ═════════ (lib/stationmap.js)
function drawPlan(el, opts = {}) { if (typeof FTMap !== 'undefined') FTMap.update(el, opts); }

// ═════════ ALIGNMENT PICKER ═════════
let _pickerCb = null;
function openAlignPicker(cb, curId, z) {
  _pickerCb = cb || null;
  const sel = cb ? curId : (PS().lockId || '');
  const row = (id, label, meta) => `<div class="pick-item ${sel === id ? 'cur' : ''}" onclick="pickAlign('${id}')"><span>${label}</span><span class="pm">${meta}</span></div>`;
  let html = `<div class="sheet-title">Alignment <button class="sheet-close" onclick="closeSheet()">×</button></div>`;
  html += row('', '🎯 Auto — nearest alignment', !cb && current && !PS().lockId ? esc(current.al.name) : '');
  const list = aligns.filter(a => a.visible !== false).map(al => ({ al, r: pos ? stationOffset(al.poly, pos.E, pos.N) : null })).sort((a, b) => (a.r ? a.r.dist : 0) - (b.r ? b.r.dist : 0));
  for (const { al, r } of list) html += row(al.id, esc(al.name), r ? `${fmtStaEq(al, r.sta)} · ${fmtOff(r.off, unitsOf(al))}` : '');
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

// Coordinate system + compass: collapsed, locked, and placed at the bottom of Setup so a
// project set up in the office isn't changed by accident in the field.
let advUnlocked = false;
function advancedHtml() {
  const ps = PS(), c = ps.custom, zl = { NV_W: 'NAD83 NV West', NV_W94: 'NAD83/94 NV West', NV_C: 'NAD83 NV Central', NV_E: 'NAD83 NV East', TM: 'Custom TM', LCC: 'Custom LCC' }[ps.zone] || ps.zone;
  const summary = `${zl} · ${({ usft: 'US ft', ift: 'Intl ft', m: 'm' })[ps.units]} · CF ${ps.cf === 1 ? '1 (grid)' : ps.cf}${ps.shiftN || ps.shiftE ? ' · shift set' : ''}`;
  return `
  <details class="card adv" id="advCoord">
    <summary><span class="card-title" style="margin:0;">🔒 Coordinate System — this project</span><span class="adv-sum">${esc(summary)}</span></summary>
    <div class="adv-lock">
      <span>${advUnlocked ? 'Editing — changes apply right away.' : 'Locked so field settings aren\'t changed by accident.'}</span>
      <button class="btn btn-sm ${advUnlocked ? 'btn-primary' : 'btn-secondary'}" onclick="toggleAdvLock(event)">${advUnlocked ? '🔒 Lock' : '✏️ Unlock to edit'}</button>
    </div>
    <fieldset class="adv-fields" ${advUnlocked ? '' : 'disabled'}>
    <div class="field-group"><label class="label">Projection</label>
      <select class="input" id="csZone">
        <option value="NV_W">NAD83 Nevada West (2703)</option><option value="NV_W94">NAD83/94 (HARN) Nevada West</option><option value="NV_C">NAD83 Nevada Central (2702)</option><option value="NV_E">NAD83 Nevada East (2701)</option>
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
      <div class="hint">Stations, offsets and coordinates are in these units. LandXML in other units (TBC often exports metric) is converted on import.</div></div>
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
  </fieldset>
  </details>
  <details class="card adv" id="advCompass">
    <summary><span class="card-title" style="margin:0;">🔒 Compass</span><span class="adv-sum">Declination ${esc(G.decl)}° E</span></summary>
    <div class="adv-lock">
      <span>${advUnlocked ? 'Editing.' : 'Locked.'}</span>
      <button class="btn btn-sm ${advUnlocked ? 'btn-primary' : 'btn-secondary'}" onclick="toggleAdvLock(event)">${advUnlocked ? '🔒 Lock' : '✏️ Unlock to edit'}</button>
    </div>
    <fieldset class="adv-fields" ${advUnlocked ? '' : 'disabled'}>
    <div class="field-group"><label class="label">Magnetic declination (° East)</label><input class="input" id="decl" inputmode="decimal" value="${G.decl}">
      <div class="hint">Phone compasses read magnetic north. Northern Nevada is about 12–13° E. Applies to all projects.</div></div>
  </fieldset>
  </details>`;
}
function toggleAdvLock(e) {
  e.preventDefault();
  if (!advUnlocked && !confirm('Unlock coordinate settings? These were set up for the whole crew — only change them if you know the project needs it.')) return;
  advUnlocked = !advUnlocked;
  renderSetupPanel();
}
function renderSetupPanel() {
  const el = $('setupPanel'); if (!el) return;
  if (!G.projId) {
    el.innerHTML = `<div class="card"><div class="card-title">No project selected</div>
      <div class="hint" style="font-size:0.85em;margin-bottom:10px;">Alignments and coordinate settings are saved per project. Pick a project at the top, or create one in Project Manager.</div>
      <a class="btn btn-primary" href="project_manager.html" style="text-decoration:none;">📁 Open Project Manager</a></div>`;
    if ($('setupAdvanced')) $('setupAdvanced').innerHTML = '';
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
      <div class="al-meta">${fmtSta(displaySta(a, ss[0]), u)} → ${fmtSta(displaySta(a, ss[ss.length - 1]), u)} · ${a.els.length} el${a.eqs && a.eqs.length ? ` · <a href="#" onclick="event.preventDefault();showZones('${a.id}')">${a.eqs.length} eq — view</a>` : ''} · ${esc(a.file)}${a.srcUnits ? ' · from ' + ({ m: 'meters', ift: 'intl ft', usft: 'US ft' })[a.srcUnits] : ''}</div></div>
      <button class="btn btn-secondary btn-sm" onclick="removeAlign('${a.id}')">✕</button></div>`; }).join('') : '<div class="hint" style="font-size:0.85em;padding:6px 0 10px;">No alignments for this project yet.</div>'}</div>
    <div class="hint">Lines, curves, spirals and station equations. Export from TBC or Civil 3D as LandXML. Uncheck an alignment to hide it.</div>
  </div>
  <div class="card">
    <div class="card-title">Map station labels</div>
    ${tickSettingsHtml()}
  </div>
`;
  const advOpen = [...document.querySelectorAll('details.adv')].filter(d => d.open).map(d => d.id);
  const advHost = $('setupAdvanced') || el;
  if (advHost === el) el.insertAdjacentHTML('beforeend', advancedHtml()); else advHost.innerHTML = advancedHtml();
  advOpen.forEach(id => { const d = $(id); if (d) d.open = true; });
  $('csZone').value = ps.zone; $('csUnits').value = ps.units;
  document.querySelectorAll('[data-tick]').forEach(el => el.addEventListener('change', onTickSetting));
  const ts = $('tickSide'); if (ts) ts.addEventListener('click', e => { const v = e.target.dataset.v; if (!v) return; G.mapTickSide = v; [...ts.children].forEach(b => b.classList.toggle('on', b.dataset.v === v)); saveSettings(); if (typeof FTMap !== 'undefined') FTMap.refreshTicks(); });
  $('xmlInput').addEventListener('change', e => { if (e.target.files.length) importLandXML([...e.target.files]); e.target.value = ''; });
  ['csZone', 'csUnits', 'csCF', 'csBaseN', 'csBaseE', 'decl', 'cpLat0', 'cpLon0', 'cpK0', 'cpLat1', 'cpLat2', 'cpFE', 'cpFN'].forEach(id => $(id) && $(id).addEventListener('change', onSetupChange));
}
function tickSettingsHtml() {
  if (typeof FTMap === 'undefined') return '<div class="hint">Map not available on this page.</div>';
  const sys = PS().units === 'm' ? 'm' : 'ft', u = sys === 'm' ? 'm' : 'ft';
  const cfg = Object.assign({}, FTMap.TICK_DEFAULTS[sys], ((G.mapTicks || {})[sys]) || {});
  const opts = sys === 'm' ? [0, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000] : [0, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const sel = band => `<select class="input" data-tick="${band}">${opts.map(v => `<option value="${v}" ${+cfg[band] === v ? 'selected' : ''}>${v ? 'Every ' + v.toLocaleString() + ' ' + u : 'Off'}</option>`).join('')}</select>`;
  return `<div class="row2"><div class="field-group"><label class="label">Zoomed in close</label>${sel('close')}</div><div class="field-group"><label class="label">Street level</label>${sel('mid')}</div></div>
    <div class="row2"><div class="field-group"><label class="label">Zoomed out</label>${sel('far')}</div><div class="field-group"><label class="label">Far out</label>${sel('vfar')}</div></div>
    <div class="field-group"><label class="label">Label side (looking up-station)</label>
      <div class="seg" id="tickSide"><button data-v="left" class="${G.mapTickSide === 'left' ? 'on' : ''}">Left</button><button data-v="right" class="${G.mapTickSide !== 'left' ? 'on' : ''}">Right</button></div></div>
    <div class="hint">Labels sit square to the alignment. Pinch the map in or out to see each level. Applies to all projects.</div>`;
}
function onTickSetting() {
  const sys = PS().units === 'm' ? 'm' : 'ft';
  G.mapTicks = G.mapTicks || {}; G.mapTicks[sys] = {};
  document.querySelectorAll('[data-tick]').forEach(el => { G.mapTicks[sys][el.dataset.tick] = +el.value; });
  saveSettings(); if (typeof FTMap !== 'undefined') FTMap.refreshTicks();
}
function onSetupChange() {
  const num = (id, d) => { const v = $(id) ? parseFloat($(id).value) : NaN; return isFinite(v) ? v : d; };
  const ps = PS();
  const oldUnits = ps.units, unitsChanged = oldUnits !== $('csUnits').value;
  if (unitsChanged && aligns.length && !confirm(`Switch this project to ${UNIT_NAME[$('csUnits').value]}? Alignments, check-in shift and the point list are converted so they stay in the same place.`)) { $('csUnits').value = oldUnits; return; }
  ps.zone = $('csZone').value; ps.units = $('csUnits').value;
  if (unitsChanged) {
    const k = UNIT_M[oldUnits] / UNIT_M[ps.units];
    ps.shiftN *= k; ps.shiftE *= k; ps.baseN *= k; ps.baseE *= k;
    (ps.stakeList || []).concat(...(ps.stakeLists || []).map(l => l.points || [])).forEach(p => { p.sta *= k; p.off *= k; });
    if (ps.target) { ps.target.sta *= k; ps.target.off *= k; }
    if ($('csBaseN')) { $('csBaseN').value = ps.baseN || ''; $('csBaseE').value = ps.baseE || ''; }
  }
  const cf = num('csCF', 1); ps.cf = cf > 0.9 && cf < 1.1 ? cf : 1;
  if (!unitsChanged) { ps.baseN = num('csBaseN', 0); ps.baseE = num('csBaseE', 0); }
  G.decl = num('decl', 12.4);
  ps.custom = { lat0: num('cpLat0', ps.custom.lat0), lon0: num('cpLon0', ps.custom.lon0), k0: num('cpK0', ps.custom.k0), lat1: num('cpLat1', ps.custom.lat1), lat2: num('cpLat2', ps.custom.lat2), fe: num('cpFE', ps.custom.fe), fn: num('cpFN', ps.custom.fn) };
  saveSettings();
  if (unitsChanged) { loadAligns().then(() => { renderSetupPanel(); computeAll(); notify(); }); } else renderSetupPanel();
  if (fix) pos = projectLL(fix.lat, fix.lon);
  hx = hy = null; computeAll(); notify();
}
async function importLandXML(files) {
  if (!G.projId) return toast('Select a project first');
  saveSettings();
  const res = await FTAlign.importFiles(G.projId, files, { units: PS().units, zone: PS().zone, updateSettings: !aligns.length });
  res.errors.forEach(e => toast(e, 4000));
  // pick up a zone hint the importer may have written for a brand-new project
  const s = await ftGetSetting('ftStationing', null); if (s && s.p && s.p[G.projId] && s.p[G.projId].zone) PS().zone = s.p[G.projId].zone;
  saveSettings(); await loadAligns(); renderSetupPanel();
  if (fix) pos = projectLL(fix.lat, fix.lon);
  computeAll(); notify();
  if (res.added) toast(`Imported ${res.added} alignment${res.added > 1 ? 's' : ''}${res.converted ? ` (converted from ${UNIT_NAME[res.converted]})` : ''}`, 3500);
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
    const al = aligns.find(a => a.id === $('calAl').value), ps2 = parseStaSide($('calSta').value, unitsOf(al)), ds = ps2.v, off = parseFloat($('calOff').value) || 0;
    if (!al || !isFinite(ds)) return toast('Enter a station');
    const p = pointAt(al.poly, internalSta(al, ds, ps2.side), off); kN = p.y; kE = p.x;
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
    window.scrollTo(0, 0); if (typeof FTMap !== 'undefined') FTMap.hidden(); notify(); hook('onTabChange', t);
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
  if ((hasAbsolute() || !needsCompassTap()) && G.compass) enableCompass();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  window.addEventListener('resize', notify);
  window.addEventListener('pageshow', e => { if (e.persisted) { loadProjects().then(() => { renderProjectBar(); switchProject(); }); } });
  hook('onProjectChange'); notify();
}
