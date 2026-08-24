import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateProfileRows } from './profile_service.mjs';
import { FileBlob, SpreadsheetFile } from '@oai/artifact-tool';
import projectPaths from './project_paths.cjs';

const paths = projectPaths.getProjectPaths({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const workspace = paths.repoRoot;
// The full historical workbook is a local user-data archive. Runtime reads and
// writes use the compact hot workbook so old job history never sits on the
// request hot path.
const runtimeDir = paths.runtimeDir;
const stateDir = paths.stateDir;
const masterPath = process.env.CAREERPILOT_MASTER_PATH || paths.masterPath;
const runtimeStatePath = process.env.CAREERPILOT_RUNTIME_STATE_PATH || paths.runtimeStatePath;
const runtimePersistenceLog = process.env.CAREERPILOT_RUNTIME_PERSISTENCE_LOG || paths.runtimePersistenceLog;
const now = () => new Date().toISOString();
const clean = v => v == null ? '' : String(v);
const validTime = value => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clean(value));
const materialsRootDefault = process.env.CAREERPILOT_MATERIALS_ROOT || paths.materialsRoot;
const excelDate = (value, header='') => {
  if (typeof value !== 'number' || value < 30000 || !/(date|deadline|_at|scanned|run)$/i.test(header)) return value;
  const d = new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  return /(_at|scanned|run)$/i.test(header) ? d.toISOString() : d.toISOString().slice(0, 10);
};

let workbookCache = null;
let workbookCacheMtime = null;
let workbookLoadPromise = null;
let workbookStateMtime = null;
let excelWriteQueue = Promise.resolve();

const runtimeCollections = {
  jobs: 'Jobs', applications: 'Applications', profile: 'Profile', preferences: 'Preferences',
  routines: 'Search_Routines', searchHistory: 'Search_History', statusHistory: 'Status_History',
  trash: 'Trash', syncMetadata: 'Sync_Metadata', materials: 'Materials', materialDefaults: 'Material_Defaults',
  calendarEvents: 'Calendar_Events', companies: 'Companies', applicationEvents: 'Application_Events',
  materialLibrary: 'Material_Library', materialVersions: 'Material_Versions', applicationMaterials: 'Application_Materials',
  searchRuns: 'Search_Runs', searchResults: 'Search_Results', settings: 'Settings',
};

async function writePersistenceLog(entry) {
  try {
    await fs.mkdir(path.dirname(runtimePersistenceLog), { recursive: true });
    await fs.appendFile(runtimePersistenceLog, `${JSON.stringify({ timestamp: now(), ...entry })}\n`, 'utf8');
  } catch (_) {}
}

async function hydrateWorkbookFromRuntimeState(workbook, envelope) {
  const state = envelope?.snapshot || envelope;
  if (!state || typeof state !== 'object') return;
  for (const [key, sheetName] of Object.entries(runtimeCollections)) {
    const rows = Array.isArray(state[key]) ? state[key] : null;
    if (!rows) continue;
    let sheet;
    try { sheet = workbook.worksheets.getItem(sheetName); } catch (_) { continue; }
    const used = sheet.getUsedRange();
    const values = used?.values || [];
    const headers = (values[0] || []).map(v => clean(v));
    if (!headers.length) continue;
    used?.clear({ applyTo: 'all' });
    const matrix = [headers, ...rows.map(row => headers.map(header => row[header] ?? ''))];
    sheet.getRangeByIndexes(0, 0, matrix.length, headers.length).values = matrix;
  }
}

async function hydrateIfRuntimeStateIsNewer(workbook, masterMtime) {
  const stateStat = await fs.stat(runtimeStatePath).catch(() => null);
  if (!stateStat || (masterMtime != null && stateStat.mtimeMs <= masterMtime) || stateStat.mtimeMs === workbookStateMtime) return;
  try {
    const envelope = JSON.parse(await fs.readFile(runtimeStatePath, 'utf8'));
    await hydrateWorkbookFromRuntimeState(workbook, envelope);
    workbookStateMtime = stateStat.mtimeMs;
  } catch (error) {
    await writePersistenceLog({ event: 'runtime state hydrate failed', error: String(error.stack || error) });
  }
}

async function loadBook() {
  const currentMtime = (await fs.stat(masterPath).catch(() => null))?.mtimeMs ?? null;
  if (workbookCache && workbookCacheMtime === currentMtime) {
    await hydrateIfRuntimeStateIsNewer(workbookCache, currentMtime);
    return workbookCache;
  }
  if (workbookLoadPromise) return workbookLoadPromise;
  workbookLoadPromise = (async () => {
    const input = await FileBlob.load(masterPath);
    const workbook = await SpreadsheetFile.importXlsx(input);
    await hydrateIfRuntimeStateIsNewer(workbook, currentMtime);
    workbookCache = workbook;
    workbookCacheMtime = (await fs.stat(masterPath).catch(() => null))?.mtimeMs ?? currentMtime;
    return workbook;
  })().finally(() => { workbookLoadPromise = null; });
  return workbookLoadPromise;
}

const lockPath = `${masterPath}.lock`;
async function acquireMasterLock() {
  await fs.mkdir(path.dirname(masterPath), { recursive:true });
  for (let attempt=0; attempt<120; attempt++) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid:process.pid, acquired_at:now() }), 'utf8');
      await handle.close();
      return async () => { try { await fs.rm(lockPath, { force:true }); } catch (_) {} };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await new Promise(resolve=>setTimeout(resolve, 50));
    }
  }
  throw Object.assign(new Error('Master data is busy. Please retry in a moment.'), { code: 423 });
}

