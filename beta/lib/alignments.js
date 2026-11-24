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
// "foot" is written by most exporters (Civil 3D included) for US survey feet projects — Nevada SPCS is US survey feet.
const LX_UNITS = { usSurveyFoot: 'usft', USSurveyFoot: 'usft', foot: 'usft', Foot: 'usft', InternationalFoot: 'ift', internationalFoot: 'ift', meter: 'm', metre: 'm' };
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
    if (/nevada/i.test(txt) || /\b(2701|2702|2703|3421|3422|3423|32107|32108|32109|2822|3431)\b/.test(txt)) {
      if (/harn|\/\s*94|\(1994\)|\b(2822|3431)\b/i.test(txt) && /west|2822|3431/i.test(txt)) csHint = 'NV_W94';
      else if (/west|2703|3423|32109/i.test(txt)) csHint = 'NV_W'; else if (/central|2702|3422|32108/i.test(txt)) csHint = 'NV_C'; else if (/east|2701|3421|32107/i.test(txt)) csHint = 'NV_E';
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

// ── units: alignments are stored in the PROJECT's working units (stations, offsets, coordinates) ──
const UNIT_M = { usft: 1200 / 3937, ift: 0.3048, m: 1 };
const UNIT_NAME = { usft: 'US survey feet', ift: 'international feet', m: 'meters' };
// Scale every length in an alignment record by k (coordinates, stations, radii, lengths, equations)
function scaleAlign(rec, k) {
  if (k === 1) return rec;
  const P = p => p ? { x: p.x * k, y: p.y * k } : p;
  const els = rec.els.map(e => {
    const o = { ...e, s: P(e.s), e: P(e.e) };
    if (e.c) o.c = P(e.c); if (e.pi) o.pi = P(e.pi);
    if (e.sta != null) o.sta = e.sta * k;
    if (isFinite(e.L)) o.L = e.L * k;
    if (isFinite(e.rs)) o.rs = e.rs * k; if (isFinite(e.re)) o.re = e.re * k;
    return o;
  });
  const eqs = (rec.eqs || []).map(q => ({ internal: q.internal * k, ahead: q.ahead * k, back: isFinite(q.back) ? q.back * k : q.back }));
  return { ...rec, els, eqs, staStart: rec.staStart * k };
}
// Nevada state plane: tell meters from feet by the size of the northings.
// Zone false northings (m): W 4,000,000 · C 6,000,000 · E 8,000,000; Nevada spans ~0–900 km north of origin.
const NV_FN = { NV_W: 4e6, NV_W94: 4e6, NV_C: 6e6, NV_E: 8e6 };
function guessUnits(rec, zone) {
  const fn = NV_FN[zone]; if (!fn || !rec.els || !rec.els.length) return null;
  const n = rec.els[0].s.y;
  if (n > fn - 3e5 && n < fn + 1.2e6) return 'm';
  const ft = fn / (1200 / 3937);
  if (n > ft - 1e6 && n < ft + 4e6) return 'ft';
  return null;
}
// Fix a record whose numbers don't match its unit label (e.g. metric values labeled feet)
function fixUnitLabel(rec, zone) {
  const g = guessUnits(rec, zone);
  if (g === 'm' && rec.units !== 'm') return { ...rec, units: 'm', srcUnits: 'm' };
  if (g === 'ft' && rec.units === 'm') return { ...rec, units: 'usft', srcUnits: 'usft' };
  return rec;
}
function convertAlign(rec, toUnits) {
  const from = rec.units || toUnits;
  if (from === toUnits) return { ...rec, units: toUnits };
  return { ...scaleAlign(rec, UNIT_M[from] / UNIT_M[toUnits]), units: toUnits, srcUnits: rec.srcUnits || from };
}

// ── geometry & projection (shared with Station / Offset, Station Photos, test forms) ──
const R2D = 180 / Math.PI;
const ELL = { a: 6378137, f: 1 / 298.257222101 };
ELL.e2 = ELL.f * (2 - ELL.f); ELL.e = Math.sqrt(ELL.e2); ELL.ep2 = ELL.e2 / (1 - ELL.e2);
const ZONES = {
  NV_E: { lat0: 34.75, lon0: -115.5833333333, k0: 0.9999, fe: 200000, fn: 8000000 },
  NV_C: { lat0: 34.75, lon0: -116.6666666667, k0: 0.9999, fe: 500000, fn: 6000000 },
  NV_W: { lat0: 34.75, lon0: -118.5833333333, k0: 0.9999, fe: 800000, fn: 4000000 },
  NV_W94: { lat0: 34.75, lon0: -118.5833333333, k0: 0.9999, fe: 800000, fn: 4000000 }, // NAD83/94 (HARN) — same projection, HARN datum adjustment
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
function tmInverse(E, N, p) {
  const x = E - p.fe, y = N - p.fn, e2 = ELL.e2, ep2 = ELL.ep2, a = ELL.a;
  const M = meridionalArc(p.lat0 * D2R) + y / p.k0;
  const mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s1 = Math.sin(phi1), c1 = Math.cos(phi1), t1 = Math.tan(phi1);
  const C1 = ep2 * c1 * c1, T1 = t1 * t1, N1 = a / Math.sqrt(1 - e2 * s1 * s1), R1 = a * (1 - e2) / Math.pow(1 - e2 * s1 * s1, 1.5), D = x / (N1 * p.k0);
  const lat = phi1 - (N1 * t1 / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = p.lon0 * D2R + (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c1;
  return { lat: lat * R2D, lon: lon * R2D };
}
function lccInverse(E, N, p) {
  const e = ELL.e, a = ELL.a;
  const m = f => Math.cos(f) / Math.sqrt(1 - ELL.e2 * Math.sin(f) ** 2);
  const t = f => Math.tan(Math.PI / 4 - f / 2) / Math.pow((1 - e * Math.sin(f)) / (1 + e * Math.sin(f)), e / 2);
  const p1 = p.lat1 * D2R, p2 = p.lat2 * D2R, p0 = p.lat0 * D2R;
  const n = Math.abs(p1 - p2) < 1e-10 ? Math.sin(p1) : (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * Math.pow(t(p1), n)), rho0 = a * F * Math.pow(t(p0), n);
  const x = E - p.fe, y = rho0 - (N - p.fn), rho = Math.sign(n) * Math.hypot(x, y), th = Math.atan2(Math.sign(n) * x, Math.sign(n) * y);
  const tt = Math.pow(rho / (a * F), 1 / n);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 10; i++) phi = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
  return { lat: phi * R2D, lon: (th / n) * R2D + p.lon0 };
}
function staRegions(al) {
  const eqs = al.eqs || [];
  const R = [{ from: -Infinity, to: eqs.length ? eqs[0].internal : Infinity, toInt: d => d, toDisp: i => i }];
  eqs.forEach((q, k) => R.push({ from: q.internal, to: k + 1 < eqs.length ? eqs[k + 1].internal : Infinity, toInt: d => q.internal + (d - q.ahead), toDisp: i => q.ahead + (i - q.internal) }));
  return R;
}
// Zones (Trimble Access style): zone 1 runs to the first equation, zone 2 to the next, …
// A station that repeats (overlapping equations) is written 119+00:3. "BK"/"AH" also accepted
// as input = first / last occurrence.  side: '' | 'BK' | 'AH' | '3'
// status: ok | ambiguous | gap | outside | badzone
function resolveSta(al, display, side) {
  const R = staRegions(al), ss = al.poly.ss, lo = ss[0] - 1e-6, hi = ss[ss.length - 1] + 1e-6;
  const cands = [];
  R.forEach((r, k) => { const i = r.toInt(display); if (i >= r.from - 1e-6 && i <= r.to + 1e-6 && i >= lo && i <= hi) cands.push({ i, zone: k + 1 }); });
  const zones = cands.map(c => c.zone);
  if (side && /^\d+$/.test(side)) {
    const z = cands.find(c => c.zone === +side);
    if (z) return { internal: z.i, status: 'ok', zones, zone: z.zone };
    if (cands.length) return { internal: cands[0].i, status: 'badzone', zones, zone: cands[0].zone, asked: +side };
  } else if (cands.length) {
    if (cands.length > 1) {
      const pick = side === 'AH' ? cands[cands.length - 1] : cands[0];
      return { internal: pick.i, status: side ? 'ok' : 'ambiguous', zones, zone: pick.zone };
    }
    return { internal: cands[0].i, status: 'ok', zones, zone: cands[0].zone };
  }
  for (const q of al.eqs || []) { const bk = isFinite(q.back) ? q.back : q.internal;
    if (q.ahead > bk && display > bk && display < q.ahead && q.internal >= lo && q.internal <= hi) return { internal: q.internal, status: 'gap', eq: q, zones: [] }; }
  const first = R[0], last = R[R.length - 1], iLast = last.toInt(display);
  return { internal: iLast > hi ? iLast : first.toInt(display), status: 'outside', zones: [] };
}
function internalSta(al, display, side) { return resolveSta(al, display, side).internal; }
function zoneOf(al, internal) { const R = staRegions(al); for (let k = R.length - 1; k >= 0; k--) if (internal >= R[k].from - 1e-6) return k + 1; return 1; }
// Zone tag only where the displayed station also exists elsewhere.
function staSide(al, internal) {
  if (!(al.eqs || []).length) return '';
  const r = resolveSta(al, displaySta(al, internal));
  return r.zones.length > 1 ? String(zoneOf(al, internal)) : '';
}
function fmtOff(off, units) {
  if (off == null || !isFinite(off)) return '—';
  const u = units === 'm' ? ' m' : "'";
  if (Math.abs(off) < 0.05) return '0.0' + u + ' CL';
  return Math.abs(off).toFixed(1) + u + (off > 0 ? ' RT' : ' LT');
}
// Parse "145+32.1", "14532.1", "119+00:3", "119+00 zone 3", "119+00 Z3", "145+32 AH" → { v, side }
function parseStaSide(t, units) {
  t = String(t ?? '').trim().replace(/^sta\.?\s*/i, '');
  let side = '', m2 = t.match(/\s*(?::|\(?\s*(?:zone|z)\s*)(\d+)\)?$/i);
  if (m2) { side = String(+m2[1]); t = t.slice(0, m2.index).trim(); }
  else if ((m2 = t.match(/\s*(ahead|back|ah|bk)\.?$/i))) { side = /^a/i.test(m2[1]) ? 'AH' : 'BK'; t = t.slice(0, m2.index).trim(); }
  if (!t) return { v: NaN, side };
  const neg = t.startsWith('-'); if (neg) t = t.slice(1);
  const m = t.match(/^(\d+)\+(\d+(?:\.\d*)?)$/);
  const v = m ? +m[1] * (units === 'm' ? 1000 : 100) + +m[2] : (/^\d*\.?\d+$/.test(t) ? parseFloat(t) : NaN);
  return { v: neg ? -v : v, side };
}
function parseSta(t, units) { return parseStaSide(t, units).v; }
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

// lat/lon → project N/E for a project's settings ps (grid → ground → check-in shift), in project units
function projectWith(ps, lat, lon) {
  const g = (ps.zone === 'TM') ? tmForward(lat, lon, ps.custom) : (ps.zone === 'LCC') ? lccForward(lat, lon, ps.custom) : tmForward(lat, lon, ZONES[ps.zone] || ZONES.NV_W);
  const u = UNIT_M[ps.units || 'usft'], cf = +ps.cf || 1, bN = +ps.baseN || 0, bE = +ps.baseE || 0;
  let N = g.N / u, E = g.E / u;
  N = bN + (N - bN) / cf; E = bE + (E - bE) / cf;
  return { N: N + (+ps.shiftN || 0), E: E + (+ps.shiftE || 0) };
}
// Where am I? Nearest (or locked) alignment of a project for a lat/lon → station/offset text, or null
const _polyCache = new Map();
async function locate(projId, lat, lon) {
  if (!projId || typeof ftGetSetting !== 'function') return null;
  const s = await ftGetSetting('ftStationing', null);
  const ps = Object.assign({ zone: 'NV_W', units: 'usft', cf: 1, baseN: 0, baseE: 0, shiftN: 0, shiftE: 0, lockId: '' }, (s && s.p && s.p[projId]) || {});
  const list = (await getForProject(projId)).filter(a => a.visible !== false);
  if (!list.length) return null;
  const p = projectWith(ps, lat, lon), u = ps.units;
  let best = null;
  for (const a0 of list) {
    const a = convertAlign(fixUnitLabel(a0, ps.zone), u);
    const key = a.id + ':' + a.imported + ':' + u;
    if (!_polyCache.has(key)) _polyCache.set(key, buildPolyline(a, u));
    a.poly = _polyCache.get(key);
    const r = stationOffset(a.poly, p.E, p.N); if (!r) continue;
    const score = (ps.lockId === a.id ? -1e9 : 0) + (r.inRange ? 0 : 1e6) + r.dist;
    if (!best || score < best.score) best = { a, r, score };
  }
  if (!best) return null;
  const { a, r } = best, disp = displaySta(a, r.sta);
  let zone = '';
  if ((a.eqs || []).length && resolveSta(a, disp).zones.length > 1) zone = String(zoneOf(a, r.sta));
  return { alignName: a.name, units: u, sta: disp, zone, staText: fmtSta(disp, u) + (zone ? ':' + zone : ''), off: r.off, offText: fmtOff(r.off, u),
    inRange: r.inRange, dist: r.dist, N: p.N, E: p.E };
}

async function getForProject(projId) { return (await apGetAll('alignments')).filter(a => a.projId === projId); }
// Import LandXML files into a project. Returns { added, errors[] }.
// opts.updateSettings: when the project has no alignments yet, set its units/zone in the shared stationing settings.
// toUnits: the project's working units (default US survey feet). Metric LandXML (as TBC often writes) is converted.
async function importFiles(projId, files, opts = {}) {
  const existing = await getForProject(projId);
  let toUnits = opts.units;
  if (!toUnits && typeof ftGetSetting === 'function') { const s = await ftGetSetting('ftStationing', null); toUnits = s && s.p && s.p[projId] && s.p[projId].units; }
  toUnits = toUnits || 'usft';
  let zone = opts.zone;
  if (!zone && typeof ftGetSetting === 'function') { const s = await ftGetSetting('ftStationing', null); zone = s && s.p && s.p[projId] && s.p[projId].zone; }
  zone = zone || 'NV_W';
  let added = 0, first = null, converted = ''; const errors = [];
  for (const f of files) {
    try {
      const res = parseLandXML(await f.text(), f.name);
      if (!first) first = res;
      for (const a of res.alignments) {
        let fileUnits = res.units || toUnits;
        const g = guessUnits({ els: a.els }, zone || res.csHint);
        if (g === 'm') fileUnits = 'm'; else if (g === 'ft' && fileUnits === 'm') fileUnits = 'usft';
        if (fileUnits !== toUnits) converted = fileUnits;
        const rec = convertAlign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8), projId, name: a.name, file: f.name, units: fileUnits, staStart: a.staStart, els: a.els, eqs: a.eqs, visible: true, imported: Date.now() }, toUnits);
        // same alignment name in this project = same alignment (re-exports often get new file names)
        const dups = existing.filter(x => x.name.trim().toLowerCase() === a.name.trim().toLowerCase());
        if (dups.length) { rec.id = dups[0].id; rec.visible = dups[0].visible; for (const d of dups.slice(1)) await apDel('alignments', d.id); }
        await apPut('alignments', rec); added++;
      }
    } catch (e) { errors.push(`${f.name}: ${e.message}`); }
  }
  if (opts.updateSettings && first && !existing.length && typeof ftGetSetting === 'function') {
    const s = (await ftGetSetting('ftStationing', null)) || { g: {}, p: {} };
    s.p = s.p || {};
    const ps = s.p[projId] || {};
    ps.units = ps.units || toUnits;
    if (first.csHint) ps.zone = first.csHint;
    s.p[projId] = ps;
    await ftSetSetting('ftStationing', s);
  }
  return { added, errors, converted, toUnits };
}
// Summary for lists: start/end display stations
function summarize(rec) {
  const poly = buildPolyline(rec, rec.units), ss = poly.ss;
  return { start: displaySta(rec, ss[0]), end: displaySta(rec, ss[ss.length - 1]), length: ss[ss.length - 1] - ss[0] };
}
// Change a project's working units: converts alignments and the saved settings (shift, base point, point list).
async function setProjectUnits(projId, units) {
  const s = (await ftGetSetting('ftStationing', null)) || { g: {}, p: {} };
  s.p = s.p || {}; const ps = s.p[projId] = s.p[projId] || {};
  const old = ps.units || 'usft';
  for (const a of await getForProject(projId)) await apPut('alignments', convertAlign(fixUnitLabel(a, ps.zone || 'NV_W'), units));
  if (old !== units) {
    const k = UNIT_M[old] / UNIT_M[units];
    ['shiftN', 'shiftE', 'baseN', 'baseE'].forEach(f => { if (isFinite(ps[f])) ps[f] *= k; });
    (ps.stakeList || []).concat(...(ps.stakeLists || []).map(l => l.points || [])).forEach(p => { p.sta *= k; p.off *= k; });
    if (ps.target) { ps.target.sta *= k; ps.target.off *= k; }
  }
  ps.units = units; await ftSetSetting('ftStationing', s);
}
async function deleteProjectData(projId) {
  for (const a of await getForProject(projId)) await apDel('alignments', a.id);
  for (const p of (await apGetAll('photos')).filter(p => p.projId === projId)) {
    await apDel('photos', p.id); await apDel('blobs', p.id + ':orig'); await apDel('blobs', p.id + ':stamp');
  }
}
window.FTAlign = { ELL, ZONES, fmtOff, internalSta, lccForward, lccInverse, meridionalArc, parseSta, parseStaSide, pointAt, resolveSta, staRegions, staSide, stationOffset, tmForward, tmInverse, zoneOf, projectWith, locate, UNIT_M, UNIT_NAME, scaleAlign, convertAlign, guessUnits, fixUnitLabel, setProjectUnits, apDB, apGetAll, apGet, apPut, apDel, parseLandXML, buildPolyline, displaySta, fmtSta, getForProject, importFiles, summarize, deleteProjectData };
})();
