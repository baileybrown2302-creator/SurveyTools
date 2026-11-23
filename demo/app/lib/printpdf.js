/* Field Tools — print a form, or make a PDF where printing isn't possible.
   iPhone/iPad home-screen apps ignore window.print(), so there the #printFrame layout is
   rendered to a letter-size PDF (jsPDF + html2canvas, loaded on demand) and handed to the
   iOS share sheet (Print, Save to Files, Mail, AirDrop…). Everywhere else: window.print().

   ftPrintForm({ frame: '#printFrame', filename: 'Soil test.pdf', margins: [top, side, bottom] (inches) }) */
(function () {
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const needsPdf = () => isIOS() && standalone();
  const base = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^/]*$/, '') : 'lib/';

  function loadScript(src) {
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  }
  async function libs() {
    if (!window.html2canvas) await loadScript('html2canvas.min.js');
    if (!(window.jspdf && window.jspdf.jsPDF)) await loadScript('jspdf.umd.min.js');
  }
  // Copy the page's @media print rules so the form can be laid out on screen
  function screenStyles() {
    if (document.getElementById('ftPdfStyles')) return;
    let css = '';
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules) if (r.media && /print/.test(r.media.mediaText))
        for (const inner of r.cssRules) {
          if (inner.type !== 1 || /body\s*>\s*\*/.test(inner.selectorText)) continue;
          const sel = inner.selectorText.split(',').map(x => x.trim()).map(x => x.startsWith('#printFrame') ? x.replace('#printFrame', '#printFrame.ft-pdf') : '#printFrame.ft-pdf ' + x).join(', ');
          css += sel + ' {' + inner.style.cssText + '}\n';
        }
    }
    const st = document.createElement('style'); st.id = 'ftPdfStyles'; st.textContent = css; document.head.appendChild(st);
  }
  function overlay(html) {
    let o = document.getElementById('ftPdfOverlay');
    if (!o) {
      o = document.createElement('div'); o.id = 'ftPdfOverlay';
      o.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;font-family:-apple-system,system-ui,sans-serif;';
      document.body.appendChild(o);
    }
    o.innerHTML = `<div style="background:#fff;color:#111;border-radius:16px;padding:20px;max-width:340px;width:100%;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)">${html}</div>`;
    return o;
  }
  const closeOverlay = () => { const o = document.getElementById('ftPdfOverlay'); if (o) o.remove(); };
  const btn = (id, txt, bg) => `<button id="${id}" style="display:block;width:100%;margin-top:10px;padding:13px;border:0;border-radius:10px;font-size:16px;font-weight:700;background:${bg};color:${bg === '#e5e7eb' ? '#111' : '#fff'}">${txt}</button>`;

  async function makePdf(frame, margins) {
    await libs(); screenStyles();
    const [mt, ms, mb] = margins, contentWin = 8.5 - 2 * ms, contentHin = 11 - mt - mb;
    const cls = frame.className, sty = frame.getAttribute('style') || '';
    frame.classList.add('ft-pdf');
    frame.style.cssText = `display:block;position:fixed;left:-20000px;top:0;width:${contentWin * 96}px;background:#fff;color:#000;`;
    try {
      if (document.fonts && document.fonts.ready) await document.fonts.ready;
      const canvas = await html2canvas(frame, { scale: 2.5, backgroundColor: '#ffffff', logging: false, windowWidth: Math.max(1024, contentWin * 96) });
      const { jsPDF } = window.jspdf, pdf = new jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait' });
      const pxPerIn = canvas.width / contentWin, pageHpx = Math.floor(contentHin * pxPerIn);
      for (let y = 0, page = 0; y < canvas.height; y += pageHpx, page++) {
        const h = Math.min(pageHpx, canvas.height - y), c = document.createElement('canvas');
        c.width = canvas.width; c.height = h; c.getContext('2d').drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
        if (page) pdf.addPage();
        pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', ms, mt, contentWin, h / pxPerIn);
      }
      return pdf.output('blob');
    } finally { frame.className = cls; if (sty) frame.setAttribute('style', sty); else frame.removeAttribute('style'); }
  }

  window.ftPrintForm = async function ({ frame = '#printFrame', filename = 'Form.pdf', margins = [0.5, 0.45, 0.4], forcePdf = false } = {}) {
    const el = typeof frame === 'string' ? document.querySelector(frame) : frame;
    if (!needsPdf() && !forcePdf) { window.print(); return; }
    overlay('<div style="font-weight:700;font-size:17px">Making PDF…</div><div style="color:#666;font-size:14px;margin-top:6px">One moment</div>');
    let blob;
    try { blob = await makePdf(el, margins); }
    catch (e) { overlay(`<div style="font-weight:700;font-size:17px">Couldn't make the PDF</div><div style="color:#666;font-size:14px;margin-top:6px">${String(e.message || e).replace(/</g, '&lt;')}</div>${btn('ftPdfClose', 'Close', '#e5e7eb')}`); document.getElementById('ftPdfClose').onclick = closeOverlay; return; }
    const name = filename.replace(/[\\/:*?"<>|]+/g, '-'), file = new File([blob], name, { type: 'application/pdf' });
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    // The share sheet needs a fresh tap, so show a button for it
    overlay(`<div style="font-size:34px">📄</div><div style="font-weight:700;font-size:17px;margin-top:4px">PDF ready</div>
      <div style="color:#666;font-size:13px;margin-top:4px;word-break:break-word">${name.replace(/</g, '&lt;')}</div>
      ${canShare ? btn('ftPdfShare', 'Print / Save / Share…', '#2563eb') : ''}${btn('ftPdfOpen', canShare ? 'Open PDF' : 'Open PDF to print or save', canShare ? '#64748b' : '#2563eb')}${btn('ftPdfClose', 'Close', '#e5e7eb')}`);
    if (canShare) document.getElementById('ftPdfShare').onclick = () => navigator.share({ files: [file], title: name }).then(closeOverlay).catch(() => {});
    document.getElementById('ftPdfOpen').onclick = () => { const url = URL.createObjectURL(blob); const w = window.open(url, '_blank'); if (!w) location.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); };
    document.getElementById('ftPdfClose').onclick = closeOverlay;
  };
})();
