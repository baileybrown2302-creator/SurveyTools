/* ══════════════════════════════════════════════════════════════
   Field Tools — alignment storage & LandXML parsing (window.FTAlign)
   Shared by Project Manager, Station / Offset and Station Photos.
   Alignments are stored per project (record.projId) in IndexedDB "FieldToolsStationPhotos".
   ══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const D2R = Math.PI / 180;
// ───────── local DB (alignments + photos), shared by both apps ─────────
const AP_DB = 'FieldToolsStationPhotos';
let _apdb;
function apDB() {
  if (_apdb) return Promise.resolve(_apdb);
  return new Promise((res, rej) => {
    const r = indexedDB.open(AP_DB, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('alignments')) db.createObjectStore('alignments', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    r.onsuccess = () => { _apdb = r.result; res(_apdb); };
    r.onerror = () => rej(r.error);
  });
}
async function apTx(store, mode, fn) {
  const db = await apDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, mode); const req = fn(tx.objectStore(store));
    tx.oncomplete = () => res(req ? req.result : undefined);
    tx.onerror = () => rej(tx.error);
  });
}
const apGetAll = s => apTx(s, 'readonly', os => os.getAll());
const apGet = (s, k) => apTx(s, 'readonly', os => os.get(k));
const apPut = (s, v, k) => apTx(s, 'readwrite', os => k !== undefined ? os.put(v, k) : os.put(v));
const apDel = (s, k) => apTx(s, 'readwrite', os => os.delete(k));

// ═════════ LANDXML ═════════
const LX_UNITS = { usSurveyFoot: 'usft', USSurveyFoot: 'usft', foot: 'ift', InternationalFoot: 'ift', internationalFoot: 'ift', meter: 'm', metre: 'm' };
const lxChildren = (el, name) => [...el.children].filter(c => c.localName === name);
const lxFirst = (el, name) => [...el.children].find(c => c.localName === name);
function parseLandXML(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Not a valid XML file');
  const root = doc.documentElement;
  if (root.localName !== 'LandXML') throw new Error('Not a LandXML file');
  let units = null;
  const uEl = lxFirst(root, 'Units');
  if (uEl) { const u = uEl.firstElementChild; const lu = u && u.getAttribute('linearUnit'); if (lu) units = LX_UNITS[lu] || (u.localName === 'Metric' ? 'm' : 'usft'); }
  let csHint = '';
  const cs = lxFirst(root, 'CoordinateSystem');
  if (cs) {
    const txt = [cs.getAttribute('name'), cs.getAttribute('desc'), cs.getAttribute('horizontalCoordinateSystemName'), cs.getAttribute('epsgCode')].filter(Boolean).join(' ');
    if (/nevada/i.test(txt) || /\b(2701|2702|2703|3421|3422|3423|32107|32108|32109)\b/.test(txt)) {
      if (/west|2703|3423|32109/i.test(txt)) csHint = 'NV_W'; else if (/central|2702|3422|32108/i.test(txt)) csHint = 'NV_C'; else if (/east|2701|3421|32107/i.test(txt)) csHint = 'NV_E';
    }
  }
  const cg = {};
  doc.querySelectorAll('CgPoint').forEach(p => { const n = p.getAttribute('name'); if (n) cg[n] = p.textContent; });
  const pt = el => {
    if (!el) return null;
    let txt = el.textContent.trim();
    if (!txt && el.getAttribute('pntRef')) txt = cg[el.getAttribute('pntRef')] || '';
    const v = txt.split(/[\s,]+/).map(Number);
    if (v.length < 2 || !isFinite(v[0]) || !isFinite(v[1])) return null;
    return { x: v[1], y: v[0] }; // LandXML = "Northing Easting"
  };
  const out = [];
  doc.querySelectorAll('Alignment').forEach(al => {
    const geom = lxFirst(al, 'CoordGeom'); if (!geom) return;
    const staStart = parseFloat(al.getAttribute('staStart')) || 0;
    const els = [];
    for (const c of geom.children) {
      const t = c.localName, staAttr = parseFloat(c.getAttribute('staStart'));
      const base = { sta: isFinite(staAttr) ? staAttr : null };
      if (t === 'Line') {
        const s = pt(lxFirst(c, 'Start')), e = pt(lxFirst(c, 'End'));
        if (s && e) els.push({ ...base, t: 'L', s, e });
      } else if (t === 'Curve') {
        const s = pt(lxFirst(c, 'Start')), e = pt(lxFirst(c, 'End')), ctr = pt(lxFirst(c, 'Center'));
        if (s && e && ctr) els.push({ ...base, t: 'C', s, e, c: ctr, rot: (c.getAttribute('rot') || 'cw').toLowerCase() });
      } else if (t === 'Spiral') {
        const s = pt(lxFirst(c, 'Start')), e = pt(lxFirst(c, 'End')), pi = pt(lxFirst(c, 'PI'));
        const rs = c.getAttribute('radiusStart'), re = c.getAttribute('radiusEnd');
        if (s && e) els.push({ ...base, t: 'S', s, e, pi, L: parseFloat(c.getAttribute('length')),
          rs: (!rs || /inf/i.test(rs)) ? Infinity : parseFloat(rs), re: (!re || /inf/i.test(re)) ? Infinity : parseFloat(re),
          rot: (c.getAttribute('rot') || 'cw').toLowerCase() });
      } else if (t === 'IrregularLine' || t === 'Chain') {
        const pl = lxFirst(c, 'PntList2D') || lxFirst(c, 'PntList3D');
        if (pl) {
          const dim = pl.localName === 'PntList3D' ? 3 : 2;
          const v = pl.textContent.trim().split(/[\s,]+/).map(Number);
          for (let i = 0; i + 2 * dim - 1 < v.length; i += dim) els.push({ t: 'L', sta: null, s: { x: v[i + 1], y: v[i] }, e: { x: v[i + dim + 1], y: v[i + dim] } });
        }
      }
    }
    if (!els.length) return;
    const eqs = lxChildren(al, 'StaEquation').map(q => ({ internal: parseFloat(q.getAttribute('staInternal')), ahead: parseFloat(q.getAttribute('staAhead')), back: parseFloat(q.getAttribute('staBack')) }))
      .filter(q => isFinite(q.internal) && isFinite(q.ahead)).sort((a, b) => a.internal - b.internal);
    out.push({ name: al.getAttribute('name') || 'Alignment', staStart, els, eqs });
  });
  if (!out.length) throw new Error('No horizontal alignments found in file');
  return { alignments: out, units, csHint, fileName };
}
function buildPolyline(al, units) {
  const maxChord = units === 'm' ? 0.5 : 1.5;
  const X = [], Y = [], St = [];
  let sta = al.staStart;
  const push = (x, y, s) => { const n = X.length; if (n && Math.abs(X[n - 1] - x) < 1e-6 && Math.abs(Y[n - 1] - y) < 1e-6) { St[n - 1] = s; return; } X.push(x); Y.push(y); St.push(s); };
  for (const el of al.els) {
    if (el.sta != null && (X.length === 0 || Math.abs(el.sta - sta) < 1)) sta = el.sta;
    const s0 = sta;
    if (el.t === 'L') {
      const len = Math.hypot(el.e.x - el.s.x, el.e.y - el.s.y);
      push(el.s.x, el.s.y, s0); push(el.e.x, el.e.y, s0 + len); sta = s0 + len;
    } else if (el.t === 'C') {
      const R = Math.hypot(el.s.x - el.c.x, el.s.y - el.c.y);
      const a0 = Math.atan2(el.s.y - el.c.y, el.s.x - el.c.x), a1 = Math.atan2(el.e.y - el.c.y, el.e.x - el.c.x);
      let d = a1 - a0;
      if (el.rot === 'ccw') { while (d <= 0) d += 2 * Math.PI; } else { while (d >= 0) d -= 2 * Math.PI; }
      const len = R * Math.abs(d);
      const n = Math.max(2, Math.ceil(len / maxChord), Math.ceil(Math.abs(d) / (0.5 * D2R)));
      for (let i = 0; i <= n; i++) { const a = a0 + d * i / n; push(el.c.x + R * Math.cos(a), el.c.y + R * Math.sin(a), s0 + len * i / n); }
      sta = s0 + len;
    } else if (el.t === 'S') {
      const pts = spiralPoints(el, maxChord);
      for (const p of pts) push(p.x, p.y, s0 + p.s);
      sta = s0 + pts[pts.length - 1].s;
    }
  }
  const xs = Float64Array.from(X), ys = Float64Array.from(Y), ss = Float64Array.from(St);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < xs.length; i++) { minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minY = Math.min(minY, ys[i]); maxY = Math.max(maxY, ys[i]); }
  return { xs, ys, ss, bbox: [minX, minY, maxX, maxY] };
}
// Clothoid by numeric integration, fitted to the exact End point.
function spiralPoints(el, maxChord) {
  let L = el.L;
  if (!isFinite(L) || L <= 0) L = Math.hypot(el.e.x - el.s.x, el.e.y - el.s.y);
  const th0 = (el.pi && Math.hypot(el.pi.x - el.s.x, el.pi.y - el.s.y) > 1e-6) ? Math.atan2(el.pi.y - el.s.y, el.pi.x - el.s.x) : Math.atan2(el.e.y - el.s.y, el.e.x - el.s.x);
  const sg = el.rot === 'ccw' ? 1 : -1;
  const k1 = isFinite(el.rs) && el.rs > 0 ? sg / el.rs : 0, k2 = isFinite(el.re) && el.re > 0 ? sg / el.re : 0;
  const th = s => th0 + k1 * s + (k2 - k1) * s * s / (2 * L);
  const n = Math.max(4, Math.ceil(L / maxChord));
  const pts = [{ x: 0, y: 0, s: 0 }];
  let x = 0, y = 0;
  for (let i = 1; i <= n; i++) {
    const a = L * (i - 1) / n, b = L * i / n, m = (a + b) / 2, h = b - a;
    x += h / 6 * (Math.cos(th(a)) + 4 * Math.cos(th(m)) + Math.cos(th(b)));
    y += h / 6 * (Math.sin(th(a)) + 4 * Math.sin(th(m)) + Math.sin(th(b)));
    pts.push({ x, y, s: b });
  }
  const ex = el.e.x - el.s.x, ey = el.e.y - el.s.y;
  const sc = Math.hypot(ex, ey) / (Math.hypot(x, y) || 1), rot = Math.atan2(ey, ex) - Math.atan2(y, x);
  const cr = Math.cos(rot) * sc, sr = Math.sin(rot) * sc;
  return pts.map(p => ({ x: el.s.x + p.x * cr - p.y * sr, y: el.s.y + p.x * sr + p.y * cr, s: p.s }));
}
function displaySta(al, internal) { let s = internal; for (const q of al.eqs || []) if (internal >= q.internal) s = q.ahead + (internal - q.internal); return s; }
function fmtSta(v, units) {
  if (v == null || !isFinite(v)) return '—';
  const per = units === 'm' ? 1000 : 100, w = units === 'm' ? 3 : 2;
  const neg = v < 0, a = Math.abs(v);
  let st = Math.floor(a / per), remS = (a - st * per).toFixed(1);
  if (parseFloat(remS) >= per) { st += 1; remS = '0.0'; }
  const [ip, dp] = remS.split('.');
  return (neg ? '-' : '') + st + '+' + ip.padStart(w, '0') + '.' + dp;
}

async function getForProject(projId) { return (await apGetAll('alignments')).filter(a => a.projId === projId); }
// Import LandXML files into a project. Returns { added, errors[] }.
// opts.updateSettings: when the project has no alignments yet, set its units/zone in the shared stationing settings.
async function importFiles(projId, files, opts = {}) {
  const existing = await getForProject(projId);
  let added = 0, first = null; const errors = [];
  for (const f of files) {
    try {
      const res = parseLandXML(await f.text(), f.name);
      if (!first) first = res;
      for (const a of res.alignments) {
        const rec = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), projId, name: a.name, file: f.name, units: res.units || 'usft', staStart: a.staStart, els: a.els, eqs: a.eqs, visible: true, imported: Date.now() };
        const dup = existing.find(x => x.name === a.name && x.file === f.name);
        if (dup) { rec.id = dup.id; rec.visible = dup.visible; }
        await apPut('alignments', rec); added++;
      }
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  if (opts.updateSettings && first && !existing.length && typeof ftGetSetting === 'function') {
    const s = (await ftGetSetting('ftStationing', null)) || { g: {}, p: {} };
    s.p = s.p || {};
    const ps = s.p[projId] || {};
    if (first.units) ps.units = first.units;
    if (first.csHint) ps.zone = first.csHint;
    s.p[projId] = ps;
    await ftSetSetting('ftStationing', s);
  }
  return { added, errors };
}
// Summary for lists: start/end display stations
function summarize(rec) {
  const poly = buildPolyline(rec, rec.units), ss = poly.ss;
  return { start: displaySta(rec, ss[0]), end: displaySta(rec, ss[ss.length - 1]), length: ss[ss.length - 1] - ss[0] };
}
async function deleteProjectData(projId) {
  for (const a of await getForProject(projId)) await apDel('alignments', a.id);
  for (const p of (await apGetAll('photos')).filter(p => p.projId === projId)) {
    await apDel('photos', p.id); await apDel('blobs', p.id + ':orig'); await apDel('blobs', p.id + ':stamp');
  }
}
window.FTAlign = { apDB, apGetAll, apGet, apPut, apDel, parseLandXML, buildPolyline, displaySta, fmtSta, getForProject, importFiles, summarize, deleteProjectData };
})();
