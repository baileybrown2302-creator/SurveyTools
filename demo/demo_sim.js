// Field Tools DEMO — simulated GPS + compass for desktop demonstrations.
// Loaded first on every page of demo/app/. The position and heading come from the demo
// shell (demo/index.html → window.FTDemoSim); opened on its own, the page uses the last
// saved demo position. Real sensors are ignored.
(function () {
  'use strict';
  const shell = () => { try { return window.parent !== window && window.parent.FTDemoSim ? window.parent.FTDemoSim : null; } catch (e) { return null; } };
  const FALLBACK = { lat: 39.1620, lon: -119.7666, hdg: 270, acc: 1.2 };
  function state() {
    const s = shell(); if (s) return s.state;
    try { return JSON.parse(localStorage.getItem('ftDemoPos')) || FALLBACK; } catch (e) { return FALLBACK; }
  }

  // ── GPS ──
  const watchers = new Map(); let nextId = 0;
  const makePos = () => { const s = state(); return {
    coords: { latitude: s.lat, longitude: s.lon, accuracy: s.acc || 1.2, altitude: 1420, altitudeAccuracy: 3, heading: null, speed: null },
    timestamp: Date.now() }; };
  const geo = {
    getCurrentPosition(ok) { setTimeout(() => ok(makePos()), 250); },
    watchPosition(ok) { const id = ++nextId; watchers.set(id, ok); setTimeout(() => { if (watchers.has(id)) ok(makePos()); }, 150); return id; },
    clearWatch(id) { watchers.delete(id); }
  };
  try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch (e) {}

  // ── Compass ──
  if (typeof DeviceOrientationEvent !== 'undefined') { try { DeviceOrientationEvent.requestPermission = () => Promise.resolve('granted'); } catch (e) {} }
  ['deviceorientation', 'deviceorientationabsolute'].forEach(t =>
    window.addEventListener(t, e => { if (e.isTrusted) e.stopImmediatePropagation(); }, true));   // ignore a real laptop sensor
  function orient(trueHdg) {
    const decl = (typeof G !== 'undefined' && G && +G.decl) || 0;          // the app adds declination back on
    const mag = ((trueHdg - decl) % 360 + 360) % 360;
    const a = new Event('deviceorientationabsolute');
    Object.assign(a, { alpha: (360 - mag) % 360, beta: 90, gamma: 0, absolute: true });   // phone held upright
    window.dispatchEvent(a);
    const b = new Event('deviceorientation');
    Object.assign(b, { alpha: (360 - mag) % 360, beta: 90, gamma: 0, absolute: false, webkitCompassHeading: mag });
    window.dispatchEvent(b);
  }

  let lastKey = '';
  setInterval(() => {
    const s = state(), key = s.lat.toFixed(9) + ',' + s.lon.toFixed(9);
    if (key !== lastKey) { lastKey = key; const p = makePos(); watchers.forEach(fn => { try { fn(p); } catch (e) { console.error(e); } }); }
    orient(s.hdg || 0);
  }, 100);

  // ── Arrow keys inside the phone go to the demo controls ──
  window.addEventListener('keydown', e => {
    const s = shell(); if (!s || !/^Arrow/.test(e.key)) return;
    if (e.target && e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault(); e.stopPropagation(); s.key(e.key, e.shiftKey);
  }, true);

  // ── Camera: on a desktop, "take" a sample photo of the scene in the direction you're facing ──
  document.addEventListener('click', e => {
    const t = e.target;
    if (!t || t.tagName !== 'INPUT' || t.type !== 'file' || !t.hasAttribute('capture')) return;
    e.preventDefault();
    samplePhoto(state().hdg || 0).then(file => {
      const dt = new DataTransfer(); dt.items.add(file); t.files = dt.files;
      t.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }, true);

  function samplePhoto(hdg) {
    const W = 1600, H = 1200, c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'), horizon = H * 0.52;
    let gr = g.createLinearGradient(0, 0, 0, horizon); gr.addColorStop(0, '#5f9fd6'); gr.addColorStop(1, '#cfe3f2');
    g.fillStyle = gr; g.fillRect(0, 0, W, horizon);
    const ridge = (az, f) => Math.sin(az * f * Math.PI / 180) * 0.5 + Math.sin(az * f * 2.7 * Math.PI / 180 + 1.3) * 0.3 + Math.sin(az * f * 6.1 * Math.PI / 180 + 4) * 0.2;
    [[3, '#8d9fb2', 170, 0.9], [5, '#6f7f68', 95, 0.55]].forEach(([f, col, amp, base]) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(0, horizon);
      for (let x = 0; x <= W; x += 8) { const az = hdg - 30 + 60 * x / W; g.lineTo(x, horizon - amp * base - amp * 0.5 * ridge(az, f)); }
      g.lineTo(W, horizon); g.closePath(); g.fill();
    });
    gr = g.createLinearGradient(0, horizon, 0, H); gr.addColorStop(0, '#b9a684'); gr.addColorStop(1, '#8a7558');
    g.fillStyle = gr; g.fillRect(0, horizon, W, H - horizon);
    g.fillStyle = '#3d3f42'; g.beginPath(); g.moveTo(W * 0.47, horizon); g.lineTo(W * 0.53, horizon); g.lineTo(W * 0.95, H); g.lineTo(W * 0.05, H); g.closePath(); g.fill();
    g.strokeStyle = '#e8c547'; g.lineWidth = 6; g.setLineDash([60, 50]); g.beginPath(); g.moveTo(W / 2, horizon + 6); g.lineTo(W / 2, H); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#f2f2f2'; g.lineWidth = 8;
    [[0.47, 0.06], [0.53, 0.94]].forEach(([a, b]) => { g.beginPath(); g.moveTo(W * a, horizon); g.lineTo(W * b, H); g.stroke(); });
    g.fillStyle = 'rgba(255,255,255,0.85)'; g.font = 'bold 44px system-ui, sans-serif'; g.textAlign = 'right';
    g.fillText('DEMO PHOTO', W - 40, 70);
    return new Promise(res => c.toBlob(b => res(new File([b], 'IMG_' + Date.now() + '.jpg', { type: 'image/jpeg', lastModified: Date.now() })), 'image/jpeg', 0.9));
  }
})();
