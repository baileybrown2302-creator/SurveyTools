/* ══════════════════════════════════════════════════════════════
   Field Tools — map view (Leaflet) for Station / Offset and Station Photos
   Streets / Satellite / Satellite + roads / Topo / Blank (works offline),
   alignments with station ticks, your position & heading, Navigate target,
   point-list markers and photo markers. Pan, pinch-zoom, follow-me, full screen.
   Requires lib/leaflet/leaflet.js and lib/stationing.js (gridToLL, aligns, pos, fix …).
   ══════════════════════════════════════════════════════════════ */
'use strict';
const FTMap = (() => {
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const esriAttr = 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics, USGS, and the GIS User Community';
  function makeBases() {
    const sat = () => L.tileLayer(ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: esriAttr });
    return {
      'Satellite + roads': L.layerGroup([sat(), L.tileLayer(ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22 }),
        L.tileLayer(ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22 })]),
      'Satellite': sat(),
      'Streets': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxNativeZoom: 19, maxZoom: 22, attribution: '&copy; OpenStreetMap contributors' }),
      'Topo': L.tileLayer(ESRI + 'World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxNativeZoom: 19, maxZoom: 22, attribution: esriAttr }),
      'Blank (offline)': L.layerGroup([]),
    };
  }
  const maps = new Map();
  const ll = (N, E) => { const r = gridToLL(N, E); return [r.lat, r.lon]; };
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function btn(html, title, onClick) {
    const C = L.Control.extend({ onAdd() {
      const b = L.DomUtil.create('a', 'ftmap-btn'); b.href = '#'; b.innerHTML = html; b.title = title;
      const wrap = L.DomUtil.create('div', 'leaflet-bar'); wrap.appendChild(b);
      L.DomEvent.on(b, 'click', e => { L.DomEvent.stop(e); onClick(b); }); L.DomEvent.disableClickPropagation(wrap);
      return wrap; } });
    return new C({ position: 'topleft' });
  }

  function create(el) {
    const m = L.map(el, { zoomControl: true, attributionControl: true, maxZoom: 22, zoomSnap: 0.5, tap: true });
    m.attributionControl.setPrefix('');
    const bases = makeBases(), want = (G.mapLayer && bases[G.mapLayer]) ? G.mapLayer : 'Satellite + roads';
    bases[want].addTo(m);
    L.control.layers(bases, null, { position: 'topright' }).addTo(m);
    m.on('baselayerchange', e => { G.mapLayer = e.name; saveSettings(); });
    L.control.scale({ imperial: true, metric: false, position: 'bottomleft' }).addTo(m);
    const st = { m, el, follow: true, alKey: '', alLayers: new Map(), tickLayer: L.layerGroup().addTo(m), alGroup: L.layerGroup().addTo(m),
      markGroup: L.layerGroup().addTo(m), photoGroup: L.layerGroup().addTo(m), tgtGroup: L.layerGroup().addTo(m), me: null, acc: null, lastTgtKey: '', fitted: false, opts: {} };
    btn('◎', 'Follow my position', b => { st.follow = true; b.parentNode.classList.add('on'); if (pos) m.setView(ll(pos.N, pos.E), Math.max(m.getZoom(), 17)); }).addTo(m);
    btn('⤢', 'Full screen', () => { el.classList.toggle('ftmap-full'); document.body.style.overflow = el.classList.contains('ftmap-full') ? 'hidden' : ''; setTimeout(() => m.invalidateSize(), 50); }).addTo(m);
    btn('⛶', 'Zoom to alignment', () => { st.follow = false; const b = alBounds(); if (b) m.fitBounds(b, { padding: [20, 20] }); }).addTo(m);
    m.on('dragstart', () => { st.follow = false; });
    m.on('zoomend moveend', () => drawTicks(st));
    // start somewhere sensible
    const b = alBounds(); if (b) m.fitBounds(b, { padding: [20, 20] }); else m.setView([39.16, -119.77], 10);
    return st;
  }
  function alBounds() {
    const pts = [];
    for (const a of aligns) { if (a.visible === false) continue; const [x0, y0, x1, y1] = a.poly.bbox; pts.push(ll(y0, x0), ll(y1, x1)); }
    return pts.length ? L.latLngBounds(pts) : null;
  }
  function alignKey() { const ps = PS(); return aligns.map(a => a.id + (a.visible === false ? 0 : 1)).join() + '|' + [ps.zone, ps.units, ps.cf, ps.baseN, ps.baseE, ps.shiftN, ps.shiftE, JSON.stringify(ps.custom)].join(); }
  function drawAligns(st) {
    st.alGroup.clearLayers(); st.alLayers.clear(); st.tickCache = {};
    for (const a of aligns) {
      if (a.visible === false) continue;
      const { xs, ys } = a.poly, pts = [];
      for (let i = 0; i < xs.length; i++) pts.push(ll(ys[i], xs[i]));
      const line = L.polyline(pts, { weight: 3, color: '#94a3b8', opacity: 0.95 }).bindTooltip(esc(a.name), { sticky: true });
      line.addTo(st.alGroup); st.alLayers.set(a.id, line);
    }
    st.hlId = null; drawTicks(st);
  }
  function highlight(st, al) {
    const id = al ? al.id : null; if (st.hlId === id) return;
    st.hlId = id;
    st.alLayers.forEach((l, k) => { l.setStyle(k === id ? { color: '#2563eb', weight: 5 } : { color: '#94a3b8', weight: 3 }); if (k === id) l.bringToFront(); });
    drawTicks(st);
  }
  // Station ticks on the highlighted alignment, spacing by zoom
  function drawTicks(st) {
    st.tickLayer.clearLayers();
    const al = aligns.find(a => a.id === st.hlId); if (!al) return;
    const z = st.m.getZoom(), u = unitsOf(al);
    const per = u === 'm' ? (z >= 17 ? 20 : z >= 15 ? 100 : z >= 13 ? 500 : 0) : (z >= 18 ? 50 : z >= 16 ? 100 : z >= 15 ? 500 : z >= 13 ? 1000 : 0);
    if (!per) return;
    const key = al.id + ':' + per + ':' + st.alKey;
    st.tickCache = st.tickCache || {};
    if (!st.tickCache[key]) {
      const out = [], { xs, ys, ss } = al.poly;
      for (let i = 0; i < xs.length - 1; i++) {
        const d0 = displaySta(al, ss[i]), d1 = displaySta(al, ss[i + 1]); if (d1 - d0 > per * 200) continue;
        for (let k = Math.ceil((d0 - 1e-6) / per) * per; k <= d1 + 1e-6 && k < d0 + per * 200; k += per) {
          const t = (k - d0) / ((d1 - d0) || 1), x = xs[i] + t * (xs[i + 1] - xs[i]), y = ys[i] + t * (ys[i + 1] - ys[i]);
          if (out.length && Math.abs(out[out.length - 1].k - k) < 1e-6 && Math.hypot(out[out.length - 1].x - x, out[out.length - 1].y - y) < 1) continue;
          const L2 = Math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i]) || 1;
          out.push({ k, x, y, nx: -(ys[i + 1] - ys[i]) / L2, ny: (xs[i + 1] - xs[i]) / L2, i: ss[i] + t * (ss[i + 1] - ss[i]) });
        }
      }
      st.tickCache[key] = out.map(o => {
        const tick = per * 0.0 + (u === 'm' ? 3 : 10) * (per >= 500 ? 2 : 1);
        return { a: ll(o.y + o.ny * tick, o.x + o.nx * tick), b: ll(o.y - o.ny * tick, o.x - o.nx * tick), lbl: fmtSta(o.k, u).replace(/\.\d+$/, '') + sideTxt(staSide(al, o.i)), at: ll(o.y, o.x) };
      });
    }
    const bounds = st.m.getBounds().pad(0.2);
    for (const t of st.tickCache[key]) {
      if (!bounds.contains(t.at)) continue;
      L.polyline([t.a, t.b], { color: '#2563eb', weight: 2, interactive: false }).addTo(st.tickLayer);
      L.marker(t.a, { interactive: false, icon: L.divIcon({ className: 'ftmap-sta', html: `<span>${t.lbl}</span>`, iconSize: [0, 0] }) }).addTo(st.tickLayer);
    }
  }
  function drawMe(st) {
    if (!pos || !fix) return;
    const p = ll(pos.N, pos.E), h = headingNow(), accFt = fix.acc / UNIT_M[PS().units];
    const html = `<div class="ftmap-me">${h != null ? `<div class="ftmap-cone" style="transform:rotate(${h}deg)"></div>` : ''}<div class="ftmap-dot"></div></div>`;
    if (!st.me) {
      st.acc = L.circle(p, { radius: fix.acc, color: '#3b82f6', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(st.m);
      st.me = L.marker(p, { icon: L.divIcon({ className: '', html, iconSize: [60, 60], iconAnchor: [30, 30] }), interactive: false, zIndexOffset: 1000 }).addTo(st.m);
      st.meHtml = html;
      if (st.follow) st.m.setView(p, Math.max(st.m.getZoom(), 17));
    } else {
      st.me.setLatLng(p); st.acc.setLatLng(p).setRadius(fix.acc);
      if (st.meHtml !== html) { st.me.setIcon(L.divIcon({ className: '', html, iconSize: [60, 60], iconAnchor: [30, 30] })); st.meHtml = html; }
      if (st.follow && !st.opts.target) st.m.panTo(p, { animate: false });
    }
    void accFt;
  }
  function drawTarget(st, opts) {
    st.tgtGroup.clearLayers();
    const t = opts.target; if (!t) { st.lastTgtKey = ''; return; }
    const tp = ll(t.y, t.x);
    L.marker(tp, { icon: L.divIcon({ className: 'ftmap-tgt', html: '✕', iconSize: [28, 28], iconAnchor: [14, 14] }), interactive: false, zIndexOffset: 900 }).addTo(st.tgtGroup);
    if (pos) L.polyline([ll(pos.N, pos.E), tp], { color: '#dc2626', weight: 2.5, dashArray: '8 6', interactive: false }).addTo(st.tgtGroup);
    const key = t.x.toFixed(2) + ',' + t.y.toFixed(2);
    if (key !== st.lastTgtKey) {   // new target: frame you + target once
      st.lastTgtKey = key;
      const b = L.latLngBounds([tp].concat(pos ? [ll(pos.N, pos.E)] : []));
      st.m.fitBounds(b.pad(0.25), { maxZoom: 19, animate: false });
    } else if (st.follow && pos) {
      const b = L.latLngBounds([tp, ll(pos.N, pos.E)]);
      if (!st.m.getBounds().contains(b)) st.m.fitBounds(b.pad(0.25), { maxZoom: 19, animate: false });
    }
  }
  function drawMarks(st, opts) {
    const marks = opts.marks || [], key = JSON.stringify(marks.map(m => [m.id, m.done, m.active, m.x.toFixed(1), m.y.toFixed(1)]));
    if (key === st.markKey) return; st.markKey = key;
    st.markGroup.clearLayers();
    for (const mk of marks) {
      if (mk.active) continue;
      L.circleMarker(ll(mk.y, mk.x), { radius: 7, color: '#fff', weight: 2, fillColor: mk.done ? '#16a34a' : '#f59e0b', fillOpacity: 1 })
        .bindTooltip(esc(mk.label || ''), { direction: 'top' })
        .on('click', () => opts.onMark && opts.onMark(mk.id)).addTo(st.markGroup);
    }
  }
  function drawPhotos(st, opts) {
    const ph = (opts.photos || []).filter(p => p.lat != null), key = ph.map(p => p.id).join();
    if (key === st.photoKey) return; st.photoKey = key;
    st.photoGroup.clearLayers();
    for (const p of ph) {
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: 'ftmap-photo', html: '📷', iconSize: [26, 26], iconAnchor: [13, 13] }) })
        .bindPopup(`<div style="width:170px"><img src="${p.thumb}" style="width:100%;border-radius:6px;display:block;margin-bottom:4px;"><b>${esc(p.name || (p.staText ? 'STA ' + p.staText : ''))}</b><br>${esc(p.staText ? p.staText + ' · ' + p.offText : '')}<br>${esc(p.desc || '')}</div>`)
        .addTo(st.photoGroup);
    }
  }
  let lastRun = 0, pending = null;
  function update(el, opts = {}) {
    if (!el || typeof L === 'undefined') return;
    if (!el.offsetParent && !el.classList.contains('ftmap-full')) return; // hidden tab
    let st = maps.get(el);
    if (!st) { st = create(el); maps.set(el, st); }
    if (st.wasHidden) { st.m.invalidateSize(); st.wasHidden = false; }
    st.opts = opts;
    const k = alignKey(); if (k !== st.alKey) { st.alKey = k; drawAligns(st); }
    highlight(st, opts.highlight || (current && current.al));
    // throttle the rest (~6 Hz)
    const now = Date.now();
    if (now - lastRun < 160) { clearTimeout(pending); pending = setTimeout(() => update(el, st.opts), 170); return; }
    lastRun = now;
    drawMe(st); drawTarget(st, opts); drawMarks(st, opts); drawPhotos(st, opts);
  }
  // Tabs hide maps; make them re-measure when shown again
  function hidden() { maps.forEach(st => { st.wasHidden = true; }); }
  return { update, hidden };
})();