async function saveBook(wb) {
  // Commit a compact, atomic runtime state first. The UI can safely return as
  // soon as this succeeds; Excel export is serialized in the background.
  const state = await snapshot();
  await fs.mkdir(path.dirname(runtimeStatePath), { recursive: true });
  const stateTemp = `${runtimeStatePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(stateTemp, JSON.stringify({ format_version: 1, saved_at: now(), snapshot: state }), 'utf8');
  await fs.rename(stateTemp, runtimeStatePath);
  workbookCache = wb;
  workbookStateMtime = (await fs.stat(runtimeStatePath).catch(() => null))?.mtimeMs ?? null;

  const exportTask = async () => {
    const started = Date.now();
    const output = await SpreadsheetFile.exportXlsx(wb);
    const tempPath = `${masterPath}.${process.pid}.${Date.now()}.tmp`;
    const rollbackPath = `${masterPath}.rollback`;
    const backupDir = path.join(path.dirname(masterPath), '.backups');
    await fs.mkdir(backupDir, { recursive:true });
    await output.save(tempPath);
    try {
      if (await fs.stat(masterPath).catch(()=>null)) {
        await fs.copyFile(masterPath, path.join(backupDir, 'careerpilot_runtime_before_last_write.xlsx'));
        await fs.rm(rollbackPath, { force:true });
        await fs.rename(masterPath, rollbackPath);
      }
      await fs.rename(tempPath, masterPath);
      await fs.rm(rollbackPath, { force:true });
      workbookCacheMtime = (await fs.stat(masterPath).catch(() => null))?.mtimeMs ?? null;
      await writePersistenceLog({ event: 'excel mirror persisted', duration_ms: Date.now() - started, path: masterPath });
    } catch (err) {
      await fs.rm(tempPath, { force:true }).catch(()=>{});
      if (!(await fs.stat(masterPath).catch(()=>null)) && await fs.stat(rollbackPath).catch(()=>null)) await fs.rename(rollbackPath, masterPath).catch(()=>{});
      throw err;
    }
  };
  excelWriteQueue = excelWriteQueue.then(exportTask, exportTask);
  excelWriteQueue.catch(error => writePersistenceLog({ event: 'excel mirror failed', error: String(error.stack || error) }));
}

export async function flushPersistence() { await excelWriteQueue; }
function rowsFor(wb, name) {
  const sheet = wb.worksheets.getItem(name);
  const used = sheet.getUsedRange();
  const values = used?.values || [];
  if (!values.length) return { sheet, headers: [], rows: [] };
  const headers = values[0].map(v => clean(v));
  const rows = values.slice(1).map((row, i) => {
    const obj = { __rowNumber: i + 2 };
    headers.forEach((h, j) => { obj[h] = clean(excelDate(row[j], h)); });
    return obj;
  });
  return { sheet, headers, rows };
}
function rowValues(headers, obj) { return headers.map(h => obj[h] ?? ''); }
function appendRow(sheet, headers, obj) {
  const used = sheet.getUsedRange();
  const next = used ? used.values.length : 1;
  sheet.getRangeByIndexes(next, 0, 1, headers.length).values = [rowValues(headers, obj)];
  return next + 1;
}
function setCell(sheet, rowNumber, headers, key, value) {
  const index = headers.indexOf(key);
  if (index >= 0) sheet.getCell(rowNumber - 1, index).values = [[value]];
}
function addAudit(wb, action, entityId, beforeValue, afterValue, notes = '') {
  const { sheet, headers } = rowsFor(wb, 'Audit_Log');
  appendRow(sheet, headers, { audit_id: `audit-${Date.now()}`, event_at: now(), event_type: 'Data change', entity_type: 'CareerPilot', entity_id: entityId, actor: 'ui', action, before_value: beforeValue, after_value: afterValue, source: 'product UI', notes });
}
function addStatusHistory(wb, jobId, fromStatus, toStatus, reason = '') {
  const { sheet, headers } = rowsFor(wb, 'Status_History');
  appendRow(sheet, headers, { history_id: `hist-${Date.now()}`, job_id: jobId, changed_at: now(), from_status: fromStatus, to_status: toStatus, changed_by: 'ui', reason, notes: '' });
}
function findJob(wb, payload) {
  const info = rowsFor(wb, 'Jobs');
  const key = payload.job_id || payload.record_id;
  const match = info.rows.find(r => (payload.job_id && r.job_id === payload.job_id) || (payload.record_id && r.record_id === payload.record_id));
  if (!match) throw Object.assign(new Error('Job not found; refresh the workspace.'), { code: 404 });
  if (payload.expected_version != null && Number(match.version || 1) !== Number(payload.expected_version)) throw Object.assign(new Error('Conflict: this job changed elsewhere. Reload before saving.'), { code: 409 });
  return { ...info, match };
}
function profileOrPreferences(wb, sheetName) {
  const info = rowsFor(wb, sheetName);
  return info.rows.map(({__rowNumber, ...row}) => row);
}

async function snapshot() {
  const wb = await loadBook();
  const jobs = rowsFor(wb, 'Jobs').rows.filter(j => j.job_id);
  const applications = rowsFor(wb, 'Applications').rows;
  const profile = profileOrPreferences(wb, 'Profile');
  const preferences = profileOrPreferences(wb, 'Preferences');
  const routines = rowsFor(wb, 'Search_Routines').rows;
  const searchHistory = rowsFor(wb, 'Search_History').rows;
  const statusHistory = rowsFor(wb, 'Status_History').rows;
  const trash = rowsFor(wb, 'Trash').rows;
  const syncMetadata = rowsFor(wb, 'Sync_Metadata').rows;
  const materials = rowsFor(wb, 'Materials').rows;
  const materialDefaults = rowsFor(wb, 'Material_Defaults').rows;
  const calendarEvents = rowsFor(wb, 'Calendar_Events').rows;
  const companies = rowsFor(wb, 'Companies').rows;
  const applicationEvents = rowsFor(wb, 'Application_Events').rows;
  const materialLibrary = rowsFor(wb, 'Material_Library').rows;
  const materialVersions = rowsFor(wb, 'Material_Versions').rows;
  const applicationMaterials = rowsFor(wb, 'Application_Materials').rows;
  const searchRuns = rowsFor(wb, 'Search_Runs').rows;
  const searchResults = rowsFor(wb, 'Search_Results').rows;
  const settings = rowsFor(wb, 'Settings').rows;
  for (const row of settings) if (row.key === 'materials_last_scanned' && /^\d{5}(\.\d+)?$/.test(row.value)) row.value = new Date(Date.UTC(1899, 11, 30) + Number(row.value) * 86400000).toISOString();
  const active = jobs.filter(j => !j.deleted_at && j.current_validity === 'Validated + Active' && ['Potential','To Review','Interested','To Apply'].includes(j.status));
  const summary = {
    total: jobs.filter(j => !j.deleted_at).length,
    toReview: jobs.filter(j => !j.deleted_at && j.status === 'To Review').length,
    interested: jobs.filter(j => !j.deleted_at && j.status === 'Interested').length,
    toApply: jobs.filter(j => !j.deleted_at && j.status === 'To Apply').length,
    applied: jobs.filter(j => !j.deleted_at && j.status === 'Applied').length,
    onlineAssessment: jobs.filter(j => !j.deleted_at && j.status === 'Online Assessment').length,
    interview: jobs.filter(j => !j.deleted_at && j.status === 'Interview').length,
    offer: jobs.filter(j => !j.deleted_at && j.status === 'Offer').length,
    rejectedClosed: jobs.filter(j => !j.deleted_at && ['Rejected','Closed / Expired'].includes(j.status)).length,
    activeValidated: active.length,
    expired: jobs.filter(j => !j.deleted_at && ['Expired/Closed','Expired','Closed'].includes(j.current_validity)).length,
    archived: jobs.filter(j => !j.deleted_at && j.status === 'Archived').length,
    trash: trash.filter(t => !t.restored_at && t.permanently_deleted !== 'Yes').length,
    applications: applications.length,
    materials: materials.filter(m => !m.deleted_at && m.status !== 'Trash').length,
    calendarEvents: calendarEvents.filter(e => !e.deleted_at).length,
  };
  return { ok: true, generated_at: now(), master_path: paths.masterPath, summary, jobs, activeJobs: active, applications, profile, preferences, routines, searchHistory, statusHistory, trash, syncMetadata, materials, materialDefaults, calendarEvents, companies, applicationEvents, materialLibrary, materialVersions, applicationMaterials, searchRuns, searchResults, settings };
}

async function updateJob(payload) {
  const wb = await loadBook();
  const info = findJob(wb, payload);
  const before = { ...info.match };
  const allowed = ['status','lifecycle_status','application_date','cv_version','cover_letter_version','notes','tags','programme_type','priority','application_deadline','current_validity','last_checked','validation_reason'];
  for (const key of allowed) if (payload[key] !== undefined) setCell(info.sheet, info.match.__rowNumber, info.headers, key, payload[key]);
  const fromStatus = info.match.status;
  const toStatus = payload.status !== undefined ? clean(payload.status) : fromStatus;
  if (payload.status !== undefined) setCell(info.sheet, info.match.__rowNumber, info.headers, 'status', toStatus);
  if (payload.lifecycle_status !== undefined) setCell(info.sheet, info.match.__rowNumber, info.headers, 'lifecycle_status', payload.lifecycle_status);
  const version = Number(info.match.version || 1) + 1;
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_at', now());
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_by', 'ui');
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'version', version);
  if (fromStatus !== toStatus) addStatusHistory(wb, info.match.job_id, fromStatus, toStatus, payload.reason || 'Changed in CareerPilot UI');
  addAudit(wb, 'Updated job', info.match.job_id, JSON.stringify({ status: before.status, notes: before.notes }), JSON.stringify({ status: toStatus, notes: payload.notes ?? before.notes }), payload.reason || '');
  await saveBook(wb);
  return { ok: true, job_id: info.match.job_id, version };
}

async function recheckJob(payload) {
  const wb=await loadBook(); const info=findJob(wb,payload); const when=now();
  for(const [key,value] of [['last_checked',when.slice(0,10)],['current_validity','Unknown'],['validation_reason','Re-check requested from CareerPilot; actual vacancy page validation is required before reactivation.'],['updated_at',when],['updated_by','ui'],['version',Number(info.match.version||1)+1]]) setCell(info.sheet,info.match.__rowNumber,info.headers,key,value);
  addAudit(wb,'Requested job re-check',info.match.job_id,info.match.current_validity,'Unknown','Actual vacancy validation is pending.');await saveBook(wb);return{ok:true,job_id:info.match.job_id,current_validity:'Unknown'};
}

async function addJob(payload) {
  const wb = await loadBook();
  const info = rowsFor(wb, 'Jobs');
  const norm = v => clean(v).toLowerCase().replace(/\/$/, '');
  const duplicate = info.rows.find(r => (payload.job_url && norm(r.job_url) === norm(payload.job_url)) || (norm(r.company) === norm(payload.company) && norm(r.job_title) === norm(payload.job_title) && norm(r.location) === norm(payload.location)));
  if (duplicate) throw Object.assign(new Error(`Duplicate job already exists: ${duplicate.company} — ${duplicate.job_title}`), { code: 409, duplicate: duplicate.job_id });
  const base = clean(payload.job_id) || `manual-${Date.now()}`;
  const jobId = info.rows.some(r => r.job_id === base) ? `${base}-${Date.now()}` : base;
  const row = { record_id: `job-record-${Date.now()}`, job_id: jobId, legacy_job_id: '', company: clean(payload.company), job_title: clean(payload.job_title), location: clean(payload.location), job_url: clean(payload.job_url), official_url: clean(payload.official_url || payload.job_url), source: clean(payload.source || 'Manual'), status: clean(payload.status || 'To Review'), lifecycle_status: clean(payload.status || 'To Review'), current_validity: clean(payload.current_validity || 'Unknown'), programme_type: clean(payload.programme_type || 'Entry-level'), priority: clean(payload.priority), application_deadline: clean(payload.application_deadline), application_date: '', last_checked: '', validation_reason: 'Manual URL added; validate the actual vacancy page before active display', resume_variant: '', cv_version: '', cover_letter_version: '', tags: clean(payload.tags), notes: clean(payload.notes), updated_at: now(), updated_by: 'ui', version: 1, deleted_at: '', deleted_by: '', trash_reason: '', source_sheet: 'Jobs', legacy_row_number: '' };
  appendRow(info.sheet, info.headers, row);
  addAudit(wb, 'Added job', jobId, '', JSON.stringify(row));
  await saveBook(wb);
  return { ok: true, job_id: jobId };
}

async function trashJob(payload) {
  const wb = await loadBook();
  const info = findJob(wb, payload);
  const oldStatus = info.match.status;
  const when = now();
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'deleted_at', when);
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'deleted_by', 'ui');
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'trash_reason', clean(payload.reason || 'Deleted from UI'));
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'status', 'Archived');
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'lifecycle_status', 'Archived');
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_at', when);
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_by', 'ui');
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'version', Number(info.match.version || 1) + 1);
  const trashInfo = rowsFor(wb, 'Trash');
  appendRow(trashInfo.sheet, trashInfo.headers, { trash_id: `trash-${Date.now()}`, entity_type: 'Job', entity_id: info.match.job_id, deleted_at: when, original_status: oldStatus, reason: clean(payload.reason || 'Deleted from UI'), deleted_by: 'ui', restored_at: '', permanently_deleted: 'No' });
  addAudit(wb, 'Moved job to Trash', info.match.job_id, oldStatus, 'Trash');
  await saveBook(wb);
  return { ok: true, job_id: info.match.job_id };
}

async function restoreJob(payload) {
  const wb = await loadBook();
  const info = findJob(wb, payload);
  const trashInfo = rowsFor(wb, 'Trash');
  const trash = trashInfo.rows.find(r => r.entity_id === info.match.job_id && !r.restored_at && r.permanently_deleted !== 'Yes');
  const restoredStatus = clean(payload.status || trash?.original_status || 'To Review');
  for (const [key, value] of [['deleted_at',''],['deleted_by',''],['trash_reason',''],['status',restoredStatus],['lifecycle_status',restoredStatus],['updated_at',now()],['updated_by','ui'],['version',Number(info.match.version || 1)+1]]) setCell(info.sheet, info.match.__rowNumber, info.headers, key, value);
  if (trash) { setCell(trashInfo.sheet, trash.__rowNumber, trashInfo.headers, 'restored_at', now()); }
  addAudit(wb, 'Restored job', info.match.job_id, 'Trash', restoredStatus);
  await saveBook(wb);
  return { ok: true, job_id: info.match.job_id };
}

async function permanentlyDeleteJob(payload) {
  const wb = await loadBook();
  const info = findJob(wb, payload);
  if (!info.match.deleted_at && info.match.status !== 'Archived') throw Object.assign(new Error('Only jobs already in Trash can be permanently deleted.'), { code: 400 });
  const trashInfo = rowsFor(wb, 'Trash');
  const trash = trashInfo.rows.find(r => r.entity_id === info.match.job_id && !r.restored_at && r.permanently_deleted !== 'Yes');
  if (!trash) throw Object.assign(new Error('Trash record not found; restore or refresh first.'), { code: 404 });
  info.sheet.getRangeByIndexes(info.match.__rowNumber - 1, 0, 1, info.headers.length).clear({ applyTo: 'contents' });
  setCell(trashInfo.sheet, trash.__rowNumber, trashInfo.headers, 'permanently_deleted', 'Yes');
  addAudit(wb, 'Permanently deleted job', info.match.job_id, 'Trash', 'Deleted', 'Explicit permanent deletion from Trash');
  await saveBook(wb);
  return { ok: true, job_id: info.match.job_id };
}

async function saveRows(sheetName, payloadRows) {
  const wb = await loadBook();
  const info = rowsFor(wb, sheetName);
  const rows = Array.isArray(payloadRows) ? payloadRows : [];
  if (sheetName === 'Profile') validateProfileRows(rows);
  if (info.headers.length) {
    const currentRows = info.rows.length;
    if (currentRows) info.sheet.getRangeByIndexes(1, 0, currentRows, info.headers.length).clear({ applyTo: 'contents' });
    if (rows.length) info.sheet.getRangeByIndexes(1, 0, rows.length, info.headers.length).values = rows.map(r => rowValues(info.headers, r));
  }
  addAudit(wb, `Saved ${sheetName}`, sheetName, '', `${rows.length} rows`);
  await saveBook(wb);
  return { ok: true, sheet: sheetName, rows: rows.length };
}

async function updateRoutine(payload) {
  const wb = await loadBook();
  const info = rowsFor(wb, 'Search_Routines');
  const row = info.rows.find(r => r.routine_id === payload.routine_id);
  if (!row) throw Object.assign(new Error('Routine not found'), { code: 404 });
  for (const key of ['name','status','frequency','prompt','next_run','notes']) if (payload[key] !== undefined) setCell(info.sheet, row.__rowNumber, info.headers, key, payload[key]);
  setCell(info.sheet, row.__rowNumber, info.headers, 'updated_at', now()); setCell(info.sheet, row.__rowNumber, info.headers, 'updated_by', 'ui'); setCell(info.sheet, row.__rowNumber, info.headers, 'version', Number(row.version || 1) + 1);
  addAudit(wb, 'Updated search routine', row.routine_id, row.status, payload.status ?? row.status);
  await saveBook(wb);
  return { ok: true, routine_id: row.routine_id };
}

function findRow(wb, sheetName, idKey, idValue, expectedVersion) {
  const info = rowsFor(wb, sheetName);
  const match = info.rows.find(r => r[idKey] === idValue);
  if (!match) throw Object.assign(new Error(`${sheetName} record not found; refresh the workspace.`), { code: 404 });
  if (expectedVersion != null && Number(match.version || 1) !== Number(expectedVersion)) throw Object.assign(new Error('Conflict: this record changed elsewhere. Reload before saving.'), { code: 409 });
  return { ...info, match };
}

async function markApplied(payload) {
  const wb = await loadBook();
  const info = findJob(wb, payload);
  const when = clean(payload.application_date || new Date().toISOString().slice(0, 10));
  const oldStatus = info.match.status;
  const version = Number(info.match.version || 1) + 1;
  for (const [key,value] of [['status','Applied'],['lifecycle_status','Applied'],['application_date',when],['cv_version',clean(payload.resume_used)],['cover_letter_version',clean(payload.cover_letter_used)],['updated_at',now()],['updated_by','ui'],['version',version]]) setCell(info.sheet, info.match.__rowNumber, info.headers, key, value);
  if (payload.notes !== undefined) setCell(info.sheet, info.match.__rowNumber, info.headers, 'notes', clean(payload.notes));

  const apps = rowsFor(wb, 'Applications');
  let app = apps.rows.find(r => r.job_id === info.match.job_id) || apps.rows.find(r => r.company === info.match.company && r.job_title === info.match.job_title);
  const appValues = {
    job_id: info.match.job_id, attempt_date: when, company: info.match.company, job_title: info.match.job_title,
    job_url: info.match.job_url, platform: clean(payload.application_channel || info.match.source), status: 'Applied',
    submission_evidence: 'Marked as applied by user in CareerPilot', resume_used: clean(payload.resume_used), cover_letter_used: clean(payload.cover_letter_used),
    application_channel: clean(payload.application_channel || info.match.source), current_stage: 'Applied', next_action: clean(payload.next_action), next_deadline: clean(payload.next_deadline),
    notes: clean(payload.notes), updated_at: now(), updated_by: 'ui'
  };
  if (app) {
    for (const [key,value] of Object.entries(appValues)) if (apps.headers.includes(key) && value !== '') setCell(apps.sheet, app.__rowNumber, apps.headers, key, value);
    setCell(apps.sheet, app.__rowNumber, apps.headers, 'version', Number(app.version || 1) + 1);
  } else {
    app = { application_id: `app-${Date.now()}`, version: 1, ...appValues };
    appendRow(apps.sheet, apps.headers, app);
  }
  if (payload.resume_material_version_id) {
    const link = await snapshotApplicationMaterial(wb, app.application_id, 'CV', clean(payload.resume_material_version_id));
    appValues.resume_used = link.snapshot_path;
    const saved = rowsFor(wb,'Applications').rows.find(r=>r.application_id===app.application_id); if(saved) setCell(apps.sheet, saved.__rowNumber, apps.headers, 'resume_used', link.snapshot_path);
  }
  if (payload.cover_letter_material_version_id) {
    const link = await snapshotApplicationMaterial(wb, app.application_id, 'Cover Letter', clean(payload.cover_letter_material_version_id));
    appValues.cover_letter_used = link.snapshot_path;
    const saved = rowsFor(wb,'Applications').rows.find(r=>r.application_id===app.application_id); if(saved) setCell(apps.sheet, saved.__rowNumber, apps.headers, 'cover_letter_used', link.snapshot_path);
  }
  const events = rowsFor(wb,'Application_Events');
  if(!events.rows.some(e=>e.application_id===app.application_id&&e.event_type==='Applied'&&!e.deleted_at)) appendRow(events.sheet,events.headers,{event_id:`appevt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,application_id:app.application_id,job_id:info.match.job_id,event_type:'Applied',event_date:when,event_time:'',deadline:clean(payload.next_deadline),round:'',title:'已投递',notes:clean(payload.notes),attachment_material_id:clean(payload.resume_material_version_id),source:'CareerPilot UI',status:'Completed',created_at:now(),updated_at:now(),updated_by:'ui',version:1,deleted_at:''});
  if (oldStatus !== 'Applied') addStatusHistory(wb, info.match.job_id, oldStatus, 'Applied', 'Marked as applied in CareerPilot');
  addAudit(wb, 'Marked job as applied', info.match.job_id, oldStatus, 'Applied', `CV: ${clean(payload.resume_used) || 'not recorded'}`);
  await saveBook(wb);
  return { ok: true, job_id: info.match.job_id, application_id: app.application_id, version };
}

