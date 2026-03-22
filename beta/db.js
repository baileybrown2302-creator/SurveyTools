// db.js — Field Tools IndexedDB layer
'use strict';

const FT_DB_NAME = 'FieldToolsDB';
const FT_DB_VERSION = 6;
let _dbPromise = null;

function ftOpenDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(FT_DB_NAME, FT_DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // Key-value settings
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      // Unified project registry
      if (!db.objectStoreNames.contains('projects')) {
        const s = db.createObjectStore('projects', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
      // Leveling project metadata (separate from main registry for compat)
      if (!db.objectStoreNames.contains('levelProjects')) {
        db.createObjectStore('levelProjects', { keyPath: 'id' });
      }
      // Each leveling loop stored separately
      if (!db.objectStoreNames.contains('levelLoops')) {
        const s = db.createObjectStore('levelLoops', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      // Slope stake sessions
      if (!db.objectStoreNames.contains('stakeSessions')) {
        const s = db.createObjectStore('stakeSessions', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      // Slope stake templates (global, not per-project)
      if (!db.objectStoreNames.contains('stakeTemplates')) {
        db.createObjectStore('stakeTemplates', { keyPath: 'id' });
      }
      // Defined stakes list
      if (!db.objectStoreNames.contains('stakesList')) {
        const s = db.createObjectStore('stakesList', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      // Stake ranges
      if (!db.objectStoreNames.contains('stakeRanges')) {
        const s = db.createObjectStore('stakeRanges', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
      }
      // Materials data — one record per contract/project
      if (!db.objectStoreNames.contains('materials')) {
        db.createObjectStore('materials', { keyPath: 'id' });
      }
      // Grade calc history (up to 15 entries)
      if (!db.objectStoreNames.contains('gradeHistory')) {
        db.createObjectStore('gradeHistory', { keyPath: 'id' });
      }
      // Area totals
      if (!db.objectStoreNames.contains('areaTotals')) {
        db.createObjectStore('areaTotals', { keyPath: 'id' });
      }
      // Current stake session context (navigation state)
      if (!db.objectStoreNames.contains('stakeContext')) {
        db.createObjectStore('stakeContext');
      }
      // Thinlift Compaction Tests (T335)
      if (!db.objectStoreNames.contains('compactionTests')) {
        const s = db.createObjectStore('compactionTests', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('created', 'created');
      }
      // Soil Compaction Tests (T103G) — NDOT 040-047
      if (!db.objectStoreNames.contains('soilTests')) {
        const s = db.createObjectStore('soilTests', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('created', 'created');
      }
      // Control Point Projects
      if (!db.objectStoreNames.contains('controlProjects')) {
        const s = db.createObjectStore('controlProjects', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
      // Control Points
      if (!db.objectStoreNames.contains('controlPoints')) {
        const s = db.createObjectStore('controlPoints', { keyPath: 'id' });
        s.createIndex('projectId', 'projectId');
        s.createIndex('status', 'status');
      }
      // Bid Estimate contracts (Agreement Estimate PDF imports)
      if (!db.objectStoreNames.contains('bidContracts')) {
        const s = db.createObjectStore('bidContracts', { keyPath: 'id' });
        s.createIndex('created', 'created');
      }
    };
    req.onsuccess = e => {
      const db = e.target.result;
      // Allow future version upgrades to proceed without being blocked
      db.onversionchange = () => { db.close(); _dbPromise = null; };
      resolve(db);
    };
    req.onerror = e => { _dbPromise = null; reject(e.target.error); };
    req.onblocked = () => { _dbPromise = null; reject(new Error('DB blocked — close other tabs and reload.')); };
  });
  return _dbPromise;
}

// --- Low-level helpers ---
async function ftGet(store, key) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => res(r.result ?? null);
    r.onerror = () => rej(r.error);
  });
}
async function ftGetAll(store) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result ?? []);
    r.onerror = () => rej(r.error);
  });
}
async function ftGetByIndex(store, index, value) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value);
    r.onsuccess = () => res(r.result ?? []);
    r.onerror = () => rej(r.error);
  });
}
async function ftPut(store, value, key) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const r = key !== undefined ? tx.objectStore(store).put(value, key) : tx.objectStore(store).put(value);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function ftDelete(store, key) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).delete(key);
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}
async function ftDeleteByIndex(store, index, value) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const req = os.index(index).openCursor(IDBKeyRange.only(value));
    const deletes = [];
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { deletes.push(new Promise((r2,j2)=>{ const d=cursor.delete(); d.onsuccess=()=>r2(); d.onerror=()=>j2(d.error); })); cursor.continue(); }
      else { Promise.all(deletes).then(res).catch(rej); }
    };
    req.onerror = () => rej(req.error);
  });
}
async function ftClear(store) {
  const db = await ftOpenDB();
  return new Promise((res, rej) => {
    const r = db.transaction(store, 'readwrite').objectStore(store).clear();
    r.onsuccess = () => res();
    r.onerror = () => rej(r.error);
  });
}

