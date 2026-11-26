/* Beta only: adds a sample project ("TEST – Beta Sample") the first time Beta is opened, so every tool has
   something to try. Beta keeps its own storage (see db.js FT_IS_BETA), so this never reaches the main app.
   ftBetaSeed(true) rebuilds the sample from scratch (Reset test project on the Beta home page).          */
const FT_BETA_PROJ = 'beta_test';
const FT_BETA_SEED_VER = '1';

async function ftBetaSeed(force) {
  if (typeof FT_IS_BETA === 'undefined' || !FT_IS_BETA) return false;
  const done = await ftGetSetting('betaSeed', null);
  if (done && !force) return false;
  if (!window.FTAlign) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'lib/alignments.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  const P = FT_BETA_PROJ, now = new Date().toISOString(), today = new Date().toLocaleDateString('en-CA');

  if (force) {   // clear the old sample first
    await ftDeleteControlPointsForProject(P);
    await FTAlign.deleteProjectData(P);
    await ftDeleteLoopsForProject(P);
    try { await ftDeleteBidContract('beta_test_bid'); } catch (e) {}
  }

  // Project
  await ftSaveProject({ id: P, projectNumber: '0000', name: 'TEST – Beta Sample', contractNumber: '0000', fundingSource: 'Sample',
    contractor: 'Sample Contractor', route: 'Carson City', location: 'Near the District I office', projectId: '', county: 'Carson City',
    designer: '', description: 'Sample data for trying Beta. Safe to edit or delete; Reset test project on the Beta home page puts it back.',
    archived: false, created: now });

  // Alignment, coordinate system and stakeout lists (Station / Offset, Station Photos)
  const xml = await fetch('lib/sample_alignment.xml', { cache: 'no-store' }).then(r => r.text());
  const s = await ftGetSetting('ftStationing', null) || { g: {}, p: {} };
  s.g = s.g || {}; s.p = s.p || {};
  s.p[P] = { zone: 'NV_W', units: 'usft', cf: 1 };
  if (!s.g.projId) s.g.projId = P;
  await ftSetSetting('ftStationing', s);
  await FTAlign.importFiles(P, [new File([xml], 'Sample_Alignment.xml', { type: 'application/xml' })], { units: 'usft', zone: 'NV_W', updateSettings: false });
  const al = (await FTAlign.getForProject(P))[0];
  const pt = (id, name, sta, off, desc) => ({ id, name, alignId: al.id, sta, side: '', off, desc, done: false });
  const s2 = await ftGetSetting('ftStationing', null), ps = s2.p[P];
  ps.stakeLists = [{ id: 'bl_struct', name: 'Structures' },
    { id: 'bl_util', name: 'Utilities', points: [pt('u1', 'WV-1', 1250, -12, 'Water valve box'), pt('u2', 'SSMH-2', 1900, 6, 'Sewer manhole rim'), pt('u3', 'PB-3', 2300, 28, 'Pull box')] }];
  ps.stakeListId = 'bl_struct';
  ps.stakeList = [pt('s1', 'MH-1', 1150, 0, 'Manhole rim'), pt('s2', 'DI-2', 1400, 18, 'Drop inlet grate'), pt('s3', 'SIGN-3', 1750, -20, 'Sign post'),
    pt('s4', 'LP-4', 2000, 22, 'Light pole base'), pt('s5', 'CB-5', 2350, -10, 'Catch basin')];
  ps.stakeActive = ''; ps.target = null;
  await ftSetSetting('ftStationing', s2);

  // Control points beside the alignment
  const poly = FTAlign.buildPolyline(al, 'usft');
  const cps = [['CP 101', 1100, 45, 4652.318, 'undisturbed', 'Rebar & cap'], ['CP 102', 1600, -40, 4655.902, 'disturbed', 'Cap bent, re-check'],
    ['CP 103', 2100, 50, 4649.477, 'undisturbed', 'Mag nail in curb'], ['CP 104', 2440, -35, 4651.064, 'missing', 'Not found'], ['BM-1', 1020, 30, 4650.000, 'undisturbed', 'Brass disk, loop benchmark']];
  for (const [name, sta, off, el, status, note] of cps) {
    const q = FTAlign.pointAt(poly, sta, off);
    await ftSaveControlPoint({ id: 'betacp-' + name.replace(/\W/g, ''), projectId: P, name, status, northing: +q.y.toFixed(3), easting: +q.x.toFixed(3),
      elevation: el, newStation: FTAlign.fmtSta(sta, 'usft'), distanceNew: Math.abs(off), note, statusDate: status === 'uncategorized' ? '' : today, created: now });
  }

  // Level loop: BM-1 → TP1 → TP2 → back to BM-1 (closes +0.003 ft)
  const rows = [], bm = 4650.000;
  rows.push({ id: 'bm-b1', pointName: 'BM-1', elevation: bm, type: 'BM', remarks: 'Starting Benchmark', pointCode: '', pointStadia: null, bsDist: null, fsDist: null, isVoid: false, isDiNiLineLeveling: false });
  const legs = [['BM-1', 5.123, 120, 'TP1', 3.456, 118], ['TP1', 4.210, 110, 'TP2', 6.012, 112], ['TP2', 5.980, 115, 'BM-1', 5.842, 117]];
  let elev = bm;
  legs.forEach(([from, bs, bsd, to, fs, fsd], i) => {
    const hi = +(elev + bs).toFixed(3), e = +(hi - fs).toFixed(3), closing = i === legs.length - 1;
    rows.push({ id: 'bs-b' + i, pointName: to, bs, hi, bsDist: bsd, fsDist: null, remarks: 'BS on ' + from, type: 'SETUP_BS', pointStadia: null, isVoid: false, isDiNiLineLeveling: false });
    rows.push({ id: 'fs-b' + i, pointName: to, uniqueTPName: to, fs, hi, elevation: e, fsDist: fsd, bsDist: null, remarks: 'FS for ' + to + (closing ? ' (Closing)' : ''),
      type: closing ? 'CLOSING_FS' : 'TP_FS', ...(closing ? { closingKnownElev: bm, runType: 'loop' } : {}), pointStadia: bsd - fsd, isVoid: false, isDiNiLineLeveling: false,
      bsOnPrevForM5: bs, hiFromBSForM5: hi, bsDistForM5: bsd, prevPointNameForM5: from, ipsForM5: [] });
    elev = e;
  });
  const lid = 'loop_beta_sample', mis = +(elev - bm).toFixed(3);
  await ftSaveLevelProject({ id: P, number: '0000', desc: 'TEST – Beta Sample', notes: '', created: Date.now(), archived: false,
    loops: [{ id: lid, name: 'Sample loop', date: today, operator: 'Sample', created: Date.now(), lastModified: Date.now(), closed: true, rowCount: rows.length, source: 'new' }] });
  await ftSaveLevelLoop({ id: lid, projectId: P, projectDetails: { units: 'ft', date: today, projectNumber: '0000', description: 'TEST – Beta Sample', operator: 'Sample',
    recorder: '', instrument: 'Sample level', rodType: 'Philly Rod', decimalPrecision: 3 }, levelRows: rows, tpCounter: 2, lastCalculatedElevation: elev, lastPointNameForBS: null,
    misclosureText: `${mis.toFixed(3)} (Calc: ${elev.toFixed(3)}, Known: ${bm.toFixed(3)})` });

  // Bid items contract
  const it = (bidItem, description, quantity, unitMeas, unitPrice) => ({ id: 'bi' + bidItem, bidItem, description, quantity, unitMeas, unitPrice, itemCost: +(quantity * unitPrice).toFixed(2), note: '' });
  await ftSaveBidContract({ id: 'beta_test_bid', created: Date.now(), contractNo: '0000', projectNo: 'TEST – Beta Sample', projectId: '', county: 'Carson City',
    location: 'Near the District I office', contractor: 'Sample Contractor', designer: '', note: '', breakouts: [
      { no: '01', description: 'ROADWAY (SAMPLE)', constructionType: '', fromStation: '10+00.00', toStation: '24+63.30', note: '', items: [
        it('2020285', 'REMOVAL OF CULVERT PIPE', 120, 'LINFT', 55), it('2030140', 'ROADWAY EXCAVATION', 2450, 'CUYD', 18.5),
        it('3020110', 'TYPE 1 CLASS B AGGREGATE BASE', 1820, 'TON', 32), it('4020170', 'PLANTMIX SURFACING (TYPE 2C) (WET)', 1340, 'TON', 98.75),
        it('6030170', '18-INCH REINFORCED CONCRETE PIPE, CLASS III', 240, 'LINFT', 84)] },
      { no: '02', description: 'TRAFFIC CONTROL & STRIPING (SAMPLE)', constructionType: '', fromStation: '10+00.00', toStation: '24+63.30', note: '', items: [
        it('6180100', 'CONSTRUCTION SIGNS', 1, 'LS', 12500), it('6340200', 'PAINTED PAVEMENT MARKING (4-INCH)', 9800, 'LINFT', 0.35),
        it('6270110', 'PERMANENT SIGNS', 64, 'SQFT', 42)] }] });

  await ftSetSetting('betaSeed', { v: FT_BETA_SEED_VER, at: Date.now() });
  return true;
}

// First visit to any Beta page: add the sample, then reload once so the page shows it.
(async () => {
  try { if (await ftBetaSeed(false) && !/index\.html$|\/beta\/$/.test(location.pathname)) location.reload(); } catch (e) { console.warn('[beta seed]', e); }
})();