async function updateMaterial(payload) {
  const wb = await loadBook();
  let info;
  try { info = findRow(wb, 'Materials', 'material_id', clean(payload.material_id), payload.expected_version); }
  catch (_) { info = findRow(wb, 'Material_Library', 'material_id', clean(payload.material_id), payload.expected_version); }
  const versions = rowsFor(wb,'Material_Versions').rows;
  if (payload.editable_version_id) { const version=versions.find(row=>row.material_version_id===clean(payload.editable_version_id)&&row.material_id===info.match.material_id&&!row.missing_at); if(!version||!['DOCX','DOC'].includes(String(version.extension||'').toUpperCase())) throw Object.assign(new Error('这里需要选择 Word 可编辑文件（.docx）。'),{code:400}); }
  if (payload.submission_version_id) { const version=versions.find(row=>row.material_version_id===clean(payload.submission_version_id)&&row.material_id===info.match.material_id&&!row.missing_at); if(!version||String(version.extension||'').toUpperCase()!=='PDF') throw Object.assign(new Error('这里需要选择 PDF 投递文件。'),{code:400}); }
  for (const key of ['display_name','version_label','tags','target_role','default_for','status','notes','approved_for_use','content_reference','format_template','editable_version_id','submission_version_id','pairing_status','pairing_reason']) if (payload[key] !== undefined) setCell(info.sheet, info.match.__rowNumber, info.headers, key, typeof payload[key] === 'boolean' ? payload[key] : clean(payload[key]));
  setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_at', now()); setCell(info.sheet, info.match.__rowNumber, info.headers, 'updated_by', 'ui');
  const version = Number(info.match.version || 1) + 1; setCell(info.sheet, info.match.__rowNumber, info.headers, 'version', version);
  addAudit(wb, 'Updated application material', info.match.material_id, info.match.display_name, clean(payload.display_name || info.match.display_name));
  await saveBook(wb); return { ok:true, material_id:info.match.material_id, version };
}