// --- Settings helpers ---
async function ftGetSetting(key, fallback = null) {
  const v = await ftGet('settings', key);
  return v !== null ? v : fallback;
}
async function ftSetSetting(key, value) {
  return ftPut('settings', value, key);
}

// --- Project helpers ---
async function ftGetAllProjects() { return ftGetAll('projects'); }
async function ftSaveProject(proj) { return ftPut('projects', proj); }
async function ftDeleteProject(id) { return ftDelete('projects', id); }

// --- Project title helper (shared across all tools) ---
// Hierarchy: contractNumber → projectId → projectNumber
// Format: "identifier : name" or just "identifier" if no name
function ftProjectTitle(p) {
  if (!p) return 'Unnamed Project';
  const id = p.contractNumber || p.projectId || p.projectNumber || '';
  const name = p.name || '';
  if (id && name) return id + ' : ' + name;
  return id || name || 'Unnamed Project';
}

// --- LevelProject (metadata only, no loop data) ---
async function ftGetLevelProject(id) { return ftGet('levelProjects', id); }
async function ftGetAllLevelProjects() { return ftGetAll('levelProjects'); }
async function ftSaveLevelProject(proj) { return ftPut('levelProjects', proj); }
async function ftDeleteLevelProject(id) { return ftDelete('levelProjects', id); }

// --- LevelLoop (full loop data) ---
async function ftGetLevelLoop(id) { return ftGet('levelLoops', id); }
async function ftGetLoopsForProject(projectId) { return ftGetByIndex('levelLoops', 'projectId', projectId); }
async function ftSaveLevelLoop(loop) { return ftPut('levelLoops', loop); }
async function ftDeleteLevelLoop(id) { return ftDelete('levelLoops', id); }
async function ftDeleteLoopsForProject(projectId) { return ftDeleteByIndex('levelLoops', 'projectId', projectId); }

// --- StakeSessions ---
async function ftGetStakeSessions(projectId) { return ftGetByIndex('stakeSessions', 'projectId', projectId); }
async function ftGetStakeSession(id) { return ftGet('stakeSessions', id); }
async function ftSaveStakeSession(sess) { return ftPut('stakeSessions', sess); }
async function ftDeleteStakeSession(id) { return ftDelete('stakeSessions', id); }
async function ftDeleteStakeSessionsForProject(projectId) { return ftDeleteByIndex('stakeSessions', 'projectId', projectId); }

// --- Templates / Stakes / Ranges ---
async function ftGetAllTemplates() { return ftGetAll('stakeTemplates'); }
async function ftSaveTemplate(t) { return ftPut('stakeTemplates', t); }
async function ftDeleteTemplate(id) { return ftDelete('stakeTemplates', id); }

async function ftGetAllStakesList() { return ftGetAll('stakesList'); }
async function ftSaveStake(s) { return ftPut('stakesList', s); }
async function ftDeleteStake(id) { return ftDelete('stakesList', id); }

