/* Field Tools — read NDOT plan-set Location Control sheets (window.FTPlans)

   • Control point tables ("CONSTRUCTION CONTROL" / "Alignment: L1 …" tables): name, N, E, elevation,
     old / new station + offset, note.
   • "PROJECT ALIGNMENT" listings (POT / PC / PT / P.I. / C.C. / R / Δ / L / T / bearings and station
     equations) → alignments in the same format as a LandXML import.
   • Text PDFs are read from their text layer; scanned PDFs with OCR (Tesseract), with a second
     number-only OCR pass on table columns.
   • Every result is checked: tangent lengths vs stations and bearings, curve radius / length, and each
     control point's station & offset against the built alignment. Common OCR misreads are corrected
     where the checks prove the fix, anything else is flagged.

   Pure parsing / geometry functions also run in Node for testing (module.exports). */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;

  // ═══════════════════════ PDF + OCR loading (browser) ═══════════════════════
  const BASE = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : 'lib/';
  const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('Could not load ' + src)); }; document.head.appendChild(s); });
  }
  async function loadPdfJs() {
    if (!window.pdfjsLib) {
      try { await loadScript(BASE + 'pdfjs/pdf.min.js'); window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(BASE + 'pdfjs/pdf.worker.min.js', location.href).href; }
      catch (e) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
    } else if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) window.pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(BASE + 'pdfjs/pdf.worker.min.js', location.href).href;
    return window.pdfjsLib;
  }
  async function loadTesseract() {
    if (!window.Tesseract) await loadScript(TESSERACT_CDN).catch(() => { throw new Error('Could not load the OCR engine \u2014 scanned plan sets need a connection the first time.'); });
    return window.Tesseract;
  }
  const noClip = ctx => new Proxy(ctx, { get(t, p) { if (p === 'clip') return () => {}; const v = t[p]; return typeof v === 'function' ? v.bind(t) : v; }, set(t, p, v) { t[p] = v; return true; } });

  // Text items in page points (rotation applied): { str, x0, x1, y (centre, top = 0), h, page }
  async function pageTextItems(pdfjs, page, pageNo) {
    const vp = page.getViewport({ scale: 1 }), tc = await page.getTextContent(), out = [];
    for (const it of tc.items) {
      const str = (it.str || '').replace(/\s+/g, ' ').trim(); if (!str) continue;
      const m = pdfjs.Util.transform(vp.transform, it.transform);
      const h = Math.hypot(m[2], m[3]) || 8;
      if (Math.abs(m[1]) > Math.abs(m[0]) * 0.2) continue;            // skip rotated (vertical) text
      const w = it.width ? it.width * (Math.hypot(m[0], m[1]) / Math.hypot(it.transform[0], it.transform[1]) || 1) : str.length * h * 0.55;
      out.push({ str, x0: m[4], x1: m[4] + w, y: m[5] - h * 0.35, h, page: pageNo });
    }
    return { items: out, w: vp.width, h: vp.height };
  }
  function textLooksUsable(items) {
    const s = items.map(i => i.str).join(' ');
    if (s.length < 80) return false;
    const good = (s.match(/[A-Za-z0-9.,+\-'" ]/g) || []).length / s.length;
    return good > 0.85 && /[A-Za-z]{4,}/.test(s);
  }

  // ── OCR page: full-page sparse pass, plus number-only passes on table columns ──
  class OcrPage {
    constructor(worker, canvas, scale, pageNo) { this.worker = worker; this.canvas = canvas; this.scale = scale; this.page = pageNo; }
    static async render(page, scale) {
      const vp = page.getViewport({ scale }), c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: noClip(ctx), viewport: vp }).promise;
      return c;
    }
    async words(rect, opts = {}) {
      await this.worker.setParameters({ tessedit_pageseg_mode: opts.psm || '11', tessedit_char_whitelist: opts.whitelist || '' });
      const src = rect ? this.crop(rect, opts.cleanLines) : this.canvas;
      const { data } = await this.worker.recognize(src);
      const ox = rect ? rect.x0 * this.scale : 0, oy = rect ? rect.y0 * this.scale : 0, s = this.scale;
      const words = (data.words || []).filter(w => w.text.trim()).map(w => ({ str: w.text.trim(), x0: (w.bbox.x0 + ox) / s, x1: (w.bbox.x1 + ox) / s, y: ((w.bbox.y0 + w.bbox.y1) / 2 + oy) / s, h: (w.bbox.y1 - w.bbox.y0) / s, conf: w.confidence, page: this.page }));
      const lines = (data.lines || []).filter(l => l.text.trim()).map(l => ({ text: l.text.trim(), x0: (l.bbox.x0 + ox) / s, x1: (l.bbox.x1 + ox) / s, y: ((l.bbox.y0 + l.bbox.y1) / 2 + oy) / s, h: (l.bbox.y1 - l.bbox.y0) / s }));
      return { words, lines };
    }
    // Crop (in points) to a new canvas; optionally erase long table rules so they aren't read as 1s
    crop(r, cleanLines) {
      const s = this.scale, x = Math.max(0, Math.floor(r.x0 * s)), y = Math.max(0, Math.floor(r.y0 * s));
      const w = Math.min(this.canvas.width - x, Math.ceil((r.x1 - r.x0) * s)), h = Math.min(this.canvas.height - y, Math.ceil((r.y1 - r.y0) * s));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const ctx = c.getContext('2d'); ctx.drawImage(this.canvas, x, y, w, h, 0, 0, w, h);
      if (cleanLines && w > 4 && h > 4) {
        const id = ctx.getImageData(0, 0, w, h), px = id.data, dark = i => px[i] + px[i + 1] + px[i + 2] < 384;
        // table rules = long unbroken dark runs (a column of "1"s is dark often, but never continuously)
        const white = i => { px[i] = px[i + 1] = px[i + 2] = 255; };
        for (let xx = 0; xx < w; xx++) { let run = 0, best = 0; for (let yy = 0; yy < h; yy++) { if (dark((yy * w + xx) * 4)) { if (++run > best) best = run; } else run = 0; } if (best > Math.max(40, h * 0.5)) for (let yy = 0; yy < h; yy++) white((yy * w + xx) * 4); }
        for (let yy = 0; yy < h; yy++) { let run = 0, best = 0; for (let xx = 0; xx < w; xx++) { if (dark((yy * w + xx) * 4)) { if (++run > best) best = run; } else run = 0; } if (best > Math.max(60, w * 0.6)) for (let xx = 0; xx < w; xx++) white((yy * w + xx) * 4); }
        ctx.putImageData(id, 0, 0);
      }
      return c;
    }
  }

  // ═══════════════════════ Layout helpers ═══════════════════════
  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
  function groupLines(items) {
    const hMed = median(items.map(i => i.h)) || 8;
    const its = [...items].sort((a, b) => a.y - b.y), lines = [];
    for (const it of its) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(it.y - last.y) <= hMed * 0.45) { last.items.push(it); last.y = (last.y * (last.items.length - 1) + it.y) / last.items.length; }
      else lines.push({ y: it.y, items: [it], page: it.page });
    }
    for (const l of lines) {
      l.items.sort((a, b) => a.x0 - b.x0);
      l.phrases = [];
      for (const it of l.items) {
        const ph = l.phrases[l.phrases.length - 1];
        if (ph && it.x0 - ph.x1 < Math.max(2.5, 0.62 * Math.max(ph.h, it.h))) { ph.str += (it.x0 - ph.x1 < 0.6 ? '' : ' ') + it.str; ph.x1 = Math.max(ph.x1, it.x1); }
        else l.phrases.push({ str: it.str, x0: it.x0, x1: it.x1, y: it.y, h: it.h });
      }
      l.text = l.phrases.map(p => p.str).join(' ');
      l.compact = l.text.replace(/\s+/g, '').toUpperCase();
    }
    return lines;
  }
  // Split multi-word phrases into words with estimated positions
  function wordsOf(phrases) {
    const out = [];
    for (const p of phrases) {
      const cw = (p.x1 - p.x0) / Math.max(1, p.str.length); let pos = 0;
      for (const w of p.str.split(/\s+/)) { if (!w) continue; const i = p.str.indexOf(w, pos); out.push({ w: w.toUpperCase(), x0: p.x0 + i * cw, x1: p.x0 + (i + w.length) * cw }); pos = i + w.length; }
    }
    return out;
  }

  // ═══════════════════════ Number / station parsing (with OCR fixes) ═══════════════════════
  const DASH = /[\u2012-\u2015\u2212\u2014\u2013_~]/g;
  const cleanNum = s => String(s ?? '').replace(DASH, '-').replace(/[,\s]/g, '').replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5');
  function num(s) { const m = cleanNum(s).match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; }
  // Station text → { align, sta, type, metric }.  Accepts "Le" 100+17.23 POC, L1 470+54.72, 21423.56 (lost +), 5144+49.51 (+ read as 4+)
  const TYPE_RX = /(P\.?\s?O\.?\s?T\.?|P\.?\s?O\.?\s?C\.?|P\.?\s?C\.?\s?C\.?|P\.?\s?R\.?\s?C\.?|P\.?\s?C\.?|P\.?\s?T\.?|A\.?\s?P\.?|P\.?\s?[Il1|]\.?(?!\d)|T\.?\s?S\.?|S\.?\s?C\.?|C\.?\s?S\.?|S\.?\s?T\.?|P\.?\s?O\.?\s?S\.?)/;
  const normType = t => { if (!t) return ''; const u = t.replace(/[.\s]/g, '').toUpperCase().replace(/^P[L1|!]$/, 'PI'); return u; };
  function staCandidates(raw) {
    const s = cleanNum(raw).replace(/[^\d.+-]/g, '');
    const out = [];
    let m = s.match(/^(\d{1,4})\+(\d{2}(?:\.\d+)?)$/);
    if (m) out.push(+m[1] * 100 + +m[2]);
    m = s.match(/^(\d{1,4})4\+(\d{2}(?:\.\d+)?)$/); if (m) out.push(+m[1] * 100 + +m[2]);           // '+' read as '4+'
    m = s.match(/^(\d{1,4})\+4?(\d{2}\.\d+)$/); if (m) out.push(+m[1] * 100 + +m[2]);
    m = s.match(/^(\d{1,4})[4+](\d{2}\.\d+)$/); if (m) out.push(+m[1] * 100 + +m[2]);              // '+' read as 4 / dropped
    m = s.match(/^(\d{1,4})(\d{2}\.\d+)$/); if (m) out.push(+(m[1] + m[2]));
    m = s.match(/^(\d{1,4})4(\d{2})(\d{2})$/); if (m) out.push(+m[1] * 100 + +(m[2] + '.' + m[3]));
    m = s.match(/^(\d{1,4})\+(\d{2})(\d{2})$/); if (m) out.push(+m[1] * 100 + +(m[2] + '.' + m[3]));            // decimal point lost
    return [...new Set(out.filter(isFinite))];
  }
  function parseStation(text) {
    if (!text) return null;
    const t = String(text).replace(DASH, '-').replace(/[“”″]/g, '"').replace(/[‘’′]/g, "'").trim();
    const m = t.match(/(\d[\d,]*\s*[+4]\s*\d{2}\s*[.,]?\s*\d{0,3}|\d{3,6}[.,]\d{2})\s*(m\b)?/);
    if (!m) return null;
    const cands = staCandidates(m[1].replace(/\s/g, '').replace(',', '.'));
    if (!cands.length) return null;
    const before = t.slice(0, m.index), nm = before.match(/([A-Za-z][A-Za-z0-9]{0,4})\W*$/);
    const rest = t.slice(m.index + m[0].length), ty = rest.match(TYPE_RX);
    return { align: nm ? nm[1] : '', sta: cands[0], cands, type: ty ? normType(ty[1]) : '', metric: !!m[2], raw: t };
  }
  const fmtStation = (v, decimals = 2) => { if (v == null || !isFinite(v)) return ''; const neg = v < 0, a = Math.abs(v), h = Math.floor(a / 100 + 1e-9); return (neg ? '-' : '') + h + '+' + (a - h * 100).toFixed(decimals).padStart(decimals + 3, '0'); };
  // Single-edit OCR variants of a coordinate string (confusable digits, dropped / extra digit)
  const CONFUSE = { 0: '869', 1: '74', 2: '7', 3: '58', 4: '19', 5: '369', 6: '580', 7: '12', 8: '3690', 9: '850' };
  function numVariants(raw, intDigits) {
    const s = cleanNum(raw).replace(/[^\d.-]/g, ''), out = new Set();
    const add = v => { const m = v.match(/^-?(\d+)\.(\d+)$/); if (m && (!intDigits || m[1].length === intDigits)) out.add(parseFloat(v)); };
    let base = s; if (!/\./.test(base) && intDigits && base.length > intDigits) base = base.slice(0, intDigits) + '.' + base.slice(intDigits);
    add(base);
    for (let i = 0; i < base.length; i++) {
      const c = base[i];
      if (CONFUSE[c]) for (const r of CONFUSE[c]) add(base.slice(0, i) + r + base.slice(i + 1));
      if (/\d/.test(c)) add(base.slice(0, i) + base.slice(i + 1));
    }
    for (let i = 0; i <= base.length; i++) for (const d of '0123456789') add(base.slice(0, i) + d + base.slice(i));
    return [...out];
  }

  // ═══════════════════════ Control point tables ═══════════════════════
  const HEAD = [
    [/^NAME$/, 'name'], [/^(NORTHING|NOR|THING|N0RTHING)$/, 'northing'], [/^EASTING$/, 'easting'], [/^(ELEVATION|ELEV\.?)$/, 'elevation'],
    [/^OLD$/, 'oldStation'], [/^EQUATION$/, 'equation'], [/^(DISTANCE|DIST)/, 'dist'], [/^NEW$/, 'newStation'], [/^(STATION|STA\.?)$/, 'station'],
    [/^(NOTE|NOTES|DESCRIPTION|REMARKS)$/, 'note']
  ];
  function headerColumns(line, below) {
    const words = wordsOf(line.phrases).concat(below ? wordsOf(below.phrases).map(w => ({ ...w, below: true })) : []);
    const cols = [];
    let nNotes = 0;
    for (const w of words.sort((a, b) => a.x0 - b.x0)) {
      const hit = HEAD.find(([rx]) => rx.test(w.w.replace(/[()'\u2019]/g, ''))); if (!hit) continue;
      let k = hit[1];
      if (k === 'northing' && cols.some(c => c.k === 'northing' && Math.abs(c.x1 - w.x0) < 30)) { const c = cols.find(c => c.k === 'northing'); c.x1 = w.x1; continue; }
      if (k === 'station') { const near = cols.find(c => (c.k === 'oldStation' || c.k === 'newStation') && Math.abs((c.x0 + c.x1) / 2 - (w.x0 + w.x1) / 2) < 45); if (near) { near.x1 = Math.max(near.x1, w.x1); continue; } }
      if (w.below && cols.some(c => Math.abs((c.x0 + c.x1) / 2 - (w.x0 + w.x1) / 2) < 30)) continue;   // second header line fills gaps only
      if (k === 'name' && cols.some(c => c.k === 'name')) { k = 'note' + (++nNotes); }
      if (k === 'note' && cols.some(c => c.k === 'note')) k = 'note' + (++nNotes);
      cols.push({ k, x0: w.x0, x1: w.x1 });
    }
    if (!cols.some(c => c.k === 'northing') || !cols.some(c => c.k === 'easting')) return null;
    // DISTANCE columns: the one after OLD STATION/EQUATION is the old offset, after NEW STATION the new
    let seenNew = false, seenOld = false;
    for (const c of cols.sort((a, b) => a.x0 - b.x0)) {
      if (c.k === 'newStation') seenNew = true; if (c.k === 'oldStation') seenOld = true;
      if (c.k === 'station') { c.k = seenOld ? 'newStation' : 'newStation'; seenNew = true; }
      if (c.k === 'dist') c.k = seenNew ? 'distanceNew' : seenOld ? 'distanceOld' : 'distanceNew';
    }
    cols.forEach((c, i) => { c.cx = (c.x0 + c.x1) / 2; });
    for (let i = 0; i < cols.length; i++) {
      cols[i].lo = i === 0 ? -Infinity : (cols[i - 1].x1 + cols[i].x0) / 2;
      cols[i].hi = i === cols.length - 1 ? Infinity : (cols[i].x1 + cols[i + 1].x0) / 2;
    }
    // Columns hold text that starts near the header's left edge; names start at the far left
    const nm = cols.find(c => c.k === 'name'); if (nm) nm.lo = -Infinity;
    return cols;
  }
  function cellsOf(line, cols) {
    const cells = {};
    for (const p of line.phrases) {
      let best = null, bestOv = -Infinity;
      for (const c of cols) { const ov = Math.min(p.x1, c.hi) - Math.max(p.x0, c.lo); const score = ov - Math.abs((p.x0 + p.x1) / 2 - c.cx) * 0.01; if (score > bestOv) { bestOv = score; best = c; } }
      if (!best) continue;
      // a phrase spanning a station + its type word stays together; text spilling into an empty EQUATION column goes back to the station
      let k = best.k;
      if (k === 'equation' && /\d+\+\d/.test(p.str) && !cells.oldStation) k = 'oldStation';
      cells[k] = cells[k] ? cells[k] + ' ' + p.str : p.str;
    }
    return cells;
  }
  const isNorthing = v => v != null && Math.abs(v) >= 100000;
  // Parse one page's lines into control points.
  // Name / N / E / elevation come from their header columns; everything to the right (old & new station,
  // equation, offsets, note) is read by content, because on some sheets those headers sit one column off.
  // refine(rect, whitelist) → OCR lines (scanned sheets: digits-only re-read of a column), optional
  async function parseControlTable(lines, opts = {}) {
    const pts = [], meta = {};
    let cols = null, label = '', headerBottom = 0;
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const al = l.text.match(/\bALIGNMENT\s*[:;]\s*["']?([A-Za-z0-9]{1,6})["']?\s*(.*)$/i);
      if (al) { label = al[1]; meta.labelText = (al[1] + ' ' + al[2]).trim(); continue; }
      if (/NORTHING/.test(l.compact) && /EASTING/.test(l.compact)) {
        const below = lines[i + 1] && lines[i + 1].y - l.y < (l.phrases[0].h || 8) * 2.6 && !/\d{5,}/.test(lines[i + 1].text) ? lines[i + 1] : null;
        const c = headerColumns(l, below); if (c) { cols = c; headerBottom = (below || l).y; if (below) i++; continue; }
      }
      if (!cols) continue;
      if (/STATE OF NEVADA|DEPARTMENT OF TRANSPORTATION/i.test(l.text)) break;
      const row = splitRow(l, cols);
      if (!row || !row.name || !isNorthing(num(row.northing)) || num(row.easting) == null || /NAME|NORTHING/i.test(row.name)) continue;
      rows.push({ y: l.y, ...row, label });
    }
    if (!cols || !rows.length) return { points: [], meta };
    if (opts.refine) {
      const yTop = headerBottom + 4, yBot = rows[rows.length - 1].y + 8, order = ['name', 'northing', 'easting', 'elevation'];
      const C = Object.fromEntries(order.map(k => [k, cols.find(c => c.k === k)]));
      const nextX = k => { const c = C[k]; const nx = cols.filter(x => x.x0 > c.x1 + 2).sort((a, b) => a.x0 - b.x0)[0]; return nx ? nx.x0 - 2 : c.x1 + 120; };
      const spec = { name: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-', northing: '0123456789.', easting: '0123456789.', elevation: '0123456789.' };
      const after = C.elevation || C.easting, rs = cols.filter(x => x.x0 > after.x1 + 2).sort((a, b) => a.x0 - b.x0)[0];
      const rightX0 = rs ? rs.x0 - 4 : after.x1 + 40, rightX1 = Math.max(...rows.flatMap(r => r.right.map(p => p.x1)), ...cols.map(c => c.x1)) + 30;
      try {
        const got = await opts.refine({ x0: rightX0, x1: rightX1, y0: yTop, y1: yBot }, '');
        for (const r of rows) {
          const g = got.filter(x => Math.abs(x.y - r.y) < 5).sort((a, b) => Math.abs(a.y - r.y) - Math.abs(b.y - r.y))[0];
          if (g && g.text.trim()) r.rightOcr = [{ str: g.text.trim(), x0: rightX0, x1: rightX1 }];
        }
      } catch (e) {}
      for (const k of order) {
        const c = C[k]; if (!c) continue;
        let got; try { got = await opts.refine({ x0: Math.max(0, c.x0 - 6), x1: nextX(k), y0: yTop, y1: yBot }, spec[k]); } catch (e) { continue; }
        for (const r of rows) {
          const g = got.filter(x => Math.abs(x.y - r.y) < 5).sort((a, b) => Math.abs(a.y - r.y) - Math.abs(b.y - r.y))[0];
          if (!g) continue;
          const t = g.text.replace(/\s+/g, '');
          if (k === 'name') { if (/^[A-Z0-9_-]{3,}$/.test(t) && t.length >= r.name.replace(/\s/g, '').length) r.name = t; }
          else if (/^\d+\.\d+$/.test(t)) {
            // a table rule read as a leading "1" (14775218.688 → 114775218.688)
            const want = k === 'northing' ? 8 : k === 'easting' ? 7 : 0, ip = t.split('.')[0];
            r[k] = want && ip.length === want + 1 && ip[0] === '1' && (r[k] || '').replace(/\D/g, '').length <= want + 3 ? t.slice(1) : t;
          }
        }
      }
    }
    for (const r of rows) {
      let right = parseRightPart(r.rightOcr || r.right, opts.unsureNames ? r.label : '');
      if (r.rightOcr) {
        const sparse = parseRightPart(r.right, r.label);
        if (!right.stations.length) right = sparse;
        else right.stations.forEach((st, i) => { const o = sparse.stations[i + sparse.stations.length - right.stations.length]; if (o && st.off == null) st.off = o.off; if (o) st.cands = [...new Set(st.cands.concat(o.cands))]; });
        if (!right.note && sparse.note) right.note = sparse.note;
      }
      const ns = right.stations.length ? right.stations[right.stations.length - 1] : null, os = right.stations.length > 1 ? right.stations[0] : null;
      if (ns && (!ns.align || opts.unsureNames) && r.label) ns.align = r.label;
      pts.push({
        name: r.name.replace(/\s+/g, ' ').replace(/^[^A-Za-z0-9]+/, ''),
        northingRaw: r.northing, eastingRaw: r.easting, northing: num(r.northing), easting: num(r.easting),
        elevation: num(r.elevation), elevSuffix: ((r.elevation || '').match(/\d([A-Za-z]{1,3})\s*$/) || [])[1] || '',
        oldSta: os, newSta: ns, distanceOld: os ? os.off : null, distanceNew: ns ? ns.off : null,
        equation: right.equation, note: right.note, label: r.label, page: opts.page
      });
    }
    return { points: pts, meta };
  }
  function splitRow(l, cols) {
    const C = k => cols.find(c => c.k === k);
    const n = C('northing'), e = C('easting'), z = C('elevation');
    if (!n || !e) return null;
    const after = z || e, rightStart = (() => { const nx = cols.filter(x => x.x0 > after.x1 + 2).sort((a, b) => a.x0 - b.x0)[0]; return nx ? nx.x0 - 4 : after.x1 + 40; })();
    const row = { name: '', northing: '', easting: '', elevation: '', right: [] };
    for (const p of l.phrases) {
      const cx = (p.x0 + p.x1) / 2;
      if (p.x1 < n.x0 - 3 || cx < n.x0 - 12) row.name += (row.name ? ' ' : '') + p.str;
      else if (cx < e.x0 - 6) row.northing += p.str;
      else if (!z || cx < z.x0 - 6) row.easting += p.str;
      else if (p.x0 < rightStart) {
        const m = p.str.match(/^\s*(-?[\d,]+(?:\.\d+)?\s*[A-Za-z]{0,3}\b)?\s*(.*)$/);
        if (m && m[1]) { row.elevation += m[1].replace(/\s+/g, ''); if (m[2]) row.right.push({ ...p, str: m[2] }); }
        else row.right.push(p);
      } else row.right.push(p);
    }
    // a phrase holding both numbers (tight text layer): split on whitespace
    if (!row.easting && /\s/.test(row.northing)) { const [a, b, c] = row.northing.split(/\s+/); row.northing = a; row.easting = b || ''; if (c && !row.elevation) row.elevation = c; }
    return row;
  }
  // "D" 427+76.24 PC   128.84   "X" 130+44.76 POT   -128.82   NHD BRASS DISC
  function parseRightPart(phrases, label) {
    const words = [];
    for (const p of phrases) for (const w of p.str.replace(/[“”″]/g, '"').replace(DASH, '-').split(/\s+/)) if (w) words.push(w);
    const stations = [], noteW = [];
    let pendingName = '', last = null, equation = '';
    for (let i = 0; i < words.length; i++) {
      const w = words[i], wc = w.replace(/^["'`]+|["'`]+$/g, '');
      if (/^\/?N?\/A$/i.test(w) || /^[|\[\]{}()]$/.test(w)) continue;
      const staLike = /\d[\d,]*[+]\d{2}/.test(w) || (/^\d{3,4}4\d{2}\.\d{2}$/.test(w)) || (!stations.length && /^\d{5,7}\.\d{2}$/.test(w) && !last && i < words.length - 1 && /^-?\d+(\.\d+)?$/.test(words[i + 1].replace(DASH, '-')));
      if (staLike) {
        const c = staCandidates(w.replace(/[^\d.+]/g, ''));
        if (c.length) { last = { align: pendingName, sta: c[0], cands: c, type: '', metric: /m$/.test(w), raw: (pendingName ? `"${pendingName}" ` : '') + w, off: null }; stations.push(last); pendingName = ''; continue; }
      }
      if (last && !last.type && new RegExp('^' + TYPE_RX.source + '$', 'i').test(w)) { last.type = normType(w); last.raw += ' ' + w; continue; }
      if (last && last.off == null && /^[-+]?\d+(\.\d+)?'?$/.test(w.replace(DASH, '-'))) { last.off = parseFloat(w.replace(DASH, '-')); continue; }
      if (!last || last.off != null) {
        if (/^["'`]?[A-Za-z][A-Za-z0-9]{0,3}["'`]?$/.test(w) && i + 1 < words.length && /\d[+4]\d|^\d{3,}/.test(words[i + 1]) && /["'`]/.test(w + (label ? '' : '"'))) { pendingName = wc; continue; }
      }
      if (last && last.off != null) noteW.push(w);
      else if (!last && /=/.test(w)) equation += w;
    }
    // text after the last station's offset is the note
    return { stations, note: noteW.join(' ').replace(/^[^A-Za-z0-9]+/, '').replace(/[|\[\]{}]+$/, '').trim(), equation };
  }

  // ═══════════════════════ Project alignment listings ═══════════════════════
  function parseBearing(t) {
    const m = t.replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'").match(/([NS])\s*(\d{1,3})\s*[\u00b0\u00ba*o]\s*(\d{1,2})\s*['\u2019]?\s*(\d{1,2}(?:\.\d+)?)?\s*["\u201d]?\s*([EW])\s*[-\u2013\u2014]?\s*([\d,.\s]+)'?/i);
    if (!m) return null;
    const ang = +m[2] + +m[3] / 60 + (+m[4] || 0) / 3600, ns = m[1].toUpperCase(), ew = m[5].toUpperCase();
    const az = ns === 'N' ? (ew === 'E' ? ang : 360 - ang) : (ew === 'E' ? 180 - ang : 180 + ang);
    return { az, dist: num(m[6]), text: m[0] };
  }
  function parseDMS(t) { const m = t.match(/(\d{1,3})\s*[\u00b0\u00ba*o]\s*(\d{1,2})\s*['\u2019]?\s*(\d{1,2}(?:\.\d+)?)?/); return m ? +m[1] + +m[2] / 60 + (+m[3] || 0) / 3600 : null; }
  // Northing / Easting pair at the end of a line (8-digit N, 7-digit E in Nevada State Plane feet).
  // OCR repairs: "2299937 504" / "2311810189" / "14756925 .559" → decimal point restored.
  function coordsOf(text) {
    const toks = String(text).replace(DASH, '-').split(/\s+/).filter(Boolean).map(t => t.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/,/g, ''));
    const nums = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i], nx = toks[i + 1] || '';
      let m;
      if ((m = t.match(/^(\d{6,8})\.?$/)) && /^\.?\d{2,4}$/.test(nx)) { nums.push(m[1] + '.' + nx.replace('.', '')); i++; continue; }
      if (/^\d{6,8}\.\d{2,4}$/.test(t)) { nums.push(t); continue; }
      if (/^\d{9,12}$/.test(t)) { nums.push(t.slice(0, -3) + '.' + t.slice(-3)); continue; }
      if ((m = t.match(/^(\d{6,8})\.(\d{2,4})\D+$/))) { nums.push(m[1] + '.' + m[2]); continue; }
    }
    if (nums.length < 2) return null;
    const n = nums[nums.length - 2], e = nums[nums.length - 1];
    return { N: parseFloat(n), E: parseFloat(e), nRaw: n, eRaw: e };
  }
  // Records in reading order across the alignment pages
  function parseAlignmentListing(lines, pageW) {
    // two columns ("ALIGNMENT" | "ALIGNMENT CONTINUED"): split where the second column's station labels start
    const staX = [];
    for (const l of lines) for (const p of l.phrases) if (/\d{1,4}\+\d\d/.test(p.str) || /^["'][A-Za-z0-9]{1,4}["']$/.test(p.str)) staX.push(p.x0);
    let split = Infinity;
    const cont = lines.find(l => /ALIGNMENT\s*CONT/i.test(l.text));
    if (staX.length) {
      const xs = [...staX].sort((a, b) => a - b); let gap = 0;
      for (let i = 1; i < xs.length; i++) if (xs[i] - xs[i - 1] > gap && xs[i] > (pageW || 1000) * 0.35) { gap = xs[i] - xs[i - 1]; if (gap > (pageW || 1000) * 0.2) split = xs[i] - 8; }
    }
    if (split === Infinity && cont) { const p = cont.phrases.find(p => /CONT/i.test(p.str)); if (p && p.x0 > (pageW || 1000) * 0.4) split = p.x0 - 160; }
    const colLines = [[], []];
    for (const l of lines) {
      const L = l.phrases.filter(p => p.x0 < split), R = l.phrases.filter(p => p.x0 >= split);
      if (L.length) colLines[0].push({ y: l.y, page: l.page, phrases: L, text: L.map(p => p.str).join(' ') });
      if (R.length) colLines[1].push({ y: l.y, page: l.page, phrases: R, text: R.map(p => p.str).join(' ') });
    }
    const recs = [];
    let started = false;
    for (const [ci, col] of colLines.entries()) {
      for (const l of col) {
        const t = l.text.replace(/[\u201c\u201d\u2033]/g, '"').replace(/[\u2018\u2019\u2032]/g, "'").replace(DASH, '-').trim();
        if (/^AL\s?IGNMENT(\s*CONT\w*)?$/i.test(t)) { started = true; continue; }
        if (/^(STATE OF NEVADA|DEPARTMENT OF|LOCATION CONTROL|PROJECT ALIGNMENT|ALIGNMENT(\s*CONT\w*)?$|STATE\b|NEVADA\b|Horz|LPN|MP\s|CONTRACT\s#|FROM\s|USING\s|\d{1,2}\/\d{1,2}\/\d{2,4})/i.test(t) && !/\d{1,4}\+\d\d.*(P\.?O\.?T|P\.?C|P\.?T)/.test(t)) continue;
        let m;
        if (/\d\+\d\d.*\bto\s+["'`]?\s*[A-Za-z0-9]{1,5}\s*["'`]?\s+\d/i.test(t)) continue;      // title: "Le" 100+00.00 POT to "Le" 326+72.48 PT
        // station record:  "Le"  100+00.00  P.O.T.  =  (note)   N   E
        if ((m = t.match(/^(?:["'`]?\s*([A-Za-z][A-Za-z0-9]{0,4}|\d[A-Za-z0-9]{0,3}(?=["'`]))\s*["'`]?\s*)?(\d{1,4}\s*[+4]?\s*\d{2}\s*[.,]?\s*\d{1,3})\s*(m)?\s*(P\.?\s?O\.?\s?T\.?|P\.?\s?O\.?\s?C\.?|P\.?\s?C\.?\s?C\.?|P\.?\s?R\.?\s?C\.?|P\.?\s?C\.?|P\.?\s?T\.?|A\.?\s?P\.?|P\.?\s?[Il1|]\.?(?!\d)|T\.?\s?S\.?|S\.?\s?C\.?|C\.?\s?S\.?|S\.?\s?T\.?|P\.?\s?O\.?\s?S\.?|P\.(?=\s))?\s*(=)?(.*)$/i)) && (m[4] || coordsOf(m[6] || ''))) {
          const staRaw = m[2].replace(/\s/g, '').replace(',', '.'), cands = staCandidates(staRaw);
          const rest = m[6] || '', co = coordsOf(rest);
          const eq = !!m[5] || /^\s*=/.test(rest) || /\s=\s*$/.test(rest);
          recs.push({ k: 'pt', name: (m[1] || '').trim(), sta: cands[0], cands, metric: !!m[3], type: normType(m[4]), eq, N: co ? co.N : null, E: co ? co.E : null, nRaw: co ? co.nRaw : null, eRaw: co ? co.eRaw : null, note: rest.replace(/[\d.\s]{9,}.*$/, '').replace(/^=?\s*/, '').trim(), raw: t, page: l.page, col: ci });
          started = true; continue;
        }
        if (!started) continue;
        if ((m = t.match(/^(P\.?\s?I\.?|PIL?|Pl|P1)\b(.*)$/i))) { const co = coordsOf(m[2]); if (co) recs.push({ k: 'PI', N: co.N, E: co.E }); continue; }
        if ((m = t.match(/^(C\.?\s?C\.?|CC)\b(.*)$/i))) { const co = coordsOf(m[2]); if (co) recs.push({ k: 'CC', N: co.N, E: co.E }); continue; }
        if ((m = t.match(/^R\s*=+\s*([\d,.\s]+)/i))) { recs.push({ k: 'R', v: num(m[1]) }); continue; }
        if ((m = t.match(/^(D|\u0394|A|\u2206|DELTA)\s*=+\s*(.*)$/i)) && /\u00b0|\u00ba|\*/.test(m[2] || '')) { recs.push({ k: 'D', v: parseDMS(m[2]), dir: /\bR(t|T|ight)?\b/.test(m[2]) ? 'R' : /\bL(t|T|eft)?\b/.test(m[2]) ? 'L' : '' }); continue; }
        if ((m = t.match(/^L\s*=+\s*([\d,.\s]+)/i))) { recs.push({ k: 'L', v: num(m[1]) }); continue; }
        if ((m = t.match(/^T\s*=+\s*([\d,.\s]+)/i))) { recs.push({ k: 'T', v: num(m[1]) }); continue; }
        if ((m = t.match(/^(LS|Ls)\s*=+\s*([\d,.\s]+)/i))) { recs.push({ k: 'LS', v: num(m[2]) }); continue; }
        const b = parseBearing(t); if (b) { recs.push({ k: 'brg', az: b.az, dist: b.dist }); continue; }
      }
    }
    return recs;
  }

  // ── Geometry helpers (x = E, y = N) ──
  const azOf = (a, b) => (Math.atan2(b.E - a.E, b.N - a.N) * R2D + 360) % 360;
  const dist = (a, b) => Math.hypot(b.E - a.E, b.N - a.N);
  const angDiff = (a, b) => { let d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };
  function arcInfo(s, e, c, dir) {
    const R = (dist(s, c) + dist(e, c)) / 2;
    const a0 = Math.atan2(s.N - c.N, s.E - c.E), a1 = Math.atan2(e.N - c.N, e.E - c.E);
    let d = a1 - a0;
    if (dir === 'R') { while (d >= 0) d -= 2 * Math.PI; while (d < -2 * Math.PI) d += 2 * Math.PI; } else { while (d <= 0) d += 2 * Math.PI; while (d > 2 * Math.PI) d -= 2 * Math.PI; }
    return { R, len: R * Math.abs(d), sweep: d };
  }
  function centerFrom(s, e, R, dir) {
    const L = dist(s, e), c = L / 2; if (!(R > c)) return null;
    const ux = (e.E - s.E) / L, uy = (e.N - s.N) / L, h = Math.sqrt(R * R - c * c);
    const nx = dir === 'R' ? uy : -uy, ny = dir === 'R' ? -ux : ux;          // right turn: centre on the right of the chord
    return { E: (s.E + e.E) / 2 + nx * h, N: (s.N + e.N) / 2 + ny * h };
  }

  // Build alignments from listing records.  namesReliable: text PDFs (names like "Le"); OCR names are guesses.
  function buildAlignments(recs, opts = {}) {
    const namesReliable = opts.namesReliable !== false, tolSta = opts.tolerance || 0.25;
    // group consecutive "=" records (one physical point) with their data records
    const groups = [];
    let cur = null;
    for (const r of recs) {
      if (r.k === 'pt') {
        // "=" joins the next line into the same point — but never across sheets / columns
        const lastL = cur && cur.lines[cur.lines.length - 1];
        const samePlace = cur && lastL.page === r.page && lastL.col === r.col && !cur.data.length;
        const joins = cur && lastL.page === r.page && lastL.col === r.col && (cur.open || (samePlace && (r.N == null || cur.lines.every(l => l.N == null))));
        if (joins) { cur.lines.push(r); cur.open = r.eq; continue; }
        cur = { lines: [r], data: [], open: r.eq }; groups.push(cur);
      } else if (cur) { cur.open = false; cur.data.push(r); }
    }
    for (const g of groups) {
      const c = g.lines.find(l => l.N != null && !l.metric) || g.lines.find(l => l.N != null);
      g.N = c ? c.N : null; g.E = c ? c.E : null; g.coordLine = c || null;
      const d = k => { const x = g.data.filter(r => r.k === k); return x.length ? x[x.length - 1] : null; };
      g.R = d('R'); g.D = d('D'); g.PI = d('PI'); g.CC = d('CC'); g.L = d('L'); g.T = d('T'); g.brg = d('brg'); g.LS = d('LS');
    }
    // names with more than one located point are alignments; others are references (old lines, side roads)
    const count = {};
    for (const g of groups) for (const l of g.lines) if (l.N != null && l.name && !l.metric) count[l.name] = (count[l.name] || 0) + 1;
    const isMain = n => n && count[n] >= 2;
    const chains = [];
    let ch = null;
    const issues = [];
    const startChain = (g, line) => {
      ch = { name: namesReliable && line && line.name ? line.name : (opts.defaultName || 'Alignment') + (chains.length ? ' ' + (chains.length + 1) : ''), pts: [], eqs: [], issues: [], segs: [] };
      chains.push(ch);
      ch.pts.push({ g, sta: line ? line.sta : g.lines[g.lines.length - 1].sta, type: line ? line.type : g.lines[g.lines.length - 1].type, N: g.N, E: g.E });
      ch.internal = ch.pts[0].sta; ch.staStart = ch.pts[0].sta; ch.disp = ch.pts[0].sta;
    };
    // OCR: a misread digit in a point's coordinates — the tangent bearing & distance from the previous point say where it is
    function repairCoords(prev, g, chain) {
      const b = prev.g.brg; if (!b || b.dist == null || chain.curve && /^(PC|PCC|PRC|POC)$/.test(prev.type)) return;
      if (/^(PC|PCC|PRC)$/.test(prev.type) && prev.g.R) return;
      const pN = prev.N + b.dist * Math.cos(b.az * D2R), pE = prev.E + b.dist * Math.sin(b.az * D2R);
      if (Math.hypot(pN - g.N, pE - g.E) < 0.2) return;
      const l = g.coordLine; if (!l) return;
      const nV = numVariants(l.nRaw || String(g.N), 8).filter(v => Math.abs(v - pN) < 0.2), eV = numVariants(l.eRaw || String(g.E), 7).filter(v => Math.abs(v - pE) < 0.2);
      if (nV.length === 1 && eV.length === 1) { chain.issues.push({ at: fmtStation(l.sta), fixed: true, msg: `Coordinates read as ${g.N} / ${g.E}, corrected to ${nV[0]} / ${eV[0]} (match the bearing & distance)` }); g.N = nV[0]; g.E = eV[0]; }
    }
    // check: stationing vs geometry; returns the station as read (OCR: the candidate that fits)
    function addCheck(line, expected, seg) {
      const readBack = line.cands ? line.cands.reduce((b, c) => Math.abs(c - expected) < Math.abs(b - expected) ? c : b, line.sta) : line.sta;
      const dSta = readBack - expected;
      if (Math.abs(dSta) > tolSta) ch.issues.push({ at: fmtStation(readBack), msg: `Station ${fmtStation(readBack)} is ${dSta > 0 ? '+' : ''}${dSta.toFixed(2)} ft from the length measured along the alignment (${fmtStation(expected)})` });
      seg.issues.forEach(m => ch.issues.push({ at: fmtStation(readBack), msg: m }));
      return readBack;
    }
    let lastLocated = null;
    for (const g of groups) {
      // a listed point without coordinates (side-road tie, old line): a bearing after it continues the same tangent
      if (g.N == null && g.brg && lastLocated && lastLocated.brg && angDiff(lastLocated.brg.az, g.brg.az) < 0.01) lastLocated.brg = { ...lastLocated.brg, dist: (lastLocated.brg.dist || 0) + (g.brg.dist || 0) };
      if (g.N != null) lastLocated = g;
      if (g.N == null) {             // reference-only record (e.g. a side road tie without coordinates) ends the current chain only if it names another alignment
        continue;
      }
      if (!ch) { const line = namesReliable ? (g.lines.find(l => isMain(l.name)) || g.coordLine) : g.lines[g.lines.length - 1]; startChain(g, line); continue; }
      const prev = ch.pts[ch.pts.length - 1];
      // the same point listed again (e.g. repeated at the top of the next sheet)
      if (dist(prev, g) < 0.02 && g.lines.some(l => l.name === ch.name || !namesReliable)) {
        const other = namesReliable && g.lines.find(l => isMain(l.name) && l.name !== ch.name && !chains.some(c => c.name === l.name));
        if (other) startChain(g, other);
        else if (g.data.length && !prev.g.data.length) prev.g = g;
        continue;
      }
      if (!namesReliable) repairCoords(prev, g, ch);
      const seg = segmentBetween(ch, prev, g);
      // OCR: decide a pending equation now — the station ahead is the one the next point's station continues from
      if (ch.pending) {
        const P = ch.pending; ch.pending = null;
        let best = P.back, bestD = Infinity;
        for (const alt of P.alts) for (const l of g.lines) for (const c of l.cands) { const d = Math.abs(c - (alt + seg.len)); if (d < bestD - 1e-6 || (Math.abs(d - bestD) < 1e-6 && alt === P.back)) { bestD = d; best = alt; } }
        if (Math.abs(best - P.back) > 0.005 && bestD < 2) { ch.eqs.push({ internal: P.internal, back: P.back, ahead: best }); ch.disp = best; }
      }
      const expected = ch.disp + seg.len;
      let back = null, ahead = null;
      if (namesReliable) {
        const same = g.lines.filter(l => l.name === ch.name && !l.metric);
        const other = g.lines.find(l => isMain(l.name) && l.name !== ch.name && !chains.some(c => c.name === l.name));
        if (same.length && other) {
          // this alignment ends here and another starts (e.g. "Le" 326+72.48 PT = "X" 100+00.00 POT)
          const sb = same[0];
          addCheck(sb, expected, seg);
          ch.pts.push({ g, sta: sb.sta, type: sb.type, N: g.N, E: g.E, seg }); ch.internal += seg.len; ch.disp = expected;
          startChain(g, other); continue;
        }
        if (same.length) { back = same[0]; ahead = same[same.length - 1]; }
        else {
          // a point that doesn't name this alignment but names another one: that alignment starts here
          const other2 = other || g.lines.find(l => isMain(l.name) && l.name !== ch.name && l.N != null);
          if (other2) { startChain(g, other2); continue; }
          back = ahead = g.coordLine || g.lines[0];
        }
      } else {
        // OCR: the line whose station continues the chain is the back station; the last line is the station ahead
        let bestL = null, bestD = Infinity;
        for (const l of g.lines) for (const c of l.cands) { const d = Math.abs(c - expected); if (d < bestD) { bestD = d; bestL = { l, c }; } }
        if (g.lines.length > 1 && (!bestL || bestD > Math.max(2, seg.len * 0.02))) { startChain(g, g.lines[g.lines.length - 1]); continue; }
        back = bestL ? { ...bestL.l, sta: bestL.c } : g.lines[0]; ahead = back;
        if (g.lines.length > 1) ch.pendingAlts = [...new Set(g.lines.filter(l => !l.metric).flatMap(l => l.cands).filter(c => isFinite(c)))];
      }
      const readBack = addCheck(back, expected, seg);
      ch.pts.push({ g, sta: readBack, type: back.type, N: g.N, E: g.E, seg });
      ch.internal += seg.len; ch.disp = expected;
      if (ch.pendingAlts) { ch.pending = { internal: ch.internal, back: expected, alts: ch.pendingAlts.concat([expected]) }; ch.pendingAlts = null; }
      // station equation: same alignment, different station ahead
      const aheadSta = ahead && ahead !== back ? ahead.sta : null;
      if (aheadSta != null && Math.abs(aheadSta - readBack) > 0.005) { ch.eqs.push({ internal: ch.internal, back: readBack, ahead: aheadSta }); ch.disp = aheadSta; }
    }
    // to FTAlign elements
    const out = [];
    for (const c of chains) {
      if (c.pts.length < 2) continue;
      const els = [];
      for (let i = 1; i < c.pts.length; i++) {
        const a = c.pts[i - 1], b = c.pts[i], s = c.pts[i].seg;
        const S = { x: a.E, y: a.N }, E = { x: b.E, y: b.N };
        if (s.arc) els.push({ t: 'C', sta: null, s: S, e: E, c: { x: s.arc.c.E, y: s.arc.c.N }, rot: s.arc.dir === 'R' ? 'cw' : 'ccw' });
        else els.push({ t: 'L', sta: null, s: S, e: E });
      }
      // equations are relative to internal stationing that starts at the first station
      const eqs = c.eqs.map(q => ({ internal: q.internal, back: q.back, ahead: q.ahead }));
      out.push({ name: c.name, staStart: c.staStart, els, eqs, issues: c.issues, points: c.pts.length, length: c.internal - c.staStart, start: c.staStart, end: c.disp });
    }
    return out;
  }
  // Geometry for one piece: line, or arc when a curve is running (PC … PT, POC inside, PCC / PRC)
  function segmentBetween(ch, prev, g) {
    const a = prev, b = { N: g.N, E: g.E }, issues = [];
    const startsCurve = /^(PC|PCC|PRC)$/.test(a.type) && a.g.R;
    const inCurve = ch.curve && (/^(POC|POS)$/.test(a.type));
    let curve = null;
    if (startsCurve) {
      const ag = a.g, dir = ag.D && ag.D.dir ? ag.D.dir : '';
      curve = { R: ag.R.v, D: ag.D ? ag.D.v : null, dir, CC: ag.CC ? { N: ag.CC.N, E: ag.CC.E } : null, L: ag.L ? ag.L.v : null };
      ch.curve = curve;
    } else if (inCurve) curve = ch.curve;
    else ch.curve = null;
    if (curve) {
      let c = curve.CC, dir = curve.dir;
      // trust the centre point if it is R from both ends; else rebuild it from R and the turn direction
      if (c && Math.abs(dist(a, c) - curve.R) < 0.5) {
        const cross = (b.E - a.E) * (c.N - a.N) - (b.N - a.N) * (c.E - a.E);   // >0: centre on the left \u2192 left turn
        const geoDir = cross > 0 ? 'L' : 'R';
        if (dir && dir !== geoDir && dist(a, b) > 1) issues.push('Curve direction (Rt/Lt) disagrees with the centre point \u2014 used the centre point');
        dir = geoDir;
      } else {
        if (c) issues.push(`Curve centre point is ${(dist(a, c) - curve.R).toFixed(2)} ft off the radius \u2014 rebuilt from R`);
        if (!dir) { dir = 'R'; issues.push('Curve direction not read \u2014 assumed right'); }
        c = centerFrom(a, b, curve.R, dir);
        if (!c) { issues.push('Curve could not be built (chord longer than the diameter) \u2014 drawn straight'); ch.curve = null; return { len: dist(a, b), arc: null, issues }; }
      }
      const info = arcInfo(a, b, c, dir);
      if (Math.abs(dist(b, c) - curve.R) > 0.5) issues.push(`Curve end point is ${(dist(b, c) - curve.R).toFixed(2)} ft off the radius`);
      if (/^(PT|PCC|PRC)$/.test(g.lines[0].type) || g.lines.some(l => l.type === 'PT')) { if (curve.L && Math.abs(info.len - curve.L) > 0.3 && startsCurve) issues.push(`Curve length ${info.len.toFixed(2)} ft vs L = ${curve.L.toFixed(2)} ft on the sheet`); }
      if (g.lines.some(l => /^(PT|POT)$/.test(l.type))) ch.curve = null;
      return { len: info.len, arc: { c, dir }, issues };
    }
    const len = dist(a, b);
    const bg = a.g.brg || prev.g && prev.g.brg;
    if (a.g.brg) {
      if (a.g.brg.dist != null && Math.abs(a.g.brg.dist - len) > 0.15) issues.push(`Tangent length ${len.toFixed(2)} ft vs ${a.g.brg.dist.toFixed(2)} ft on the sheet`);
      if (len > 5 && angDiff(azOf(a, b), a.g.brg.az) > 0.01) issues.push(`Bearing differs from the sheet by ${(angDiff(azOf(a, b), a.g.brg.az) * 3600).toFixed(0)}"`);
    }
    return { len, arc: null, issues };
  }

  // ═══════════════════════ Checking control points against alignments ═══════════════════════
  // FT: FTAlign (for buildPolyline / stationOffset / pointAt). Returns per-point { dSta, dOff, fixed }
  function checkPoints(points, aligns, FT) {
    if (!aligns.length || !FT) return { offsetSign: 1 };
    const built = aligns.map(a => { const rec = { ...a, units: 'usft' }; rec.poly = FT.buildPolyline(rec, 'usft'); return rec; });
    const disp = (a, i) => { let d = i; for (const q of a.eqs || []) if (i >= q.internal - 1e-6) d = q.ahead + (i - q.internal); return d; };
    const internals = (a, d) => { const out = []; FT.staRegions(a).forEach(r => { const i = r.toInt(d); if (i >= r.from - 1e-6 && i <= r.to + 1e-6 && i >= a.poly.ss[0] - 0.5 && i <= a.poly.ss[a.poly.ss.length - 1] + 0.5) out.push(i); }); return out; };
    const byName = n => n && built.find(b => b.name.toLowerCase() === String(n).toLowerCase());
    const nearest = p => { let best = null; for (const b of built) { const r = FT.stationOffset(b.poly, p.easting, p.northing); if (r && r.inRange && (!best || r.dist < best.r.dist)) best = { b, r }; } return best && best.b; };
    // How far the sheet's station & offset land from the point's coordinates (best station candidate / equation zone)
    function landing(b, p, sgn) {
      const s = p.newSta, off = p.distanceNew; let best = null;
      for (const c of (s.cands && s.cands.length ? s.cands : [s.sta])) for (const ii of internals(b, c)) {
        const q = FT.pointAt(b.poly, ii, sgn * (off || 0)), d = Math.hypot(q.x - p.easting, q.y - p.northing);
        if (!best || d < best.d) best = { d, c, ii, q };
      }
      return best;
    }
    const usable = points.filter(p => p.newSta && p.newSta.sta != null && p.distanceNew != null && p.northing != null && p.easting != null);
    usable.forEach(p => { p._b = byName(p.newSta.align) || (built.length === 1 ? built[0] : null) || nearest(p); });
    // sign convention for offsets (NDOT sheets: right +, left −) — confirm from the data
    let plus = 0, minus = 0;
    for (const p of usable) { if (!p._b || Math.abs(p.distanceNew) < 1) continue; const a = landing(p._b, p, 1), b = landing(p._b, p, -1); if (a && a.d < 0.5) plus++; if (b && b.d < 0.5) minus++; }
    const sgn = minus > plus ? -1 : 1;
    for (const p of points) {
      const b = p._b; delete p._b;
      if (!p.newSta) { p.check = { status: 'nosta' }; continue; }
      if (b && p.distanceNew == null && p.northing != null && p.easting != null) {
        // offset not read: if the station agrees with the coordinates, fill the offset in from them (flagged)
        const r0 = FT.stationOffset(b.poly, p.easting, p.northing), cs = r0 ? disp(b, r0.sta) : null;
        const c0 = r0 && (p.newSta.cands || [p.newSta.sta]).find(c => Math.abs(c - cs) <= 0.15);
        if (c0 != null) { p.distanceNew = Math.round(sgn * r0.off * 100) / 100; p.newSta.sta = c0; p.check = { status: 'fixed', miss: 0, align: b.name, fix: `Offset not read \u2014 filled in from the coordinates (${p.distanceNew})` }; continue; }
      }
      if (!b || p.distanceNew == null || p.northing == null || p.easting == null) { p.check = { status: 'nocheck' }; continue; }
      const s = p.newSta, L = landing(b, p, sgn);
      if (L && L.d <= 0.15) {
        p.check = { status: L.c !== s.sta ? 'fixed' : 'ok', miss: L.d, align: b.name };
        if (L.c !== s.sta) { p.check.fix = `Station read as ${fmtStation(s.sta)}, corrected to ${fmtStation(L.c)}`; s.sta = L.c; }
        continue;
      }
      // a misread northing / easting: the station & offset say where the point must be
      if (L) {
        const nV = numVariants(p.northingRaw ?? String(p.northing), 8), eV = numVariants(p.eastingRaw ?? String(p.easting), 7);
        const offs = [p.distanceNew].concat(numVariants(String(Math.abs(p.distanceNew)), 0).flatMap(v => [v, -v]));
        const hits = [];
        for (const c of (s.cands && s.cands.length ? s.cands : [s.sta])) for (const ii of internals(b, c)) for (const o of offs) {
          const q = FT.pointAt(b.poly, ii, sgn * o);
          const nOk = nV.filter(v => Math.abs(v - q.y) < 0.15), eOk = eV.filter(v => Math.abs(v - q.x) < 0.15);
          if (nOk.length === 1 && eOk.length === 1) hits.push({ N: nOk[0], E: eOk[0], c, o });
        }
        // prefer the reading that changes least: as-read offset and station first
        hits.sort((x, y) => (x.o !== p.distanceNew) - (y.o !== p.distanceNew) || (x.c !== s.sta) - (y.c !== s.sta));
        const uniq = [...new Map(hits.map(h => [h.N + '/' + h.E, h])).values()];
        const asRead = [...new Map(hits.filter(h => h.o === p.distanceNew).map(h => [h.N + '/' + h.E, h])).values()];
        if (uniq.length === 1 || asRead.length === 1) {
          const h = hits[0], was = `${p.northing ?? '?'} / ${p.easting ?? '?'}`, msgs = [];
          if (h.N !== p.northing || h.E !== p.easting) msgs.push(`coordinates read as ${was}, corrected to ${h.N} / ${h.E}`);
          if (h.c !== s.sta) msgs.push(`station read as ${fmtStation(s.sta)}, corrected to ${fmtStation(h.c)}`);
          if (h.o !== p.distanceNew) msgs.push(`offset read as ${p.distanceNew}, corrected to ${h.o}`);
          p.northing = h.N; p.easting = h.E; s.sta = h.c; p.distanceNew = h.o;
          p.check = { status: msgs.length ? 'fixed' : 'ok', miss: 0, align: b.name, fix: msgs.length ? msgs.join('; ').replace(/^./, c => c.toUpperCase()) + ' \u2014 checked against the alignment' : '' };
          continue;
        }
      }
      // where the coordinates actually fall on the alignment
      const r = FT.stationOffset(b.poly, p.easting, p.northing);
      const calcSta = r ? disp(b, r.sta) : null, calcOff = r ? sgn * r.off : null;
      // a misread offset (station agrees)
      if (r && Math.abs(calcSta - s.sta) <= 0.15) {
        const oV = numVariants(String(Math.abs(p.distanceNew)), 0).flatMap(v => [v, -v]);
        const good = oV.filter(v => Math.abs(v - calcOff) <= 0.15);
        if (good.length) { p.check = { status: 'fixed', miss: 0, align: b.name, fix: `Offset read as ${p.distanceNew}, corrected to ${good[0]}` }; p.distanceNew = good[0]; continue; }
      }
      p.check = { status: 'mismatch', miss: L ? L.d : null, align: b.name, calc: r ? `${fmtStation(calcSta)} ${calcOff >= 0 ? '' : ''}${calcOff.toFixed(2)}` : '' };
    }
    return { offsetSign: sgn };
  }

  // ═══════════════════════ Page classification ═══════════════════════
  function classify(lines) {
    const all = lines.map(l => l.compact).join(' ');
    const control = /NORTHING/.test(all) && /EASTING/.test(all) && (/NAME/.test(all) || /CONSTRUCTIONCONTROL|LOCATIONCONTROL/.test(all));
    const staRecs = lines.filter(l => /\d{1,4}\+\d\d\.\d.*(P\.?O\.?T|P\.?C|P\.?T|P\.?O\.?C)/i.test(l.text)).length;
    const alignment = (/PROJECTALIGNMENT|ALIGNMENTCONTINUED/.test(all) && staRecs >= 2) || staRecs >= 6 && /C\.?C\./.test(lines.map(l => l.text).join(' '));
    return { control, alignment, locationControl: /LOCATIONCONTROL/.test(all) };
  }
  function sheetInfo(lines) {
    const t = lines.map(l => l.text).join(' ');
    const zone = /83\s*\/?\s*94/.test(t) ? 'NAD83/94' : /NAD\s*83/i.test(t) ? 'NAD83' : '';
    const z = /WEST\s*ZONE/i.test(t) ? 'West' : /CENTRAL\s*ZONE/i.test(t) ? 'Central' : /EAST\s*ZONE/i.test(t) ? 'East' : '';
    const gf = (t.match(/g\s*\(\s*f\s*\)\s*=+\s*(0?\.\d{4,})/i) || t.match(/GRID\s*FACTOR\s*OF\s*(0?\.\d{4,})/i) || [])[1];
    return { datum: zone, zone: z, gridFactor: gf ? parseFloat(gf.startsWith('.') ? '0' + gf : gf) : null };
  }

  // ═══════════════════════ Browser driver ═══════════════════════
  // scan(pdf, { pages?, onStatus, ocr: 'auto' | 'never' }) → { textPdf, pages:[{page, kind}], ... }
  async function findPages(pdf, onStatus) {
    const pdfjs = await loadPdfJs(), found = [];
    let textPages = 0;
    for (let p = 1; p <= pdf.numPages; p++) {
      if (p % 10 === 1 && onStatus) onStatus(`Looking for Location Control sheets\u2026 page ${p} of ${pdf.numPages}`);
      const page = await pdf.getPage(p), { items } = await pageTextItems(pdfjs, page, p);
      if (!textLooksUsable(items)) continue;
      textPages++;
      const c = classify(groupLines(items));
      if (c.control || c.alignment) found.push({ page: p, control: c.control, alignment: c.alignment });
    }
    return { pages: found, scanned: textPages < pdf.numPages * 0.3 };
  }
  // Slow search for scanned sets: OCR the bottom-right title block of every page for "LOCATION CONTROL"
  async function findPagesOCR(pdf, onStatus, cancel) {
    const T = await loadTesseract(), worker = await T.createWorker('eng', 1);
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    const found = [];
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancel && cancel()) break;
        if (onStatus) onStatus(`Searching scanned pages\u2026 ${p} of ${pdf.numPages}${found.length ? ` \u00b7 found ${found.map(f => f.page).join(', ')}` : ''}`);
        const page = await pdf.getPage(p), vp = page.getViewport({ scale: 1 }), sc = 1.6;
        const c = await OcrPage.render(page, sc), op = new OcrPage(worker, c, sc, p);
        const { words } = await worker.recognize(op.crop({ x0: vp.width * 0.72, x1: vp.width, y0: vp.height * 0.72, y1: vp.height })).then(r => ({ words: r.data.words || [] }));
        const t = words.map(w => w.text).join(' ').toUpperCase().replace(/\s+/g, '');
        if (/LOCATIONCONTROL|LOCATI0NCONTROL|OCATIONCONTR/.test(t)) found.push({ page: p });
        c.width = c.height = 0;
      }
    } finally { await worker.terminate(); }
    return found;
  }
  async function readPages(pdf, pageNos, onStatus, opts = {}) {
    const pdfjs = await loadPdfJs();
    let worker = null, usedOCR = false;
    const controlPts = [], recs = [], infoLines = [], labels = new Set(), warnings = [];
    try {
      for (const [n, p] of pageNos.entries()) {
        onStatus && onStatus(`Reading page ${p} (${n + 1} of ${pageNos.length})\u2026`);
        const page = await pdf.getPage(p), tx = await pageTextItems(pdfjs, page, p);
        let lines, refine = null, cleanup = null;
        if (textLooksUsable(tx.items)) lines = groupLines(tx.items);
        else {
          usedOCR = true;
          if (!worker) { onStatus && onStatus('Loading OCR engine\u2026 (first use downloads ~10 MB)'); const T = await loadTesseract(); worker = await T.createWorker('eng', 1); }
          onStatus && onStatus(`Reading page ${p} with OCR (${n + 1} of ${pageNos.length})\u2026 this takes a while`);
          const scale = 3.6, canvas = await OcrPage.render(page, scale), op = new OcrPage(worker, canvas, scale, p);
          const { words } = await op.words(null, { psm: '11' });
          lines = groupLines(words);
          refine = async (rect, wl) => (await op.words(rect, { psm: '6', whitelist: wl, cleanLines: true })).lines;
          cleanup = () => { canvas.width = canvas.height = 0; };
        }
        infoLines.push(...lines.slice(0, 40));
        if (opts.debug) opts.debug.push({ page: p, lines: lines.map(l => l.text) });
        const kind = classify(lines);
        if (kind.control) {
          const { points, meta } = await parseControlTable(lines, { refine, page: p, unsureNames: !!refine });
          points.forEach(pt => controlPts.push(pt)); if (meta.labelText) labels.add(meta.labelText);
        }
        if (kind.alignment) recs.push(...parseAlignmentListing(lines.map(l => ({ ...l, page: p })), tx.w).map(r => ({ ...r, page: p })));
        if (!kind.control && !kind.alignment) warnings.push(`Page ${p}: no control table or alignment listing found`);
        if (cleanup) cleanup();
      }
    } finally { if (worker) await worker.terminate(); }
    const lbl = [...labels][0] || '';
    const aligns = buildAlignments(recs, { namesReliable: !usedOCR, defaultName: lbl ? lbl.split(/\s+/)[0] : 'Alignment' });
    const sign = checkPoints(controlPts, aligns, root.FTAlign);
    return { points: controlPts, alignments: aligns, usedOCR, info: sheetInfo(infoLines), warnings, offsetSign: sign.offsetSign };
  }

  const api = { loadPdfJs, findPages, findPagesOCR, readPages, groupLines, parseControlTable, parseAlignmentListing, buildAlignments, checkPoints, parseStation, staCandidates, fmtStation, numVariants, classify, sheetInfo, coordsOf, parseBearing };
  root.FTPlans = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