async function associateMaterialVersion(payload) {
  const wb = await loadBook();
  const target = findRow(wb, 'Material_Library', 'material_id', clean(payload.material_id || payload.target_material_id));
  const version = findRow(wb, 'Material_Versions', 'material_version_id', clean(payload.material_version_id));
  if (!/DOCX|DOC|PDF/i.test(version.match.extension || '')) throw Object.assign(new Error('Only DOCX/DOC or PDF files can be associated with a resume version.'), { code: 400 });
  setCell(version.sheet, version.match.__rowNumber, version.headers, 'material_id', target.match.material_id);
  setCell(version.sheet, version.match.__rowNumber, version.headers, 'updated_at', now());
  setCell(version.sheet, version.match.__rowNumber, version.headers, 'updated_by', 'ui');
  setCell(version.sheet, version.match.__rowNumber, version.headers, 'version', Number(version.match.version || 1) + 1);
  setCell(target.sheet, target.match.__rowNumber, target.headers, 'updated_at', now());
  setCell(target.sheet, target.match.__rowNumber, target.headers, 'updated_by', 'ui');
  setCell(target.sheet, target.match.__rowNumber, target.headers, 'version', Number(target.match.version || 1) + 1);
  addAudit(wb, 'Associated material file with resume version', target.match.material_id, '', version.match.file_name, 'Manual DOCX/PDF association');
  await saveBook(wb);
  return { ok: true, material_id: target.match.material_id, material_version_id: version.match.material_version_id };
}

async function addMaterial(payload) {
  const wb = await loadBook(); const info = rowsFor(wb, 'Materials');
  const rel = clean(payload.relative_path).replaceAll('\\','/');
  const duplicate = info.rows.find(r => r.relative_path.toLowerCase() === rel.toLowerCase() && !r.deleted_at);
  if (duplicate) throw Object.assign(new Error('This file is already in the materials library.'), { code: 409 });
  const materialId = clean(payload.material_id || `mat-${Date.now()}`);
  const row = { material_id:materialId,display_name:clean(payload.display_name || payload.file_name),file_name:clean(payload.file_name),relative_path:rel,file_path:clean(payload.file_path),material_type:clean(payload.material_type || 'Other'),version_label:clean(payload.version_label),tags:clean(payload.tags),target_role:clean(payload.target_role),default_for:'',last_updated:new Date().toISOString().slice(0,10),status:'Active',notes:clean(payload.notes),source:'UI import',updated_at:now(),updated_by:'ui',version:1,deleted_at:'',trash_reason:'' };
  appendRow(info.sheet, info.headers, row); addAudit(wb, 'Imported application material', materialId, '', row.display_name);
  await saveBook(wb); return {ok:true,material_id:materialId};
}

async function setMaterialDefault(payload) {
  const wb = await loadBook();
  findRow(wb, 'Materials', 'material_id', clean(payload.material_id));
  const info = rowsFor(wb, 'Material_Defaults'); const family = clean(payload.job_family);
  const row = info.rows.find(r => r.job_family === family);
  if (!row) throw Object.assign(new Error('Unsupported job family.'), {code:400});
  for(const [key,value] of [['material_id',clean(payload.material_id)],['material_type',clean(payload.material_type||'CV / Resume')],['updated_at',now()],['updated_by','ui'],['version',Number(row.version||1)+1]]) setCell(info.sheet,row.__rowNumber,info.headers,key,value);
  addAudit(wb,'Changed material default',family,row.material_id,clean(payload.material_id)); await saveBook(wb); return {ok:true,job_family:family};
}

async function trashMaterial(payload) {
  const wb=await loadBook(); const info=findRow(wb,'Materials','material_id',clean(payload.material_id),payload.expected_version); const when=now();
  for(const [key,value] of [['status','Trash'],['deleted_at',when],['trash_reason',clean(payload.reason||'Deleted from materials UI')],['updated_at',when],['updated_by','ui'],['version',Number(info.match.version||1)+1]]) setCell(info.sheet,info.match.__rowNumber,info.headers,key,value);
  const trash=rowsFor(wb,'Trash'); appendRow(trash.sheet,trash.headers,{trash_id:`trash-${Date.now()}`,entity_type:'Material',entity_id:info.match.material_id,deleted_at:when,original_status:info.match.status,reason:clean(payload.reason||'Deleted from materials UI'),deleted_by:'ui',restored_at:'',permanently_deleted:'No'});
  addAudit(wb,'Moved material to Trash',info.match.material_id,info.match.status,'Trash'); await saveBook(wb); return {ok:true,material_id:info.match.material_id};
}

async function restoreMaterial(payload) {
  const wb=await loadBook(); const info=findRow(wb,'Materials','material_id',clean(payload.material_id)); const trash=rowsFor(wb,'Trash');
  for(const [key,value] of [['status','Active'],['deleted_at',''],['trash_reason',''],['updated_at',now()],['updated_by','ui'],['version',Number(info.match.version||1)+1]]) setCell(info.sheet,info.match.__rowNumber,info.headers,key,value);
  const tr=trash.rows.find(r=>r.entity_type==='Material'&&r.entity_id===info.match.material_id&&!r.restored_at&&r.permanently_deleted!=='Yes'); if(tr)setCell(trash.sheet,tr.__rowNumber,trash.headers,'restored_at',now());
  addAudit(wb,'Restored material',info.match.material_id,'Trash','Active'); await saveBook(wb); return {ok:true,material_id:info.match.material_id};
}

async function addCalendarEvent(payload) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('Event date must use YYYY-MM-DD.'),{code:400});
  const wb=await loadBook(); const info=rowsFor(wb,'Calendar_Events'); const eventId=`evt-${Date.now()}`;
  const row={event_id:eventId,event_type:clean(payload.event_type||'Follow-up'),title:clean(payload.title),event_date:clean(payload.event_date),event_time:clean(payload.event_time),company:clean(payload.company),job_id:clean(payload.job_id),application_id:clean(payload.application_id),notes:clean(payload.notes),reminder:clean(payload.reminder),source_type:'Manual',source_field:'CareerPilot UI',status:'Scheduled',created_at:now(),updated_at:now(),updated_by:'ui',version:1,deleted_at:''};
  appendRow(info.sheet,info.headers,row); addAudit(wb,'Added calendar event',eventId,'',row.title); await saveBook(wb); return {ok:true,event_id:eventId};
}