async function ftGetAllRanges() { return ftGetAll('stakeRanges'); }
async function ftSaveRange(r) { return ftPut('stakeRanges', r); }
async function ftDeleteRange(id) { return ftDelete('stakeRanges', id); }

// --- Materials ---
async function ftGetMaterials(projectId) { return ftGet('materials', projectId); }
async function ftGetAllMaterials() { return ftGetAll('materials'); }
async function ftSaveMaterials(contract) { return ftPut('materials', contract); }
async function ftDeleteMaterials(projectId) { return ftDelete('materials', projectId); }

// --- Grade history ---
async function ftGetGradeHistory() { return ftGetAll('gradeHistory'); }
async function ftSaveGradeHistory(arr) {
  await ftClear('gradeHistory');
  for (const item of arr) await ftPut('gradeHistory', item);
}

// --- Compaction Tests (T335) ---
async function ftGetAllCompactionTests() { return ftGetAll('compactionTests'); }
async function ftGetCompactionTest(id) { return ftGet('compactionTests', id); }
async function ftSaveCompactionTest(rec) { return ftPut('compactionTests', rec); }
async function ftDeleteCompactionTest(id) { return ftDelete('compactionTests', id); }
async function ftGetCompactionTestsByProject(projectId) { return ftGetByIndex('compactionTests', 'projectId', projectId); }

// --- Soil Compaction Tests (T103G) ---
async function ftGetAllSoilTests() { return ftGetAll('soilTests'); }
async function ftGetSoilTest(id) { return ftGet('soilTests', id); }
async function ftSaveSoilTest(rec) { return ftPut('soilTests', rec); }
async function ftDeleteSoilTest(id) { return ftDelete('soilTests', id); }
async function ftGetSoilTestsByProject(projectId) { return ftGetByIndex('soilTests', 'projectId', projectId); }

// --- Area totals ---
async function ftGetAreaTotals() { return ftGetAll('areaTotals'); }
async function ftSaveAreaTotals(arr) {
  await ftClear('areaTotals');
  for (const item of arr) await ftPut('areaTotals', item);
}

// --- Control Point Projects ---
async function ftGetAllControlProjects() { return ftGetAll('controlProjects'); }
async function ftGetControlProject(id) { return ftGet('controlProjects', id); }
async function ftSaveControlProject(proj) { return ftPut('controlProjects', proj); }
async function ftDeleteControlProject(id) { return ftDelete('controlProjects', id); }

// --- Control Points ---
async function ftGetControlPointsByProject(projectId) { return ftGetByIndex('controlPoints', 'projectId', projectId); }
async function ftGetControlPoint(id) { return ftGet('controlPoints', id); }
async function ftSaveControlPoint(pt) { return ftPut('controlPoints', pt); }
async function ftDeleteControlPoint(id) { return ftDelete('controlPoints', id); }
async function ftDeleteControlPointsForProject(projectId) { return ftDeleteByIndex('controlPoints', 'projectId', projectId); }

// --- Bid Estimate Contracts ---
async function ftGetAllBidContracts() { return ftGetAll('bidContracts'); }
async function ftGetBidContract(id) { return ftGet('bidContracts', id); }
async function ftSaveBidContract(c) { return ftPut('bidContracts', c); }
async function ftDeleteBidContract(id) { return ftDelete('bidContracts', id); }

// --- Stake session context (navigation) ---
async function ftGetStakeContext() { return ftGet('stakeContext', 'active'); }
async function ftSetStakeContext(ctx) { return ftPut('stakeContext', ctx, 'active'); }

// --- Persistent storage request ---
async function ftRequestPersistentStorage() {
  if (navigator.storage && navigator.storage.persist) {
    const granted = await navigator.storage.persist();
    console.log('[FieldTools] Persistent storage:', granted ? 'granted' : 'denied');
    return granted;
  }
  return false;
}

// Init: request persistent storage on first load
ftOpenDB().then(() => ftRequestPersistentStorage()).catch(console.error);