async function updateCalendarEvent(payload) {
  if (payload.event_date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('Event date must use YYYY-MM-DD.'),{code:400});
  if (payload.event_time !== undefined && clean(payload.event_time) && !validTime(payload.event_time)) throw Object.assign(new Error('Event time must use HH:MM.'),{code:400});
  const wb=await loadBook(); const info=findRow(wb,'Calendar_Events','event_id',clean(payload.event_id),payload.expected_version);
  for(const key of ['event_type','title','event_date','event_time','company','job_id','application_id','notes','reminder','status']) if(payload[key]!==undefined)setCell(info.sheet,info.match.__rowNumber,info.headers,key,clean(payload[key]));
  setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_at',now());setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_by','ui');setCell(info.sheet,info.match.__rowNumber,info.headers,'version',Number(info.match.version||1)+1);
  addAudit(wb,'Updated calendar event',info.match.event_id,info.match.title,clean(payload.title||info.match.title));await saveBook(wb);return {ok:true,event_id:info.match.event_id};
}

async function deleteCalendarEvent(payload) {
  const wb=await loadBook(); const info=findRow(wb,'Calendar_Events','event_id',clean(payload.event_id),payload.expected_version); const when=now();
  setCell(info.sheet,info.match.__rowNumber,info.headers,'deleted_at',when);setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_at',when);setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_by','ui');setCell(info.sheet,info.match.__rowNumber,info.headers,'version',Number(info.match.version||1)+1);
  addAudit(wb,'Deleted calendar event',info.match.event_id,info.match.title,'Archived');await saveBook(wb);return {ok:true,event_id:info.match.event_id};
}

const eventStage = type => ({
  'Applied':'Applied','OA Received':'Online Assessment','OA Completed':'Online Assessment',
  'Interview Invitation':'Interview','Interview Completed':'Interview','Assessment Centre':'Interview',
  'Offer':'Offer','Rejected':'Rejected','Withdrawn':'Withdrawn'
})[type] || '';

function findApplication(wb, applicationId) {
  return findRow(wb, 'Applications', 'application_id', clean(applicationId));
}

function syncApplicationStage(wb, applicationId) {
  const apps = findApplication(wb, applicationId);
  const events = rowsFor(wb, 'Application_Events').rows
    .filter(e => e.application_id === applicationId && !e.deleted_at && eventStage(e.event_type))
    .sort((a,b) => `${a.event_date}T${a.event_time||'00:00'}|${a.created_at}`.localeCompare(`${b.event_date}T${b.event_time||'00:00'}|${b.created_at}`));
  const latest = events.at(-1);
  const stage = latest ? eventStage(latest.event_type) : 'Applied';
  for (const [key,value] of [['current_stage',stage],['status',stage],['updated_at',now()],['updated_by','ui'],['version',Number(apps.match.version||1)+1]]) setCell(apps.sheet,apps.match.__rowNumber,apps.headers,key,value);
  if (apps.match.job_id) {
    const jobs = rowsFor(wb,'Jobs'); const job = jobs.rows.find(j=>j.job_id===apps.match.job_id);
    if(job){const old=job.status;for(const [key,value] of [['status',stage],['lifecycle_status',stage],['updated_at',now()],['updated_by','ui'],['version',Number(job.version||1)+1]])setCell(jobs.sheet,job.__rowNumber,jobs.headers,key,value);if(old!==stage)addStatusHistory(wb,job.job_id,old,stage,'Derived from application timeline');}
  }
  return stage;
}

async function addApplicationEvent(payload) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('Event date must use YYYY-MM-DD.'),{code:400});
  const allowed=['Applied','OA Received','OA Completed','Interview Invitation','Interview Completed','Assessment Centre','Offer','Rejected','Withdrawn','Follow-up','Other'];
  if(!allowed.includes(clean(payload.event_type))) throw Object.assign(new Error('Unsupported application event type.'),{code:400});
  const wb=await loadBook(); const app=findApplication(wb,clean(payload.application_id)); const info=rowsFor(wb,'Application_Events');
  const eventId=`appevt-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const row={event_id:eventId,application_id:app.match.application_id,job_id:app.match.job_id,event_type:clean(payload.event_type),event_date:clean(payload.event_date),event_time:clean(payload.event_time),deadline:clean(payload.deadline),round:clean(payload.round),title:clean(payload.title||payload.event_type),notes:clean(payload.notes),attachment_material_id:clean(payload.attachment_material_id),source:'CareerPilot UI',status:clean(payload.status||(/Completed|Rejected|Withdrawn|Applied/.test(payload.event_type)?'Completed':'Pending')),created_at:now(),updated_at:now(),updated_by:'ui',version:1,deleted_at:''};
  appendRow(info.sheet,info.headers,row); const stage=syncApplicationStage(wb,app.match.application_id);
  addAudit(wb,'Recorded application progress',eventId,'',`${row.event_type} · ${row.event_date}`,`Application ${app.match.application_id}; current stage ${stage}`);
  await saveBook(wb); return {ok:true,event_id:eventId,current_stage:stage};
}

async function updateApplicationEvent(payload) {
  const allowed=['Applied','OA Received','OA Completed','Interview Invitation','Interview Completed','Assessment Centre','Offer','Rejected','Withdrawn','Follow-up','Other'];
  if(payload.event_type!==undefined&&!allowed.includes(clean(payload.event_type))) throw Object.assign(new Error('Unsupported application event type.'),{code:400});
  if(payload.event_date!==undefined&&!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.event_date))) throw Object.assign(new Error('Event date must use YYYY-MM-DD.'),{code:400});
  if(payload.deadline!==undefined&&clean(payload.deadline)&&!/^\d{4}-\d{2}-\d{2}$/.test(clean(payload.deadline))) throw Object.assign(new Error('Deadline must use YYYY-MM-DD.'),{code:400});
  if(payload.event_time!==undefined&&clean(payload.event_time)&&!validTime(payload.event_time)) throw Object.assign(new Error('Event time must use HH:MM.'),{code:400});
  const wb=await loadBook(); const info=findRow(wb,'Application_Events','event_id',clean(payload.event_id),payload.expected_version);
  for(const key of ['event_type','event_date','event_time','deadline','round','title','notes','attachment_material_id','status']) if(payload[key]!==undefined) setCell(info.sheet,info.match.__rowNumber,info.headers,key,clean(payload[key]));
  setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_at',now());setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_by','ui');setCell(info.sheet,info.match.__rowNumber,info.headers,'version',Number(info.match.version||1)+1);
  const stage=syncApplicationStage(wb,info.match.application_id);addAudit(wb,'Updated application progress',info.match.event_id,'',`${clean(payload.event_type||info.match.event_type)} · ${clean(payload.event_date||info.match.event_date)}`,`Stage recalculated to ${stage}`);await saveBook(wb);return{ok:true,event_id:info.match.event_id,current_stage:stage};
}

async function deleteApplicationEvent(payload) {
  const wb=await loadBook(); const info=findRow(wb,'Application_Events','event_id',clean(payload.event_id),payload.expected_version); const when=now();
  for(const [key,value] of [['deleted_at',when],['updated_at',when],['updated_by','ui'],['version',Number(info.match.version||1)+1]])setCell(info.sheet,info.match.__rowNumber,info.headers,key,value);
  const stage=syncApplicationStage(wb,info.match.application_id); addAudit(wb,'Removed application progress',info.match.event_id,info.match.event_type,'Archived',`Stage recalculated to ${stage}`);
  await saveBook(wb); return {ok:true,event_id:info.match.event_id,current_stage:stage};
}

function resumeVersionFiles(wb, resumeId, editableId='', submissionId='') {
  const libraries = rowsFor(wb, 'Material_Library').rows;
  const versions = rowsFor(wb, 'Material_Versions').rows.filter(row => row.material_id === resumeId && !row.missing_at);
  const library = libraries.find(row => row.material_id === resumeId);
  const docxRows = versions.filter(row => ['DOCX', 'DOC'].includes(String(row.extension || '').toUpperCase()));
  const pdfRows = versions.filter(row => String(row.extension || '').toUpperCase() === 'PDF');
  const explicitDocx = versions.find(row => row.material_version_id === editableId && ['DOCX', 'DOC'].includes(String(row.extension || '').toUpperCase()));
  const explicitPdf = versions.find(row => row.material_version_id === submissionId && String(row.extension || '').toUpperCase() === 'PDF');
  const docx = explicitDocx || (docxRows.length === 1 ? docxRows[0] : null);
  const pdf = explicitPdf || (pdfRows.length === 1 ? pdfRows[0] : null);
  return { library, docx, pdf };
}

async function snapshotApplicationMaterial(wb, applicationId, role, materialVersionId, mappingStatus='Confirmed', reason='Selected by user', meta={}) {
  const versions=rowsFor(wb,'Material_Versions'); const ver=versions.rows.find(v=>v.material_version_id===materialVersionId&&!v.missing_at);
  if(!ver)throw Object.assign(new Error('Material version not found or file is missing.'),{code:404});
  const source=ver.file_path.replaceAll('/',path.sep); const targetDir=path.join(paths.snapshotsRoot, applicationId); await fs.mkdir(targetDir,{recursive:true});
  const parsed=path.parse(ver.file_name), target=path.join(targetDir,`${parsed.name}_${ver.sha256.slice(0,10)}${parsed.ext}`); try{await fs.access(target)}catch{await fs.copyFile(source,target)}
  const info=rowsFor(wb,'Application_Materials');
  for(const old of info.rows.filter(x=>x.application_id===applicationId&&x.role===role&&!x.deleted_at&&x.mapping_status!=='Candidate'))setCell(info.sheet,old.__rowNumber,info.headers,'deleted_at',now());
  const roleFile = clean(meta.file_role || (role === 'CV_EDITABLE' ? 'Editable Source' : role === 'CV' && String(ver.extension || '').toUpperCase() === 'PDF' ? 'Submission File' : role === 'CV' ? 'Actual Submitted File' : role));
  if (roleFile === 'Editable Source' && !['DOCX', 'DOC'].includes(String(ver.extension || '').toUpperCase())) throw Object.assign(new Error('编辑源文件必须是 Word 可编辑文件（.docx）。'), {code:400});
  if (roleFile === 'ResumeVersion Submission PDF' && String(ver.extension || '').toUpperCase() !== 'PDF') throw Object.assign(new Error('Resume Version 的投递版必须是 PDF 文件。'), {code:400});
  if (roleFile === 'Actual Submitted File' && !['PDF', 'DOCX', 'DOC'].includes(String(ver.extension || '').toUpperCase())) throw Object.assign(new Error('实际提交文件只能是 PDF 或 Word 文件。'), {code:400});
  const row={application_material_id:`appmat-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,application_id:applicationId,role,file_role:roleFile,resume_id:clean(meta.resume_id || ver.material_id),resume_version_name:clean(meta.resume_version_name || ''),material_version_id:materialVersionId,file_name:ver.file_name,original_file_path:ver.file_path,actual_submitted_file_path:roleFile==='Actual Submitted File'?ver.file_path:'',actual_submitted_file_type:roleFile==='Actual Submitted File'?String(ver.extension||'').toUpperCase():'',snapshot_path:target.replaceAll(path.sep,'/'),file_hash:ver.sha256,file_modified_at:ver.modified_at,mapping_status:mappingStatus,mapping_reason:reason,confirmed_at:now(),created_at:now(),updated_at:now(),updated_by:'ui',version:1,deleted_at:''};
  appendRow(info.sheet,info.headers,row); return row;
}

async function confirmApplicationMaterial(payload) {
  const wb=await loadBook(); const app=findApplication(wb,clean(payload.application_id));
  let link; let editable;
  if (clean(payload.role || 'CV') === 'CV') {
    const versions=rowsFor(wb,'Material_Versions').rows;
    const requested=clean(payload.actual_submitted_version_id || payload.material_version_id || payload.submission_version_id || payload.editable_version_id);
    const requestedVersion=versions.find(v=>v.material_version_id===requested&&!v.missing_at);
    const resumeId=clean(payload.resume_id || payload.resume_material_id || payload.material_id || requestedVersion?.material_id);
    const bundle=resumeVersionFiles(wb,resumeId,clean(payload.editable_version_id),clean(payload.submission_version_id));
    const actual=bundle.library && requestedVersion?.material_id===resumeId ? requestedVersion : (bundle.pdf || bundle.docx);
    if (!actual || !['PDF','DOCX','DOC'].includes(String(actual.extension||'').toUpperCase())) throw Object.assign(new Error('请选择实际提交的 PDF 或 Word 文件。'),{code:400});
    const materialRows=rowsFor(wb,'Application_Materials');
    const existing=materialRows.rows.find(x=>x.application_id===app.match.application_id&&x.role==='CV'&&!x.deleted_at&&x.mapping_status==='Confirmed'&&x.material_version_id===actual.material_version_id&&(x.file_role==='Actual Submitted File'||x.file_role==='Submission File'));
    link=existing || await snapshotApplicationMaterial(wb,app.match.application_id,'CV',actual.material_version_id,'Confirmed','Confirmed by user as the actual submitted file',{file_role:'Actual Submitted File',resume_id:resumeId,resume_version_name:bundle.library?.display_name});
    const editableId=clean(payload.editable_version_id || bundle.library?.editable_version_id);
    const editableVersion=editableId?versions.find(v=>v.material_version_id===editableId&&!v.missing_at):null;
    if (editableId && (!editableVersion || !['DOCX','DOC'].includes(String(editableVersion.extension||'').toUpperCase()))) throw Object.assign(new Error('编辑源文件必须是 Word 可编辑文件（.docx）。'),{code:400});
    const existingEditable=editableVersion&&materialRows.rows.find(x=>x.application_id===app.match.application_id&&x.role==='CV_EDITABLE'&&!x.deleted_at&&x.mapping_status==='Confirmed'&&x.material_version_id===editableVersion.material_version_id);
    if (editableVersion && editableVersion.material_version_id!==actual.material_version_id) editable=existingEditable||await snapshotApplicationMaterial(wb,app.match.application_id,'CV_EDITABLE',editableVersion.material_version_id,'Confirmed','Editable source paired with submitted resume version',{file_role:'Editable Source',resume_id:resumeId,resume_version_name:bundle.library?.display_name});
    const actualType=String(actual.extension||'').toUpperCase();
    for(const [key,value] of [['resume_used',link.snapshot_path],['resume_version_id',resumeId],['submitted_resume_id',resumeId],['submitted_snapshot_path',link.snapshot_path],['actual_submitted_file_path',actual.file_path],['actual_submitted_file_name',actual.file_name],['actual_submitted_file_type',actualType],['actual_submitted_file_modified_at',actual.modified_at],['actual_submitted_file_hash',actual.sha256],['submitted_pdf_snapshot',actualType==='PDF'?link.snapshot_path:''],['submitted_pdf_reference',actualType==='PDF'?link.snapshot_path:''],['editable_source_snapshot',editable?.snapshot_path||''],['editable_source_reference',editable?.snapshot_path||''],['confirmed_by_user',true],['confirmed_at',now()],['selected_cv_resume_id',resumeId],['selected_cv_version_id',actual.material_version_id],['selected_cv_submission_version_id',bundle.pdf?.material_version_id||'' ],['selected_cv_editable_version_id',editableVersion?.material_version_id||''],['selected_cv_file_name',actual.file_name],['selected_cv_file_path',actual.file_path],['selected_cv_hash',actual.sha256],['selected_cv_modified_at',actual.modified_at],['selected_cv_status','Submitted'],['selected_cv_updated_at',now()]])setCell(app.sheet,app.match.__rowNumber,app.headers,key,value);
    for(const c of materialRows.rows.filter(x=>x.application_id===app.match.application_id&&x.role==='CV'&&x.mapping_status==='Candidate'&&!x.deleted_at))setCell(materialRows.sheet,c.__rowNumber,materialRows.headers,'deleted_at',now());
  } else {
    link=await snapshotApplicationMaterial(wb,app.match.application_id,clean(payload.role||'CV'),clean(payload.material_version_id),'Confirmed','Confirmed by user in CareerPilot');
  }
  if(link?.role==='Cover Letter')setCell(app.sheet,app.match.__rowNumber,app.headers,'cover_letter_used',link.snapshot_path);
  setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_at',now());setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_by','ui');setCell(app.sheet,app.match.__rowNumber,app.headers,'version',Number(app.match.version||1)+1);
  addAudit(wb,'Confirmed application material',app.match.application_id,'Unknown',link?.snapshot_path || editable?.snapshot_path || '',link?.role || 'CV');await saveBook(wb);return{ok:true,application_material_id:link?.application_material_id || '',editable_material_id:editable?.application_material_id || '',snapshot_path:link?.snapshot_path || '',editable_snapshot_path:editable?.snapshot_path || '',resume_id:clean(payload.resume_id || link?.resume_id || '')};
}

async function setApplicationSelectedMaterial(payload) {
  const wb=await loadBook(); const app=findApplication(wb,clean(payload.application_id));
  const role=clean(payload.role||'CV'); if(!['CV','Cover Letter'].includes(role)) throw Object.assign(new Error('申请材料类型不受支持。'),{code:400});
  const prefix=role==='Cover Letter'?'selected_cover_letter_':'selected_cv_';
  if(clean(payload.selection_status)==='Ignored'){
    for(const key of Object.keys(app.headers)) if(key.startsWith(prefix)) setCell(app.sheet,app.match.__rowNumber,app.headers,key,'');
    setCell(app.sheet,app.match.__rowNumber,app.headers,`${prefix}status`,'Ignored');
    setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_at',now());setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_by','ui');setCell(app.sheet,app.match.__rowNumber,app.headers,'version',Number(app.match.version||1)+1);
    await saveBook(wb); return {ok:true,application_id:app.match.application_id,role,selected:false,submitted:Boolean(role==='CV'?app.match.submitted_pdf_snapshot:app.match.cover_letter_used),status:'Ignored'};
  }
  if(role==='CV'){
    const libraryId=clean(payload.resume_id||payload.material_id); const library=rowsFor(wb,'Material_Library').rows.find(x=>x.material_id===libraryId&&!x.deleted_at); if(!library)throw Object.assign(new Error('请选择一份有效的 Resume Version。'),{code:404});
    const bundle=resumeVersionFiles(wb,libraryId,clean(payload.editable_version_id||library.editable_version_id),clean(payload.submission_version_id||library.submission_version_id));
    const editableId=clean(payload.editable_version_id||library.editable_version_id),submissionId=clean(payload.submission_version_id||library.submission_version_id);
    if(editableId&&!bundle.docx)throw Object.assign(new Error('这里需要选择 Word 可编辑文件（.docx）。'),{code:400});
    if(submissionId&&!bundle.pdf)throw Object.assign(new Error('这里需要选择 PDF 投递文件。'),{code:400});
    const chosen=bundle.pdf||bundle.docx;if(!chosen)throw Object.assign(new Error('这份简历还没有可用的 Word 或 PDF 文件。'),{code:400});
    const values={selected_cv_material_id:libraryId,selected_cv_resume_id:library.resume_id||libraryId,selected_cv_version_id:chosen.material_version_id,selected_cv_editable_version_id:bundle.docx?.material_version_id||'',selected_cv_submission_version_id:bundle.pdf?.material_version_id||'',selected_cv_file_name:chosen.file_name,selected_cv_file_path:chosen.file_path,selected_cv_hash:chosen.sha256,selected_cv_modified_at:chosen.modified_at,selected_cv_version_name:clean(payload.resume_version_name||library.display_name||''),selected_cv_status:clean(payload.selection_status||'Selected'),selected_cv_updated_at:now()};
    for(const [key,value] of Object.entries(values))setCell(app.sheet,app.match.__rowNumber,app.headers,key,value);
    setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_at',now());setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_by','ui');setCell(app.sheet,app.match.__rowNumber,app.headers,'version',Number(app.match.version||1)+1);addAudit(wb,'Selected application material',app.match.application_id,'',chosen.file_name,role);await saveBook(wb);return{ok:true,application_id:app.match.application_id,role,selected:true,submitted:Boolean(app.match.submitted_pdf_snapshot),status:values.selected_cv_status,material_id:libraryId,resume_id:library.resume_id||libraryId,material_version_id:chosen.material_version_id,editable_version_id:values.selected_cv_editable_version_id,submission_version_id:values.selected_cv_submission_version_id,file_name:chosen.file_name};
  }
  const versionId=clean(payload.submission_version_id||payload.material_version_id||payload.selected_version_id||payload.editable_version_id); const versions=rowsFor(wb,'Material_Versions'); const ver=versions.rows.find(v=>v.material_version_id===versionId&&!v.missing_at);
  if(!ver) throw Object.assign(new Error('资料版本不存在或文件已缺失。'),{code:404});
  const libraryId=clean(payload.resume_id||payload.material_id||ver.material_id); const library=rowsFor(wb,'Material_Library').rows.find(x=>x.material_id===libraryId);
  const values={
    [`${prefix}material_id`]:libraryId,
    [`${prefix}version_id`]:ver.material_version_id,
    [`${prefix}editable_version_id`]:clean(payload.editable_version_id),
    [`${prefix}submission_version_id`]:clean(payload.submission_version_id||ver.material_version_id),
    [`${prefix}file_name`]:ver.file_name,
    [`${prefix}file_path`]:ver.file_path,
    [`${prefix}hash`]:ver.sha256,
    [`${prefix}modified_at`]:ver.modified_at,
    [`${prefix}version_name`]:clean(payload.resume_version_name||library?.display_name||ver.file_name),
    [`${prefix}status`]:clean(payload.selection_status||'Selected'),
    [`${prefix}updated_at`]:now(),
  };
  for(const [key,value] of Object.entries(values)) setCell(app.sheet,app.match.__rowNumber,app.headers,key,value);
  if(role==='CV') setCell(app.sheet,app.match.__rowNumber,app.headers,'selected_cv_resume_id',libraryId);
  setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_at',now());setCell(app.sheet,app.match.__rowNumber,app.headers,'updated_by','ui');setCell(app.sheet,app.match.__rowNumber,app.headers,'version',Number(app.match.version||1)+1);
  addAudit(wb,'Selected application material',app.match.application_id,'',ver.file_name,role); await saveBook(wb);
  return {ok:true,application_id:app.match.application_id,role,selected:true,submitted:Boolean(role==='CV'?app.match.submitted_pdf_snapshot:app.match.cover_letter_used),status:values[`${prefix}status`],material_id:libraryId,material_version_id:ver.material_version_id,file_name:ver.file_name};
}

async function addApplicationMaterialCandidate(payload) {
  const wb=await loadBook();findApplication(wb,clean(payload.application_id));findRow(wb,'Material_Versions','material_version_id',clean(payload.material_version_id));const info=rowsFor(wb,'Application_Materials');
  if(info.rows.some(x=>x.application_id===payload.application_id&&x.role===clean(payload.role||'CV')&&x.material_version_id===payload.material_version_id&&!x.deleted_at))return{ok:true,existing:true};
  const ver=rowsFor(wb,'Material_Versions').rows.find(x=>x.material_version_id===payload.material_version_id);const row={application_material_id:`appmat-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,application_id:clean(payload.application_id),role:clean(payload.role||'CV'),material_version_id:clean(payload.material_version_id),original_file_path:ver.file_path,snapshot_path:'',file_hash:ver.sha256,file_modified_at:ver.modified_at,mapping_status:'Candidate',mapping_reason:clean(payload.mapping_reason||'Possible historical match; user confirmation required.'),confirmed_at:'',created_at:now(),updated_at:now(),updated_by:'migration-review',version:1,deleted_at:''};appendRow(info.sheet,info.headers,row);addAudit(wb,'Added application material candidate',row.application_id,'',row.material_version_id,row.mapping_reason);await saveBook(wb);return{ok:true,application_material_id:row.application_material_id};
}

async function saveSetting(payload) {
  const wb=await loadBook(); const info=rowsFor(wb,'Settings'); const key=clean(payload.key); let row=info.rows.find(r=>r.key===key);
  if(row){setCell(info.sheet,row.__rowNumber,info.headers,'value',clean(payload.value));setCell(info.sheet,row.__rowNumber,info.headers,'updated_at',now());setCell(info.sheet,row.__rowNumber,info.headers,'updated_by','ui');setCell(info.sheet,row.__rowNumber,info.headers,'version',Number(row.version||1)+1)}
  else appendRow(info.sheet,info.headers,{key,value:clean(payload.value),value_type:clean(payload.value_type||'text'),description:clean(payload.description),updated_at:now(),updated_by:'ui',version:1});
  addAudit(wb,'Updated setting',key,row?.value||'',clean(payload.value));await saveBook(wb);return{ok:true,key,value:clean(payload.value)};
}

function materialType(name){if(/cover[_ ]?letter|求职信/i.test(name))return'Cover Letter';if(/cv|resume|简历/i.test(name))return'CV / Resume';if(/portfolio|作品集/i.test(name))return'Portfolio';if(/transcript|成绩单/i.test(name))return'Transcript';if(/certificate|证书/i.test(name))return'Certificate';return'Other'}
function materialRole(name){if(/computer.?vision|计算机视觉/i.test(name))return'AI / ML / Computer Vision';if(/fpga|hardware|embedded/i.test(name))return'FPGA / Hardware';if(/risk|finance|bank|blackrock|bnp|cmsi|merchant|susquehanna/i.test(name))return'Risk / Banking';if(/data|analytics/i.test(name))return'Data';if(/graduate|毕业生|management.?trainee|\bmt\b/i.test(name))return'Graduate / MT';if(/ai|llm|machine.?learning/i.test(name))return'AI / ML';return''}
async function walkFiles(dir){const out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(e.isDirectory()){if(e.name.toLowerCase()!=='snapshots')out.push(...await walkFiles(full))}else if(e.isFile())out.push(full)}return out}

async function rescanMaterials(payload) {
  const wb=await loadBook(); const settings=rowsFor(wb,'Settings'); const settingKey=clean(payload.setting_key||'materials_root')||'materials_root'; const defaultRoot=settingKey==='approved_resumes_root'?path.join(materialsRootDefault,'approved_resumes'):materialsRootDefault; const configured=clean(payload.path||settings.rows.find(r=>r.key===settingKey)?.value||defaultRoot); const root=path.resolve(configured);
  const stat=await fs.stat(root).catch(()=>null);if(!stat?.isDirectory())throw Object.assign(new Error('The materials folder does not exist.'),{code:400});
  const files=(await walkFiles(root)).filter(f=>!/^~\$/.test(path.basename(f))&&!/\.tmp$/i.test(f)&&!/密码/.test(path.basename(f)));
  const libs=rowsFor(wb,'Material_Library'),versions=rowsFor(wb,'Material_Versions');const seen=new Set();let added=0,changed=0;
  for(const file of files){const s=await fs.stat(file),bytes=await fs.readFile(file),hash=crypto.createHash('sha256').update(bytes).digest('hex'),fp=file.replaceAll(path.sep,'/'),rel=path.relative(root,file).replaceAll(path.sep,'/');seen.add(fp.toLowerCase());let current=versions.rows.filter(v=>v.file_path.toLowerCase()===fp.toLowerCase()&&!v.missing_at).sort((a,b)=>b.modified_at.localeCompare(a.modified_at))[0];if(current?.sha256===hash)continue;
    const key=`${path.dirname(rel).toLowerCase()}|${path.parse(file).name.toLowerCase()}|${materialType(file)}`;let lib=libs.rows.find(x=>x.notes.includes(`scan-key:${key}`))||libs.rows.find(x=>x.display_name.toLowerCase()===path.parse(file).name.toLowerCase()&&x.material_type===materialType(file));
     if(!lib){const materialId=`lib-${crypto.createHash('sha1').update(key).digest('hex').slice(0,12)}`;const relativeDir=path.dirname(rel).replaceAll(path.sep,'/');const isManagedLibraryPath=/^active(?:\/|$)/i.test(relativeDir);const company=relativeDir==='.'||isManagedLibraryPath?'':relativeDir.split('/')[0];lib={material_id:materialId,display_name:path.parse(file).name,material_type:materialType(file),library_section:company?'Company Application':'General Library',role_family:materialRole(`${rel} ${file}`),company,job_title:'',default_for:'',latest_version_id:'',status:'Active',tags:[company,materialRole(file)].filter(Boolean).join('; '),notes:`scan-key:${key}`,created_at:now(),updated_at:now(),updated_by:'scanner',version:1,deleted_at:'',approved_for_use:false,content_reference:false,format_template:false};appendRow(libs.sheet,libs.headers,lib);added++}
    if(current){setCell(versions.sheet,current.__rowNumber,versions.headers,'status','Superseded');changed++}
    const versionId=`ver-${crypto.createHash('sha1').update(`${fp}|${hash}`).digest('hex').slice(0,12)}`;appendRow(versions.sheet,versions.headers,{material_version_id:versionId,material_id:lib.material_id,file_name:path.basename(file),relative_path:rel,file_path:fp,extension:path.extname(file).slice(1).toUpperCase(),file_size:s.size,modified_at:s.mtime.toISOString(),sha256:hash,version_label:'',format:path.extname(file).slice(1).toUpperCase(),status:'Active',scan_id:`scan-${Date.now()}`,created_at:now(),updated_at:now(),updated_by:'scanner',version:1,missing_at:''});const live=libs.rows.find(x=>x.material_id===lib.material_id);if(live){setCell(libs.sheet,live.__rowNumber,libs.headers,'latest_version_id',versionId);setCell(libs.sheet,live.__rowNumber,libs.headers,'updated_at',now())}added++;
  }
  for(const v of versions.rows.filter(v=>v.status==='Active'&&!v.missing_at)){if(v.file_path.toLowerCase().startsWith(root.replaceAll(path.sep,'/').toLowerCase())&&!seen.has(v.file_path.toLowerCase())){setCell(versions.sheet,v.__rowNumber,versions.headers,'missing_at',now());setCell(versions.sheet,v.__rowNumber,versions.headers,'status','Missing')}}
  const upsert=(key,value)=>{const r=settings.rows.find(x=>x.key===key);if(r){setCell(settings.sheet,r.__rowNumber,settings.headers,'value',value);setCell(settings.sheet,r.__rowNumber,settings.headers,'updated_at',now())}else appendRow(settings.sheet,settings.headers,{key,value,value_type:'text',description:'',updated_at:now(),updated_by:'scanner',version:1})};const rootValue=root.replaceAll(path.sep,'/'),scannedAt=now();upsert(settingKey,rootValue);upsert(`${settingKey}_last_scanned`,scannedAt);upsert(`${settingKey}_scan_status`,`Ready: ${files.length} files; ${added} added/versioned; ${changed} superseded`);if(settingKey==='materials_root'){upsert('materials_last_scanned',scannedAt);upsert('materials_scan_status',`Ready: ${files.length} files; ${added} added/versioned; ${changed} superseded`)}
  addAudit(wb,'Rescanned materials',settingKey, '', `${files.length} files`, `${added} added/versioned; ${changed} superseded`);await saveBook(wb);return{ok:true,path:rootValue,files:files.length,added,changed,setting_key:settingKey};
}

async function createSearchRun(payload) {
  const wb=await loadBook(); const info=rowsFor(wb,'Search_Runs'); const runId=`search-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const row={search_run_id:runId,routine_id:clean(payload.routine_id),created_at:now(),requested_by:'ui',status:'Requested',location:clean(payload.location),role_families:clean(payload.role_families),graduation_year:clean(payload.graduation_year),company_types:clean(payload.company_types),keywords:clean(payload.keywords),negative_keywords:clean(payload.negative_keywords),sources:clean(payload.sources),progress_json:JSON.stringify({phase:'queued',message:'等待在 Codex 中执行搜索、验证和去重'}),employers_checked:0,sources_checked:0,found_count:0,existing_count:0,invalid_count:0,new_count:0,started_at:'',completed_at:'',notes:'The local UI cannot browse or run while closed. This request is visible to the agent and does not pretend to have searched.',updated_at:now(),version:1};appendRow(info.sheet,info.headers,row);addAudit(wb,'Created search request',runId,'',JSON.stringify({location:row.location,roles:row.role_families,sources:row.sources}));await saveBook(wb);return{ok:true,search_run_id:runId,status:'Requested'};
}

async function updateSearchRun(payload) {
  const wb=await loadBook(); const info=findRow(wb,'Search_Runs','search_run_id',clean(payload.search_run_id),payload.expected_version);for(const key of ['status','progress_json','employers_checked','sources_checked','found_count','existing_count','invalid_count','new_count','started_at','completed_at','notes'])if(payload[key]!==undefined)setCell(info.sheet,info.match.__rowNumber,info.headers,key,clean(payload[key]));setCell(info.sheet,info.match.__rowNumber,info.headers,'updated_at',now());setCell(info.sheet,info.match.__rowNumber,info.headers,'version',Number(info.match.version||1)+1);addAudit(wb,'Updated search run',info.match.search_run_id,info.match.status,clean(payload.status||info.match.status));await saveBook(wb);return{ok:true,search_run_id:info.match.search_run_id};
}

const writeActions = new Set(['update-job','recheck-job','add-job','trash-job','restore-job','permanent-delete-job','save-profile','save-preferences','update-routine','mark-applied','update-material','associate-material-version','add-material','set-material-default','trash-material','restore-material','add-calendar-event','update-calendar-event','delete-calendar-event','add-application-event','update-application-event','delete-application-event','confirm-application-material','set-application-selected-material','add-application-material-candidate','save-setting','rescan-materials','rescan-approved-materials','create-search-run','update-search-run']);

async function executeAction(action, payload) {
  if (action === 'snapshot') return snapshot();
  if (action === 'update-job') return updateJob(payload);
  if (action === 'recheck-job') return recheckJob(payload);
  if (action === 'add-job') return addJob(payload);
  if (action === 'trash-job') return trashJob(payload);
  if (action === 'restore-job') return restoreJob(payload);
  if (action === 'permanent-delete-job') return permanentlyDeleteJob(payload);
  if (action === 'save-profile') return saveRows('Profile', payload.rows);
  if (action === 'save-preferences') return saveRows('Preferences', payload.rows);
  if (action === 'update-routine') return updateRoutine(payload);
  if (action === 'mark-applied') return markApplied(payload);
  if (action === 'update-material') return updateMaterial(payload);
  if (action === 'associate-material-version') return associateMaterialVersion(payload);
  if (action === 'add-material') return addMaterial(payload);
  if (action === 'set-material-default') return setMaterialDefault(payload);
  if (action === 'trash-material') return trashMaterial(payload);
  if (action === 'restore-material') return restoreMaterial(payload);
  if (action === 'add-calendar-event') return addCalendarEvent(payload);
  if (action === 'update-calendar-event') return updateCalendarEvent(payload);
  if (action === 'delete-calendar-event') return deleteCalendarEvent(payload);
  if (action === 'add-application-event') return addApplicationEvent(payload);
  if (action === 'update-application-event') return updateApplicationEvent(payload);
  if (action === 'delete-application-event') return deleteApplicationEvent(payload);
  if (action === 'confirm-application-material') return confirmApplicationMaterial(payload);
  if (action === 'set-application-selected-material') return setApplicationSelectedMaterial(payload);
  if (action === 'add-application-material-candidate') return addApplicationMaterialCandidate(payload);
  if (action === 'save-setting') return saveSetting(payload);
  if (action === 'rescan-materials') return rescanMaterials(payload);
  if (action === 'rescan-approved-materials') return rescanMaterials({ ...payload, setting_key: 'approved_resumes_root' });
  if (action === 'create-search-run') return createSearchRun(payload);
  if (action === 'update-search-run') return updateSearchRun(payload);
  throw Object.assign(new Error(`Unknown action: ${action}`), { code: 400 });
}

export async function dispatch(action, payload = {}) {
  const release = writeActions.has(action) ? await acquireMasterLock() : null;
  try { return await executeAction(action, payload); }
  finally { if (release) await release(); }
}

async function main() {
  const result = await dispatch(process.argv[2] || 'snapshot', JSON.parse(process.argv[3] || '{}'));
  await flushPersistence();
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(err => { process.stderr.write(err.stack || String(err)); process.exitCode = Number.isInteger(err.code) ? err.code : 1; });
}
