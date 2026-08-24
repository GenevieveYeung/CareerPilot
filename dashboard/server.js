// Zero-dependency static file server for the local job-search dashboard.
// Serves the CareerPilot dashboard and its local APIs.
// the CSV files with fresh data on every reload. Also exposes write
// endpoints so the dashboard can:
//   - mark a job as Offer/Rejected (POST /api/update-status)
//   - add/edit/delete an upcoming calendar event, which also stamps the
//     job's current_stage in job_pool.csv (POST /api/calendar/*)
const http = require('http');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const { pathToFileURL } = require('url');
const { getProjectPaths } = require('../core/project_paths.cjs');

const ROOT = __dirname;
const PROJECT_PATHS = getProjectPaths({ repoRoot: path.resolve(ROOT, '..') });
const PORT = Number(process.env.CAREERPILOT_PORT || PROJECT_PATHS.settings.port || 8420);
const JOB_POOL_PATH = PROJECT_PATHS.legacyJobPoolPath;
const FOLLOW_UP_PATH = PROJECT_PATHS.legacyFollowUpPath;
const MASTER_API_PATH = path.join(ROOT, '..', 'core', 'master_api.mjs');
let MATERIALS_ROOT = path.resolve(process.env.CAREERPILOT_MATERIALS_ROOT || PROJECT_PATHS.materialsRoot);
const API_ERROR_LOG = process.env.CAREERPILOT_API_ERROR_LOG || PROJECT_PATHS.apiErrorLog;
const PERFORMANCE_LOG = process.env.CAREERPILOT_PERFORMANCE_LOG || PROJECT_PATHS.performanceLog;
const CAREERPILOT_RUNTIME_DIR = PROJECT_PATHS.runtimeDir;
const CAREERPILOT_STATE_DIR = PROJECT_PATHS.stateDir;
const MASTER_PATH = process.env.CAREERPILOT_MASTER_PATH || PROJECT_PATHS.masterPath;
const SNAPSHOT_CACHE_PATH = process.env.CAREERPILOT_SNAPSHOT_CACHE_PATH || PROJECT_PATHS.snapshotCachePath;
const RUNTIME_STATE_PATH = process.env.CAREERPILOT_RUNTIME_STATE_PATH || PROJECT_PATHS.runtimeStatePath;
const RUNTIME_MIRROR_SCRIPT = path.join(ROOT, '..', 'core', 'sync_runtime_mirror.mjs');
const MASTER_API_MODULE_URL = pathToFileURL(MASTER_API_PATH).href;
let masterModulePromise = null;
function getMasterModule() { if (!masterModulePromise) masterModulePromise = import(MASTER_API_MODULE_URL); return masterModulePromise; }
const RUNTIME_STATE_MODULE_URL = pathToFileURL(path.join(ROOT, '..', 'core', 'runtime_state.mjs')).href;
const runtimeModulePromise = import(RUNTIME_STATE_MODULE_URL);
const REMINDER_SERVICE_MODULE_URL = pathToFileURL(path.join(ROOT, '..', 'core', 'reminder_service.mjs')).href;
const REMINDER_SECRET_MODULE_URL = pathToFileURL(path.join(ROOT, '..', 'core', 'reminder_secrets.mjs')).href;
const SMTP_MODULE_URL = pathToFileURL(path.join(ROOT, '..', 'core', 'smtp_client.mjs')).href;
const PROFILE_SERVICE_MODULE_URL = pathToFileURL(path.join(ROOT, '..', 'core', 'profile_service.mjs')).href;
const reminderServicePromise = import(REMINDER_SERVICE_MODULE_URL);
const reminderSecretsPromise = import(REMINDER_SECRET_MODULE_URL);
const smtpPromise = import(SMTP_MODULE_URL);
const profileServicePromise = import(PROFILE_SERVICE_MODULE_URL);
const startupAt = Date.now();
let snapshotCache = null;
let snapshotCacheMtime = null;
let snapshotSource = null;
let snapshotLoading = null;
let masterWriteQueue = Promise.resolve();
let runtimeMirrorTimer = null;
let runtimeMirrorProcess = null;
let runtimeMirrorPending = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function runMasterAction(action, payload = {}) {
  const output = childProcess.execFileSync(process.execPath, [MASTER_API_PATH, action, JSON.stringify(payload)], {
    cwd: path.dirname(MASTER_API_PATH), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  return parseMasterOutput(output);
}

function parseMasterOutput(raw) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text); } catch (_) { /* artifact tooling may print diagnostics before the JSON result */ }
  for (let start = 0; start < text.length; start = text.indexOf('{', start + 1)) {
    if (start < 0) break;
    try {
      const parsed = JSON.parse(text.slice(start));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) { /* try the next JSON object boundary */ }
  }
  throw new Error(`Master action returned non-JSON output: ${text.slice(0, 240)}`);
}

function runMasterActionAsync(action, payload = {}) {
  return getMasterModule().then(module => module.dispatch(action, payload));
}

function logPerformance(name, durationMs, details = {}) {
  try {
    fs.mkdirSync(path.dirname(PERFORMANCE_LOG), { recursive:true });
    fs.appendFileSync(PERFORMANCE_LOG, JSON.stringify({ timestamp:new Date().toISOString(), name, duration_ms:durationMs, ...details }) + '\n', 'utf8');
  } catch (_) { /* performance logging must never block a request */ }
}

function persistLocalProjectSetting(key, value) {
  if (!['materials_root', 'approved_resumes_root', 'language'].includes(String(key || ''))) return;
  try {
    const current = fs.existsSync(PROJECT_PATHS.settingsPath)
      ? JSON.parse(fs.readFileSync(PROJECT_PATHS.settingsPath, 'utf8'))
      : {};
    current[key] = String(value || '');
    current.updated_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(PROJECT_PATHS.settingsPath), { recursive: true });
    const temp = `${PROJECT_PATHS.settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, PROJECT_PATHS.settingsPath);
    if (key === 'materials_root' && value) MATERIALS_ROOT = path.resolve(String(value));
  } catch (error) {
    logApiError({ method: 'LOCAL_SETTINGS', url: '/api/master/settings/save' }, 500, String(error), { key });
  }
}

function masterMtime() { try { return fs.statSync(MASTER_PATH).mtimeMs; } catch (_) { return null; } }
function runtimeStateMtime() { try { return fs.statSync(RUNTIME_STATE_PATH).mtimeMs; } catch (_) { return null; } }

function writeSnapshotCache(snapshot, mtime) {
  try {
    const dir = path.dirname(SNAPSHOT_CACHE_PATH); fs.mkdirSync(dir, { recursive:true });
    const tmp = `${SNAPSHOT_CACHE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ master_mtime_ms:mtime, cached_at:new Date().toISOString(), snapshot }), 'utf8');
    fs.renameSync(tmp, SNAPSHOT_CACHE_PATH);
  } catch (_) { /* cache is an optimization, not a source of truth */ }
}

function loadSnapshotCache() {
  try {
    const runtime = JSON.parse(fs.readFileSync(RUNTIME_STATE_PATH, 'utf8'));
    if (runtime?.snapshot) {
      // Do not expose a raw runtime JSON snapshot here. It may contain a
      // stale derived summary from before the hot/cold split. Let the
      // repository normalize it once during startup, then cache that result.
      snapshotCache = null;
      snapshotCacheMtime = runtimeStateMtime();
      snapshotSource = 'runtime-state';
      logPerformance('runtime state detected', Date.now() - startupAt, { source:'runtime-state' });
      return;
    }
  } catch (_) { /* first migration or incomplete state */ }
  try {
    const cached = JSON.parse(fs.readFileSync(SNAPSHOT_CACHE_PATH, 'utf8'));
    if (cached?.snapshot && cached.master_mtime_ms === masterMtime()) {
      snapshotCache = cached.snapshot; snapshotCacheMtime = cached.master_mtime_ms; snapshotSource = 'excel-cache';
      logPerformance('snapshot cache loaded', Date.now() - startupAt, { source:'disk-cache' });
    }
  } catch (_) { /* first run or incomplete cache */ }
}

function refreshSnapshot() {
  if (snapshotLoading) return snapshotLoading;
  const started = Date.now();
  snapshotLoading = runtimeModulePromise.then(async runtime => {
    if (await runtime.hasState()) {
      const result = await runtime.getSnapshot();
      snapshotCache = result; snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
      writeSnapshotCache(result, masterMtime());
      logPerformance('runtime snapshot read', Date.now() - started, { source:'runtime-state', jobs:result.jobs?.length || 0, applications:result.applications?.length || 0 });
      return result;
    }
    return runMasterActionAsync('snapshot', {});
  }).then(result => {
    if (snapshotSource !== 'runtime-state') {
      snapshotCache = result; snapshotCacheMtime = masterMtime(); snapshotSource = 'excel-cache';
      writeSnapshotCache(result, snapshotCacheMtime);
      logPerformance('startup workbook load', Date.now() - started, { source:'master-workbook', jobs:result.jobs?.length || 0, applications:result.applications?.length || 0 });
    }
    return result;
  }).finally(() => { snapshotLoading = null; });
  return snapshotLoading;
}

async function getSnapshotCached() {
  if (snapshotSource === 'runtime-state' && snapshotCache && runtimeStateMtime() === snapshotCacheMtime) return snapshotCache;
  const current = masterMtime();
  return snapshotSource === 'excel-cache' && snapshotCache && snapshotCacheMtime === current ? snapshotCache : await refreshSnapshot();
}

function invalidateSnapshotCache() { snapshotCacheMtime = null; }

function enqueueMasterWrite(task) {
  const run = masterWriteQueue.then(task, task);
  masterWriteQueue = run.catch(() => {});
  return run;
}

function scheduleRuntimeMirror() {
  if (!fs.existsSync(RUNTIME_STATE_PATH)) return;
  if (runtimeMirrorProcess) { runtimeMirrorPending = true; return; }
  if (runtimeMirrorTimer) clearTimeout(runtimeMirrorTimer);
  runtimeMirrorTimer = setTimeout(() => {
    runtimeMirrorTimer = null;
    runtimeMirrorProcess = childProcess.spawn(process.execPath, [RUNTIME_MIRROR_SCRIPT], {
      cwd: ROOT, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, CAREERPILOT_RUNTIME_STATE_PATH: RUNTIME_STATE_PATH, CAREERPILOT_RUNTIME_MIRROR_PATH: MASTER_PATH },
    });
    runtimeMirrorProcess.on('exit', () => {
      runtimeMirrorProcess = null;
      if (runtimeMirrorPending) { runtimeMirrorPending = false; scheduleRuntimeMirror(); }
    });
    runtimeMirrorProcess.on('error', () => { runtimeMirrorProcess = null; });
  }, 750);
}

loadSnapshotCache();
if (snapshotSource === 'runtime-state') scheduleRuntimeMirror();
if (!snapshotCache) refreshSnapshot().catch(error => logApiError({ method:'STARTUP', url:'/api/master/snapshot' }, 500, String(error), {}));

function redactPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const copy = Array.isArray(payload) ? payload.slice() : { ...payload };
  for (const key of ['base64','password','token','otp','cookie','auth_code','authorization_code','smtp_auth_code','secret']) if (key in copy) copy[key] = '[redacted]';
  for (const key of Object.keys(copy)) if (copy[key] && typeof copy[key] === 'object') copy[key] = redactPayload(copy[key]);
  return copy;
}

function logApiError(req, status, error, payload = {}) {
  try {
    fs.mkdirSync(path.dirname(API_ERROR_LOG), { recursive: true });
    fs.appendFileSync(API_ERROR_LOG, JSON.stringify({ timestamp:new Date().toISOString(), method:req.method, endpoint:req.url, status, error, payload:redactPayload(payload) }) + '\n', 'utf8');
  } catch (_) { /* logging must never mask the API error */ }
}

function handleMasterAction(action) {
  return async (req, res) => {
    let payload = {};
    try { payload = await readJSONBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
    return enqueueMasterWrite(async () => {
      try {
        // Never run workbook work on the Node request thread, and do not let
        // a second write race the cache refresh started by the previous one.
        if (snapshotLoading) await snapshotLoading.catch(() => {});
        const runtime = await runtimeModulePromise;
        if (await runtime.hasState()) {
          const started = Date.now();
          const result = await runtime.applyAction(action, payload);
          if (action === 'save-setting') persistLocalProjectSetting(payload.key, payload.value);
          snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
          writeSnapshotCache(snapshotCache, masterMtime());
          scheduleRuntimeMirror();
          logPerformance('runtime write', Date.now() - started, { action, jobs:snapshotCache.jobs?.length || 0, applications:snapshotCache.applications?.length || 0 });
          return sendJSON(res, 200, { ok: true, data: result, ...result });
        }
        const result = await runMasterActionAsync(action, payload);
        if (action === 'save-setting') persistLocalProjectSetting(payload.key, payload.value);
        invalidateSnapshotCache();
        // The Excel fallback must not acknowledge a write before the cached
        // projection has been refreshed. Otherwise the UI can immediately
        // reload and observe the previous snapshot, which looks like a lost
        // event and breaks Application → Calendar consistency.
        await refreshSnapshot();
        return sendJSON(res, 200, { ok: true, data: result, ...result });
      }
      catch (e) {
        const status = Number(e.statusCode || e.code);
        const httpStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
        logApiError(req, httpStatus, String(e.stderr || e.message || e), payload);
        return sendJSON(res, httpStatus, { ok: false, error: httpStatus === 409 ? 'CONFLICT' : httpStatus === 404 ? 'NOT_FOUND' : 'INTERNAL_ERROR', message: '保存失败，请重试。' });
      }
    });
  };
}

async function handleMasterSnapshot(req, res) {
  try {
    const current = masterMtime();
    const result = snapshotSource === 'runtime-state' && snapshotCache && runtimeStateMtime() === snapshotCacheMtime
      ? snapshotCache
      : snapshotSource === 'excel-cache' && snapshotCache && snapshotCacheMtime === current
        ? snapshotCache
        : await refreshSnapshot();
    // Snapshot consumers use the top-level normalized projection. Do not
    // serialize the complete snapshot a second time under `data`.
    return sendJSON(res, 200, { ok:true, ...result });
  }
  catch (e) { logApiError(req,500,String(e.stderr || e.message || e),{}); return sendJSON(res, 500, { ok: false, error:'INTERNAL_ERROR', message: String(e.stderr || e.message || e) }); }
}

async function handleProfileAutofillMap(req, res) {
  try {
    let payload = {};
    if (req.method === 'POST') payload = await readJSONBody(req);
    else {
      const query = new URL(req.url, 'http://127.0.0.1').searchParams;
      payload = { education_level: query.get('education_level') || '', region: query.get('region') || '' };
    }
    const [snapshot, service] = await Promise.all([getSnapshotCached(), profileServicePromise]);
    const result = service.buildProfileAutofill(snapshot.profile || [], payload);
    return sendJSON(res, 200, { ok: true, data: result, ...result });
  } catch (error) {
    logApiError(req, 500, String(error?.message || error), {});
    return sendJSON(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: '个人资料映射暂时无法读取。' });
  }
}

function handleMasterDownload(req, res) {
  const masterFile = MASTER_PATH;
  fs.readFile(masterFile, (err, content) => {
    if (err) { sendJSON(res, 404, { ok:false, error:'NOT_FOUND', message:'主数据文件暂时不可用。' }); return; }
    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="careerpilot_master.xlsx"', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

function safeMaterialFile(relativePath) {
  const resolved = path.resolve(MATERIALS_ROOT, String(relativePath || '').replaceAll('/', path.sep));
  if (resolved !== MATERIALS_ROOT && !resolved.startsWith(MATERIALS_ROOT + path.sep)) return null;
  return resolved;
}

async function handleMaterialFile(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const materialId = requestUrl.searchParams.get('id') || '';
    const snapshot = await getSnapshotCached();
    const material = (snapshot.materials || []).find(m => m.material_id === materialId && !m.deleted_at && m.status !== 'Trash');
    if (!material) return sendJSON(res, 404, { ok:false, error:'资料不存在' });
    const filePath = safeMaterialFile(material.relative_path);
    if (!filePath || !fs.existsSync(filePath)) return sendJSON(res, 404, { ok:false, error:'资料文件已缺失' });
    const ext = path.extname(filePath).toLowerCase();
    const disposition = ext === '.pdf' || ['.png','.jpg','.jpeg'].includes(ext) ? 'inline' : 'attachment';
    res.writeHead(200, {'Content-Type': MIME[ext] || 'application/octet-stream','Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,'Cache-Control':'no-store'});
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { return sendJSON(res, 500, {ok:false,error:e.message}); }
}

async function handleMaterialVersionFile(req, res) {
  try {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    const versionId = requestUrl.searchParams.get('id') || '';
    const snapshot = await getSnapshotCached();
    const version = (snapshot.materialVersions || []).find(v => v.material_version_id === versionId && !v.missing_at);
    if (!version) return sendJSON(res, 404, {ok:false,error:'资料版本不存在或文件已缺失'});
    const filePath = path.resolve(String(version.file_path || '').replaceAll('/', path.sep));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJSON(res,404,{ok:false,error:'文件不存在'});
    const ext=path.extname(filePath).toLowerCase(), disposition=ext==='.pdf'||['.png','.jpg','.jpeg'].includes(ext)?'inline':'attachment';
    res.writeHead(200,{'Content-Type':MIME[ext]||'application/octet-stream','Content-Disposition':`${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,'Cache-Control':'no-store'});
    fs.createReadStream(filePath).pipe(res);
  } catch(e){return sendJSON(res,500,{ok:false,error:e.message});}
}

async function handleApplicationMaterialFile(req, res) {
  try {
    const id = new URL(req.url, 'http://127.0.0.1').searchParams.get('id') || '';
    const snapshot = await getSnapshotCached();
    const link = (snapshot.applicationMaterials || []).find(row => row.application_material_id === id && !row.deleted_at);
    if (!link || !link.snapshot_path) return sendJSON(res, 404, { ok:false, error:'申请资料快照不存在或文件已缺失' });
    const filePath = path.resolve(String(link.snapshot_path).replaceAll('/', path.sep));
    const root = path.resolve(MATERIALS_ROOT);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) return sendJSON(res, 403, { ok:false, error:'申请资料路径无效' });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendJSON(res, 404, { ok:false, error:'申请时的文件快照已找不到' });
    const ext = path.extname(filePath).toLowerCase(); const disposition = ext === '.pdf' || ['.png','.jpg','.jpeg'].includes(ext) ? 'inline' : 'attachment';
    res.writeHead(200, {'Content-Type':MIME[ext] || 'application/octet-stream','Content-Disposition':`${disposition}; filename*=UTF-8''${encodeURIComponent(path.basename(filePath))}`,'Cache-Control':'no-store'});
    fs.createReadStream(filePath).pipe(res);
  } catch (e) { return sendJSON(res,500,{ok:false,error:'申请资料快照读取失败'}); }
}

async function handleOpenMaterialsFolder(req,res){
  try {
    let payload={};try{payload=await readJSONBody(req)}catch(_){ }
    const snapshot=await getSnapshotCached(), configured=(snapshot.settings||[]).find(x=>x.key==='materials_root')?.value||MATERIALS_ROOT;
    const folder=path.resolve(String(payload.path||configured).replaceAll('/',path.sep));
    if(!fs.existsSync(folder)||!fs.statSync(folder).isDirectory())return sendJSON(res,400,{ok:false,error:'资料目录不存在'});
    childProcess.spawn('explorer.exe',[folder],{detached:true,stdio:'ignore'}).unref();
    return sendJSON(res,200,{ok:true,path:folder});
  } catch (e) {
    return sendJSON(res,500,{ok:false,error:'INTERNAL_ERROR',message:'无法打开资料文件夹'});
  }
}

async function handleBrowseMaterialsFolder(req,res){
  try{
    const script="Add-Type -AssemblyName System.Windows.Forms; $d=New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description='选择求职资料文件夹'; $d.ShowNewFolderButton=$true; if($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK){[Console]::OutputEncoding=[Text.Encoding]::UTF8; Write-Output $d.SelectedPath}";
    const selected=childProcess.execFileSync('powershell.exe',['-NoProfile','-STA','-Command',script],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024}).trim();
    return sendJSON(res,200,{ok:true,cancelled:!selected,path:selected.replaceAll(path.sep,'/')});
  }catch(e){return sendJSON(res,500,{ok:false,error:'无法打开文件夹选择器：'+e.message});}
}

async function handleEnsureApprovedFolder(req, res) {
  try {
    let payload = {}; try { payload = await readJSONBody(req); } catch (_) { }
    const root = path.resolve(MATERIALS_ROOT);
    const requested = path.resolve(String(payload.path || path.join(root, 'approved_resumes')).replaceAll('/', path.sep));
    if (requested !== root && !requested.startsWith(root + path.sep)) return sendJSON(res, 400, { ok:false, error:'INVALID_PATH', message:'满意简历文件夹必须位于求职资料目录内。' });
    fs.mkdirSync(requested, { recursive:true });
    return sendJSON(res, 200, { ok:true, path:requested.replaceAll(path.sep, '/') });
  } catch (e) {
    return sendJSON(res, 500, { ok:false, error:'FOLDER_CREATE_FAILED', message:'无法创建满意简历文件夹。' });
  }
}

async function handleMaterialImport(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch(e) { return sendJSON(res,400,{ok:false,error:e.message}); }
  const original = path.basename(String(payload.file_name || '')).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_');
  const ext = path.extname(original).toLowerCase();
  if (!original || !['.pdf','.docx','.doc','.png','.jpg','.jpeg'].includes(ext)) return sendJSON(res,400,{ok:false,error:'支持的文件类型：PDF、DOCX、DOC、PNG、JPG。'});
  const type = String(payload.material_type || 'Other');
  const folderMap = {'CV / Resume':'cv','Cover Letter':'cover_letters','Portfolio':'portfolio','Transcript':'transcripts','Certificate':'certificates','Reference':'references','Other':'other'};
  const subdir = folderMap[type] || 'other';
  let bytes; try { bytes = Buffer.from(String(payload.base64 || ''),'base64'); } catch(e) { return sendJSON(res,400,{ok:false,error:'文件数据无效'}); }
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) return sendJSON(res,400,{ok:false,error:'文件大小必须在 1 字节至 15 MB 之间。'});
  const targetDir = safeMaterialFile(path.join('active', subdir));
  fs.mkdirSync(targetDir,{recursive:true});
  const pairId = String(payload.pair_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  const pairName = path.basename(String(payload.pair_name || path.parse(original).name)).replace(/[<>:"/\\|?*\x00-\x1F]/g,'_').slice(0, 120);
  const targetName = pairId ? `${pairName}_${pairId}${ext}` : original;
  let target = path.join(targetDir, targetName);
  if (fs.existsSync(target)) target = path.join(targetDir, `${path.parse(original).name}_${Date.now()}${ext}`);
  fs.writeFileSync(target, bytes, {flag:'wx'});
  const relativePath = path.relative(MATERIALS_ROOT,target).replaceAll(path.sep,'/');
  try {
    const result = await enqueueMasterWrite(async () => {
      if (snapshotLoading) await snapshotLoading.catch(() => {});
      const payloadForStore = { display_name:payload.display_name || path.parse(original).name,file_name:path.basename(target),relative_path:relativePath,file_path:target.replaceAll(path.sep,'/'),material_type:type,tags:payload.tags || '',target_role:payload.target_role || '',notes:payload.notes || '' };
      const started = Date.now();
      const runtime = await runtimeModulePromise;
      if (await runtime.hasState()) {
        const value = await runtime.applyAction('add-material', payloadForStore);
        snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
        writeSnapshotCache(snapshotCache, masterMtime()); scheduleRuntimeMirror();
        logPerformance('runtime material import', Date.now() - started, { material_type:type });
        return value;
      }
      const value = await runMasterActionAsync('add-material', payloadForStore);
      invalidateSnapshotCache();
      refreshSnapshot().catch(error => logApiError({ method:'CACHE_REFRESH', url:req.url }, 500, String(error.stderr || error.message || error), {}));
      return value;
    });
    return sendJSON(res,200,{ok:true,data:result,...result,imported_file_path:target.replaceAll(path.sep,'/'),imported_file_name:path.basename(target),imported_relative_path:relativePath});
  } catch(e) {
    try { fs.unlinkSync(target); } catch (_) {}
    return sendJSON(res,500,{ok:false,error:String(e.stderr || e.message || e)});
  }
}

function resumeUploadFile(payload, key, expectedExtension) {
  const input = payload?.[key] && typeof payload[key] === 'object' ? payload[key] : {};
  const fileName = path.basename(String(input.file_name || payload?.[`${key}_file_name`] || '')).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  const ext = path.extname(fileName).toLowerCase();
  if (!fileName || ext !== expectedExtension) throw Object.assign(new Error(expectedExtension === '.docx' ? '编辑版需要 Word 文件（.docx）。' : '投递版需要 PDF 文件（.pdf）。'), { code: 400 });
  let bytes;
  try { bytes = Buffer.from(String(input.base64 || payload?.[`${key}_base64`] || ''), 'base64'); } catch (_) { bytes = Buffer.alloc(0); }
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw Object.assign(new Error('文件大小必须在 1 字节至 15 MB 之间。'), { code: 400 });
  return { fileName, bytes, ext };
}

function writeResumeUpload(file, label) {
  const targetDir = safeMaterialFile(path.join('active', 'cv'));
  fs.mkdirSync(targetDir, { recursive: true });
  const stem = path.parse(file.fileName).name.slice(0, 120) || label;
  const targetName = `${stem}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}${file.ext}`;
  const target = path.join(targetDir, targetName);
  fs.writeFileSync(target, file.bytes, { flag: 'wx' });
  return { target, fileName: targetName, originalName: file.fileName };
}

async function handleResumeVersionImport(req, res) {
  let payload = {};
  try { payload = await readJSONBody(req); } catch (error) { return sendJSON(res, 400, { ok:false, error:'INVALID_JSON', message:'上传资料失败，请重试。' }); }
  let docx = null, pdf = null, created = [];
  try {
    const hasDocx = Boolean(payload.editable || payload.editable_file_name || payload.editable_file_base64);
    const hasPdf = Boolean(payload.submission || payload.submission_file_name || payload.submission_file_base64);
    if (!hasDocx && !hasPdf) throw Object.assign(new Error('至少选择一个 Word 或 PDF 文件。'), { code: 400 });
    if (hasDocx) docx = resumeUploadFile(payload, 'editable', '.docx');
    if (hasPdf) pdf = resumeUploadFile(payload, 'submission', '.pdf');
    if (docx) created.push(writeResumeUpload(docx, 'resume-docx'));
    if (pdf) created.push(writeResumeUpload(pdf, 'resume-pdf'));
    const result = await enqueueMasterWrite(async () => {
      const runtime = await runtimeModulePromise;
      if (!(await runtime.hasState())) throw Object.assign(new Error('简历资料服务尚未准备好。'), { code: 503 });
      const value = await runtime.applyAction('import-resume-version', {
        display_name: String(payload.display_name || path.parse((docx || pdf).fileName).name),
        one_time: payload.one_time === true,
        approved_for_use: payload.approved_for_use === true,
        content_reference: payload.content_reference === true,
        editable_file_path: docx ? created[0].target.replaceAll(path.sep, '/') : '',
        editable_file_name: docx ? created[0].originalName : '',
        submission_pdf_path: pdf ? created[docx ? 1 : 0].target.replaceAll(path.sep, '/') : '',
        submission_pdf_filename: pdf ? created[docx ? 1 : 0].originalName : '',
      });
      snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
      writeSnapshotCache(snapshotCache, masterMtime()); scheduleRuntimeMirror();
      return value;
    });
    return sendJSON(res, 200, { ok:true, data:result, ...result });
  } catch (error) {
    for (const file of created) { try { fs.unlinkSync(file.target); } catch (_) {} }
    const status = Number(error?.code); const httpStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    logApiError(req, httpStatus, String(error?.message || error), payload);
    return sendJSON(res, httpStatus, { ok:false, error:'RESUME_IMPORT_FAILED', message:error?.message || '保存简历失败，请重试。' });
  }
}

async function handleResumeSlotUpload(req, res) {
  let payload = {};
  try { payload = await readJSONBody(req); } catch (error) { return sendJSON(res, 400, { ok:false, error:'INVALID_JSON', message:'上传资料失败，请重试。' }); }
  const slot = String(payload.slot || '');
  const expected = slot === 'editable_docx' ? '.docx' : slot === 'submission_pdf' ? '.pdf' : '';
  let file = null, created = null;
  try {
    if (!expected) throw Object.assign(new Error('简历文件槽位无效。'), { code:400 });
    file = resumeUploadFile(payload, 'file', expected);
    created = writeResumeUpload(file, slot);
    const result = await enqueueMasterWrite(async () => {
      const runtime = await runtimeModulePromise;
      if (!(await runtime.hasState())) throw Object.assign(new Error('简历资料服务尚未准备好。'), { code:503 });
      const value = await runtime.applyAction('import-resume-slot', { resume_id: payload.resume_id || payload.material_id, slot, file_path: created.target.replaceAll(path.sep, '/'), file_name: created.originalName });
      snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
      writeSnapshotCache(snapshotCache, masterMtime()); scheduleRuntimeMirror();
      return value;
    });
    return sendJSON(res, 200, { ok:true, data:result, ...result });
  } catch (error) {
    if (created) { try { fs.unlinkSync(created.target); } catch (_) {} }
    const status = Number(error?.code); const httpStatus = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    logApiError(req, httpStatus, String(error?.message || error), payload);
    return sendJSON(res, httpStatus, { ok:false, error:'RESUME_SLOT_UPDATE_FAILED', message:error?.message || '保存简历失败，请重试。' });
  }
}

function reminderErrorStatus(error) {
  const value = Number(error?.statusCode || error?.code);
  return Number.isInteger(value) && value >= 400 && value < 600 ? value : 500;
}

async function handleReminderSettings(req, res) {
  try {
    const [service, secrets] = await Promise.all([reminderServicePromise, reminderSecretsPromise]);
    const snapshot = await getSnapshotCached();
    const settings = service.getReminderSettings(snapshot);
    const credentialConfigured = await secrets.hasSmtpAuthCode();
    const credentialSender = credentialConfigured ? await secrets.getSmtpCredentialAccount() : '';
    const credentialSenderMismatch = Boolean(credentialSender && settings.sender_email && credentialSender.toLowerCase() !== settings.sender_email.toLowerCase());
    return sendJSON(res, 200, { ok: true, settings, credential_configured: credentialConfigured, credential_storage: await secrets.getSmtpStorageLabel(), credential_storage_error: await secrets.getSmtpCredentialStorageError(), credential_sender_mismatch: credentialSenderMismatch });
  } catch (error) {
    logApiError(req, 500, String(error?.message || error), {});
    return sendJSON(res, 500, { ok: false, error: 'INTERNAL_ERROR', message: '提醒设置暂时无法读取。' });
  }
}

async function handleReminderSettingsSave(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (error) { return sendJSON(res, 400, { ok: false, error: 'INVALID_JSON', message: '提醒设置格式不正确。' }); }
  try {
    const [runtime, service, secrets] = await Promise.all([runtimeModulePromise, reminderServicePromise, reminderSecretsPromise]);
    const current = await runtime.getSnapshot();
    const previous = service.getReminderSettings(current);
    const settings = service.normalizeReminderSettings(payload, current);
    const result = await runtime.applyAction('save-reminder-settings', { settings });
    snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
    writeSnapshotCache(snapshotCache, masterMtime()); scheduleRuntimeMirror();
    const credentialSender = await secrets.getSmtpCredentialAccount();
    const senderChanged = Boolean(previous.sender_email && settings.sender_email && previous.sender_email.toLowerCase() !== settings.sender_email.toLowerCase());
    const credentialSenderMismatch = Boolean(credentialSender && settings.sender_email && credentialSender.toLowerCase() !== settings.sender_email.toLowerCase());
    return sendJSON(res, 200, { ok: true, settings, data: result, credential_sender_changed: senderChanged, credential_sender_mismatch: credentialSenderMismatch, message: credentialSenderMismatch ? '发件 QQ 邮箱已更改，请为新的 QQ 邮箱重新配置 SMTP 授权码。' : '' });
  } catch (error) {
    const status = reminderErrorStatus(error); logApiError(req, status, String(error?.message || error), payload);
    return sendJSON(res, status, { ok: false, error: status === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR', message: status === 400 ? String(error?.message || '提醒设置不正确。') : '提醒设置保存失败，请重试。' });
  }
}

async function handleReminderCredentialSave(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (error) { return sendJSON(res, 400, { ok: false, error: 'INVALID_JSON', message: '授权码格式不正确。' }); }
  try {
    const secrets = await reminderSecretsPromise;
    const senderEmail = String(payload.sender_email || '').trim();
    if (!senderEmail) throw Object.assign(new Error('请先填写发件 QQ 邮箱。'), { code: 400 });
    const result = await secrets.saveSmtpAuthCode(payload.auth_code, senderEmail);
    return sendJSON(res, 200, { ok: true, credential_configured: true, secret_storage: result.storage });
  } catch (error) {
    const status = reminderErrorStatus(error); logApiError(req, status, String(error?.message || error), payload);
    return sendJSON(res, status, { ok: false, error: status === 400 ? 'VALIDATION_ERROR' : 'SECRET_STORAGE_ERROR', message: status === 400 ? String(error?.message || '请输入授权码。') : '授权码保存失败，请重试。' });
  }
}

async function handleReminderCredentialDelete(req, res) {
  try {
    const secrets = await reminderSecretsPromise;
    const result = await secrets.deleteSmtpAuthCode();
    return sendJSON(res, 200, { ok: true, credential_configured: false, data: result });
  } catch (error) {
    logApiError(req, 500, String(error?.message || error), {});
    return sendJSON(res, 500, { ok: false, error: 'SECRET_STORAGE_ERROR', message: '授权码删除失败，请重试。' });
  }
}

function reminderTestError(error) {
  switch (error?.code) {
    case 'SMTP_AUTH_FAILED': return '测试失败：授权码错误或 QQ SMTP 未开启。';
    case 'SMTP_CONNECTION_FAILED': return '测试失败：SMTP 连接失败。';
    case 'SMTP_TIMEOUT': return '测试失败：SMTP 连接超时。';
    case 'SMTP_RECIPIENT_REJECTED': return '测试失败：收件邮箱无效或被 QQ Mail 拒绝。';
    case 'SMTP_SENDER_REJECTED': return '测试失败：发件 QQ 邮箱不被 SMTP 接受。';
    case 'SMTP_SEND_FAILED': return '测试失败：邮件未被 SMTP 接受。';
    default: return '测试失败：请检查 QQ SMTP 设置后重试。';
  }
}

async function handleReminderTest(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (error) { return sendJSON(res, 400, { ok: false, error: 'INVALID_JSON', message: '测试邮件参数不正确。' }); }
  try {
    const [runtime, service, secrets, smtp] = await Promise.all([runtimeModulePromise, reminderServicePromise, reminderSecretsPromise, smtpPromise]);
    const snapshot = await getSnapshotCached();
    const settings = service.getReminderSettings(snapshot);
    const sender = settings.sender_email;
    const recipient = settings.recipient_email;
    if (!sender || !recipient) throw Object.assign(new Error('请先保存发件邮箱和收件邮箱。'), { code: 400 });
    if (!(await secrets.hasSmtpAuthCode())) throw Object.assign(new Error('尚未配置授权码，请先保存 QQ Mail SMTP 授权码。'), { code: 400 });
    const credentialSender = await secrets.getSmtpCredentialAccount();
    if (!credentialSender) await secrets.bindSmtpCredentialAccount(sender);
    else if (credentialSender.toLowerCase() !== sender.toLowerCase()) throw Object.assign(new Error('发件 QQ 邮箱已更改，请为新的 QQ 邮箱重新配置 SMTP 授权码。'), { code: 400 });
    const authCode = await secrets.readSmtpAuthCode();
    const subject = '【CareerPilot】测试邮件';
    const text = ['这是一封 CareerPilot 测试邮件。', '', '提醒系统已连接 QQ Mail SMTP。', '此邮件不代表任何真实申请提醒。', '', '打开 CareerPilot：http://127.0.0.1:8420/'].join('\n');
    const sent = await smtp.sendEmail({ sender, authCode, recipient, subject, text });
    const result = await runtime.applyAction('log-reminder-test', { recipient, subject });
    snapshotCache = await runtime.getSnapshot(); snapshotCacheMtime = await runtime.getStateMtime(); snapshotSource = 'runtime-state';
    writeSnapshotCache(snapshotCache, masterMtime()); scheduleRuntimeMirror();
    return sendJSON(res, 200, { ok: true, sent: true, recipient, smtp_code: sent.smtp_code, data: result });
  } catch (error) {
    const status = reminderErrorStatus(error); logApiError(req, status, String(error?.message || error), payload);
    const message = status === 400 ? (String(error?.message || '').includes('授权码') ? `测试失败：${String(error.message)}` : String(error?.message || '测试邮件参数不完整。')) : reminderTestError(error);
    return sendJSON(res, status, { ok: false, error: status === 400 ? 'VALIDATION_ERROR' : 'SMTP_SEND_ERROR', message });
  }
}

// Same quoted-field CSV dialect job_pool.csv already uses (every field
// quoted, "" for an embedded quote, CRLF line endings).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuotes = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return rows;
}

function stringifyField(f) {
  return '"' + String(f == null ? '' : f).replace(/"/g, '""') + '"';
}

function stringifyCSV(rows) {
  return rows.map(r => r.map(stringifyField).join(',')).join('\r\n') + '\r\n';
}

function readCSVRows(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const rows = parseCSV(text);
  return { header: rows[0], dataRows: rows.slice(1) };
}

function writeCSVRows(filePath, header, dataRows) {
  fs.writeFileSync(filePath, stringifyCSV([header, ...dataRows]));
}

function readJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 25 * 1024 * 1024) req.destroy(); // local material imports, capped at 15 MB decoded
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const CANONICAL_STATUSES = ['Potential','To Review','Interested','To Apply','Applied','Online Assessment','Interview','Offer','Rejected','Withdrawn','Closed / Expired','Archived'];

function normValue(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ').replace(/\/$/, '');
}

function ensureColumns(header, dataRows, columns) {
  columns.forEach(column => {
    if (header.indexOf(column) === -1) {
      header.push(column);
      dataRows.forEach(row => row.push(''));
    }
  });
}

function legacyStatus(canonical) {
  if (['Applied','Online Assessment','Interview'].includes(canonical)) return 'Submitted';
  if (canonical === 'Offer') return 'Offer';
  if (canonical === 'Rejected') return 'Rejected';
  if (['Archived','Closed / Expired'].includes(canonical)) return 'Skipped';
  return 'Needs user';
}

function rowMatches(row, header, payload) {
  const companyCol = header.indexOf('company');
  const titleCol = header.indexOf('job_title');
  return row && row[companyCol] === (payload.company || '') && row[titleCol] === (payload.job_title || '');
}

function findDuplicate(dataRows, header, payload, exceptIndex) {
  const companyCol = header.indexOf('company'), titleCol = header.indexOf('job_title');
  const locationCol = header.indexOf('location'), urlCol = header.indexOf('job_url');
  const idCol = header.indexOf('Job ID'), programmeCol = header.indexOf('programme_type');
  const url = normValue(payload.job_url), company = normValue(payload.company), title = normValue(payload.job_title), location = normValue(payload.location), id = normValue(payload.job_id || payload['Job ID']), programme = normValue(payload.programme_type);
  for (let i = 0; i < dataRows.length; i++) {
    if (i === exceptIndex) continue;
    const row = dataRows[i];
    if (url && normValue(row[urlCol]) === url) return i;
    if (id && normValue(row[idCol]) === id) return i;
    if (company && title && normValue(row[companyCol]) === company && normValue(row[titleCol]) === title && (!location || normValue(row[locationCol]) === location) && (!programme || normValue(row[programmeCol]) === programme)) return i;
  }
  return -1;
}

function setJobFields(row, header, payload) {
  const map = {
    company: 'company', job_title: 'job_title', location: 'location', job_url: 'job_url', source: 'source', priority: 'priority', notes: 'notes', tags: 'tags', programme_type: 'programme_type', application_date: 'application_date', cv_version: 'cv_version', cover_letter_version: 'cover_letter_version', application_deadline: 'Application Deadline', job_id: 'Job ID'
  };
  Object.keys(map).forEach(key => {
    const col = header.indexOf(map[key]);
    if (col !== -1 && payload[key] !== undefined) row[col] = String(payload[key] == null ? '' : payload[key]);
  });
  if (header.indexOf('current_checked_date') !== -1 && payload.current_checked_date !== undefined) row[header.indexOf('current_checked_date')] = payload.current_checked_date;
  if (header.indexOf('lifecycle_status') !== -1 && payload.status) row[header.indexOf('lifecycle_status')] = payload.status;
  if (header.indexOf('status') !== -1 && payload.status) row[header.indexOf('status')] = legacyStatus(payload.status);
}

async function handleJobStatus(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (e) { return sendJSON(res, 400, { ok: false, error: e.message }); }
  if (!CANONICAL_STATUSES.includes(payload.status)) return sendJSON(res, 400, { ok: false, error: 'Unsupported lifecycle status' });
  let header, dataRows; try { ({ header, dataRows } = readCSVRows(JOB_POOL_PATH)); } catch (e) { return sendJSON(res, 500, { ok:false, error:e.message }); }
  ensureColumns(header, dataRows, ['lifecycle_status','programme_type','tags','application_date','cv_version','cover_letter_version']);
  const i = Number(payload.rowIndex);
  if (!Number.isInteger(i) || i < 0 || i >= dataRows.length) return sendJSON(res, 409, { ok:false, error:'Job row no longer exists; refresh first' });
  if (!rowMatches(dataRows[i], header, payload)) return sendJSON(res, 409, { ok:false, error:'Job row changed; refresh first' });
  setJobFields(dataRows[i], header, payload);
  if (payload.status === 'Applied' && !payload.application_date && header.indexOf('application_date') !== -1) dataRows[i][header.indexOf('application_date')] = new Date().toISOString().slice(0,10);
  try { writeCSVRows(JOB_POOL_PATH, header, dataRows); } catch (e) { return sendJSON(res, 500, {ok:false,error:e.message}); }
  sendJSON(res, 200, {ok:true, status:payload.status});
}

async function handleJobSave(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (e) { return sendJSON(res, 400, { ok:false, error:e.message }); }
  if (!payload.company || !payload.job_title || !payload.job_url) return sendJSON(res, 400, {ok:false,error:'公司、职位和职位链接不能为空。'});
  let header, dataRows; try { ({header,dataRows}=readCSVRows(JOB_POOL_PATH)); } catch(e) { return sendJSON(res,500,{ok:false,error:e.message}); }
  ensureColumns(header,dataRows,['lifecycle_status','programme_type','tags','application_date','cv_version','cover_letter_version']);
  const editIndex = payload.rowIndex === undefined ? -1 : Number(payload.rowIndex);
  const duplicate = findDuplicate(dataRows, header, payload, editIndex);
  if (duplicate !== -1) return sendJSON(res, 409, {ok:false,duplicate:true,existingIndex:duplicate,existingStatus:dataRows[duplicate][header.indexOf('lifecycle_status')] || dataRows[duplicate][header.indexOf('status')]});
  let row;
  if (editIndex >= 0) {
    if (editIndex >= dataRows.length || !rowMatches(dataRows[editIndex], header, payload)) return sendJSON(res,409,{ok:false,error:'Job row changed; refresh first'});
    row = dataRows[editIndex];
    const preserved = row[header.indexOf('lifecycle_status')] || 'To Review';
    setJobFields(row,header,payload);
    row[header.indexOf('lifecycle_status')] = preserved;
    row[header.indexOf('status')] = legacyStatus(preserved);
  } else {
    row = new Array(header.length).fill('');
    setJobFields(row,header,Object.assign({status:payload.status || 'To Review'},payload));
    row[header.indexOf('date_found')] = new Date().toISOString().slice(0,10);
    row[header.indexOf('current_checked_date')] = '';
    row[header.indexOf('current_validity')] = 'Unknown';
    row[header.indexOf('current_validity_reason')] = 'Manual URL added; validate the actual vacancy page before showing in active basket';
    dataRows.push(row);
  }
  try { writeCSVRows(JOB_POOL_PATH,header,dataRows); } catch(e) { return sendJSON(res,500,{ok:false,error:e.message}); }
  sendJSON(res,200,{ok:true,rowIndex: editIndex >= 0 ? editIndex : dataRows.length-1, status: row[header.indexOf('lifecycle_status')]});
}

async function handleJobMetadata(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (e) { return sendJSON(res,400,{ok:false,error:e.message}); }
  if (!payload.url || !/^https?:\/\//i.test(payload.url)) return sendJSON(res,400,{ok:false,error:'请输入有效的 http(s) 链接。'});
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(payload.url, {redirect:'follow', signal:controller.signal, headers:{'user-agent':'CareerPilot local tracker'}});
    const text = await response.text();
    const getMeta = (name) => { const re = new RegExp('<meta[^>]+(?:name|property)=["\\\']' + name + '["\\\'][^>]+content=["\\\']([^"\\\']*)["\\\'][^>]*>', 'i'); const m = text.match(re); return m ? m[1].replace(/&amp;/g,'&').trim() : ''; };
    const title = getMeta('og:title') || ((text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)||[])[1]||'').replace(/\s+/g,' ').trim();
    const host = new URL(response.url).hostname.replace(/^www\./,'');
    clearTimeout(timer); sendJSON(res,200,{ok:true,url:response.url,title,company:host,source:'Manual URL / ' + host,statusCode:response.status});
  } catch (e) { clearTimeout(timer); sendJSON(res,200,{ok:false,error:'Could not fetch metadata: ' + e.message}); }
}

async function handleJobRecheck(req, res) {
  let payload; try { payload = await readJSONBody(req); } catch (e) { return sendJSON(res,400,{ok:false,error:e.message}); }
  let header,dataRows; try { ({header,dataRows}=readCSVRows(JOB_POOL_PATH)); } catch(e) { return sendJSON(res,500,{ok:false,error:e.message}); }
  const i=Number(payload.rowIndex); if (!Number.isInteger(i)||i<0||i>=dataRows.length) return sendJSON(res,409,{ok:false,error:'Job row no longer exists'});
  if (!rowMatches(dataRows[i],header,payload)) return sendJSON(res,409,{ok:false,error:'Job row changed; refresh first'});
  ensureColumns(header,dataRows,['lifecycle_status','current_checked_date','current_validity_reason']);
  dataRows[i][header.indexOf('current_checked_date')] = new Date().toISOString().slice(0,10);
  dataRows[i][header.indexOf('current_validity')] = 'Unknown';
  dataRows[i][header.indexOf('current_validity_reason')] = 'Re-check requested from UI; actual vacancy page must be opened and validated before reactivation';
  try { writeCSVRows(JOB_POOL_PATH,header,dataRows); } catch(e) { return sendJSON(res,500,{ok:false,error:e.message}); }
  sendJSON(res,200,{ok:true,requiresValidation:true});
}

async function handleUpdateStatus(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { rowIndex, company, job_title, status } = payload || {};
  if (!CANONICAL_STATUSES.includes(status)) {
    return sendJSON(res, 400, { ok: false, error: 'Unsupported lifecycle status' });
  }
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'rowIndex must be a non-negative integer' });
  }

  let header, dataRows;
  try {
    ({ header, dataRows } = readCSVRows(JOB_POOL_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read job_pool.csv: ' + e.message });
  }

  const companyCol = header.indexOf('company');
  const titleCol = header.indexOf('job_title');
  const statusCol = header.indexOf('status');
  ensureColumns(header, dataRows, ['lifecycle_status','programme_type','tags','application_date','cv_version','cover_letter_version']);

  if (statusCol === -1 || companyCol === -1 || titleCol === -1) {
    return sendJSON(res, 500, { ok: false, error: 'job_pool.csv is missing an expected column' });
  }
  if (rowIndex >= dataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'rowIndex out of range — the file may have changed, please refresh' });
  }

  const target = dataRows[rowIndex];
  // job_pool.csv may have been rewritten (e.g. by the agent) between page
  // load and this click, which would shift row positions — confirm the row
  // at this index is still the same job before overwriting its status.
  if (target[companyCol] !== company || target[titleCol] !== job_title) {
    return sendJSON(res, 409, { ok: false, error: 'This row no longer matches — the dashboard data changed, please refresh and try again' });
  }

  target[statusCol] = legacyStatus(status);
  target[header.indexOf('lifecycle_status')] = status;
  if (payload.application_date) target[header.indexOf('application_date')] = payload.application_date;
  if (payload.cv_version) target[header.indexOf('cv_version')] = payload.cv_version;
  if (payload.cover_letter_version) target[header.indexOf('cover_letter_version')] = payload.cover_letter_version;
  if (payload.notes !== undefined) target[header.indexOf('notes')] = payload.notes;

  try {
    writeCSVRows(JOB_POOL_PATH, header, dataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write job_pool.csv: ' + e.message });
  }

  sendJSON(res, 200, { ok: true });
}

// Locate + verify a job_pool.csv row by index, checking it still matches the
// company/job_title the client last saw (same staleness guard as above).
// Returns { header, dataRows, companyCol, titleCol, stageCol, target } or
// throws an Error with an httpStatus property for the caller to relay.
function locateJobRow(jobRowIndex, company, job_title) {
  if (!Number.isInteger(jobRowIndex) || jobRowIndex < 0) {
    const e = new Error('jobRowIndex must be a non-negative integer'); e.httpStatus = 400; throw e;
  }
  let header, dataRows;
  try {
    ({ header, dataRows } = readCSVRows(JOB_POOL_PATH));
  } catch (err) {
    const e = new Error('Could not read job_pool.csv: ' + err.message); e.httpStatus = 500; throw e;
  }
  const companyCol = header.indexOf('company');
  const titleCol = header.indexOf('job_title');
  const statusCol = header.indexOf('status');
  const stageCol = header.indexOf('current_stage');
  if ([companyCol, titleCol, statusCol, stageCol].includes(-1)) {
    const e = new Error('job_pool.csv is missing an expected column (company/job_title/status/current_stage)'); e.httpStatus = 500; throw e;
  }
  if (jobRowIndex >= dataRows.length) {
    const e = new Error('jobRowIndex out of range — the file may have changed, please refresh'); e.httpStatus = 409; throw e;
  }
  const target = dataRows[jobRowIndex];
  if (target[companyCol] !== company || target[titleCol] !== job_title) {
    const e = new Error('This job row no longer matches — the dashboard data changed, please refresh and try again'); e.httpStatus = 409; throw e;
  }
  if (target[statusCol] !== 'Submitted') {
    const e = new Error('This job is not in the Submitted/Applied bucket — calendar events are only for already-applied jobs'); e.httpStatus = 409; throw e;
  }
  return { header, dataRows, statusCol, stageCol, target };
}

async function handleCalendarAdd(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { jobRowIndex, company, job_title, date, time, event_type } = payload || {};
  if (!DATE_RE.test(date)) return sendJSON(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' });
  if (!TIME_RE.test(time)) return sendJSON(res, 400, { ok: false, error: 'time must be HH:MM' });
  if (typeof event_type !== 'string' || !event_type.trim()) {
    return sendJSON(res, 400, { ok: false, error: 'event_type is required' });
  }

  let jobRow;
  try {
    jobRow = locateJobRow(jobRowIndex, company, job_title);
  } catch (e) {
    return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message });
  }

  // current_stage is the event content verbatim — no auto-suffix. Every
  // company's process reads differently, so don't guess a shared phrasing
  // convention on top of what the user typed.
  const stage = event_type.trim();
  jobRow.target[jobRow.stageCol] = stage;

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  const cols = ['date', 'company', 'job_title', 'contact', 'channel', 'event_type', 'deadline', 'next_action', 'status', 'notes', 'time'];
  if (cols.some(c => fuHeader.indexOf(c) === -1)) {
    return sendJSON(res, 500, { ok: false, error: 'follow_up.csv is missing an expected column' });
  }
  const newRow = new Array(fuHeader.length).fill('');
  newRow[fuHeader.indexOf('date')] = date;
  newRow[fuHeader.indexOf('company')] = company;
  newRow[fuHeader.indexOf('job_title')] = job_title;
  newRow[fuHeader.indexOf('event_type')] = event_type.trim();
  newRow[fuHeader.indexOf('status')] = 'Scheduled';
  newRow[fuHeader.indexOf('time')] = time;
  fuDataRows.push(newRow);
  const followUpRowIndex = fuDataRows.length - 1;

  try {
    writeCSVRows(JOB_POOL_PATH, jobRow.header, jobRow.dataRows);
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write dashboard files: ' + e.message });
  }

  sendJSON(res, 200, { ok: true, followUpRowIndex, current_stage: stage });
}

async function handleCalendarUpdate(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { followUpRowIndex, jobRowIndex, company, job_title, date, time, event_type } = payload || {};
  if (!Number.isInteger(followUpRowIndex) || followUpRowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'followUpRowIndex must be a non-negative integer' });
  }
  if (!DATE_RE.test(date)) return sendJSON(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' });
  if (!TIME_RE.test(time)) return sendJSON(res, 400, { ok: false, error: 'time must be HH:MM' });
  if (typeof event_type !== 'string' || !event_type.trim()) {
    return sendJSON(res, 400, { ok: false, error: 'event_type is required' });
  }

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  const fuCompanyCol = fuHeader.indexOf('company');
  const fuTitleCol = fuHeader.indexOf('job_title');
  if (followUpRowIndex >= fuDataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer exists — the calendar may have changed, please refresh' });
  }
  const fuTarget = fuDataRows[followUpRowIndex];
  if (fuTarget[fuCompanyCol] !== company || fuTarget[fuTitleCol] !== job_title) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer matches — the calendar may have changed, please refresh' });
  }

  let jobRow;
  try {
    jobRow = locateJobRow(jobRowIndex, company, job_title);
  } catch (e) {
    return sendJSON(res, e.httpStatus || 500, { ok: false, error: e.message });
  }

  fuTarget[fuHeader.indexOf('date')] = date;
  fuTarget[fuHeader.indexOf('time')] = time;
  fuTarget[fuHeader.indexOf('event_type')] = event_type.trim();

  // Same rule as add: current_stage is the event content verbatim.
  const stage = event_type.trim();
  jobRow.target[jobRow.stageCol] = stage;

  try {
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
    writeCSVRows(JOB_POOL_PATH, jobRow.header, jobRow.dataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write dashboard files: ' + e.message });
  }

  sendJSON(res, 200, { ok: true, current_stage: stage });
}

async function handleCalendarDelete(req, res) {
  let payload;
  try {
    payload = await readJSONBody(req);
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: e.message });
  }

  const { followUpRowIndex, company, job_title, event_type, date, time } = payload || {};
  if (!Number.isInteger(followUpRowIndex) || followUpRowIndex < 0) {
    return sendJSON(res, 400, { ok: false, error: 'followUpRowIndex must be a non-negative integer' });
  }

  let fuHeader, fuDataRows;
  try {
    ({ header: fuHeader, dataRows: fuDataRows } = readCSVRows(FOLLOW_UP_PATH));
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not read follow_up.csv: ' + e.message });
  }
  if (followUpRowIndex >= fuDataRows.length) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer exists — the calendar may have changed, please refresh' });
  }
  const fuTarget = fuDataRows[followUpRowIndex];
  const matches = (col, val) => fuTarget[fuHeader.indexOf(col)] === val;
  if (!matches('company', company) || !matches('job_title', job_title) || !matches('event_type', event_type) || !matches('date', date) || !matches('time', time)) {
    return sendJSON(res, 409, { ok: false, error: 'This event no longer matches — the calendar may have changed, please refresh' });
  }

  fuDataRows.splice(followUpRowIndex, 1);

  try {
    writeCSVRows(FOLLOW_UP_PATH, fuHeader, fuDataRows);
  } catch (e) {
    return sendJSON(res, 500, { ok: false, error: 'Could not write follow_up.csv: ' + e.message });
  }

  // Deliberately does not revert job_pool.csv's current_stage — there's no
  // reliable "previous stage" to roll back to. Edit the stage manually if
  // deleting this event should also change what's shown on the job card.
  sendJSON(res, 200, { ok: true });
}

const ROUTES = {
  '/api/update-status': handleUpdateStatus,
  '/api/job/status': handleJobStatus,
  '/api/job/save': handleJobSave,
  '/api/job/metadata': handleJobMetadata,
  '/api/job/recheck': handleJobRecheck,
  '/api/calendar/add': handleCalendarAdd,
  '/api/calendar/update': handleCalendarUpdate,
  '/api/calendar/delete': handleCalendarDelete,
  '/api/master/job/update': handleMasterAction('update-job'),
  '/api/master/job/recheck': handleMasterAction('recheck-job'),
  '/api/master/job/add': handleMasterAction('add-job'),
  '/api/master/job/trash': handleMasterAction('trash-job'),
  '/api/master/job/restore': handleMasterAction('restore-job'),
  '/api/master/job/permanent-delete': handleMasterAction('permanent-delete-job'),
  '/api/master/profile/save': handleMasterAction('save-profile'),
  '/api/master/preferences/save': handleMasterAction('save-preferences'),
  '/api/master/routine/update': handleMasterAction('update-routine'),
  '/api/master/job/mark-applied': handleMasterAction('mark-applied'),
  '/api/master/material/update': handleMasterAction('update-material'),
  '/api/master/material/associate-version': handleMasterAction('associate-material-version'),
  '/api/master/material/default': handleMasterAction('set-material-default'),
  '/api/master/material/trash': handleMasterAction('trash-material'),
  '/api/master/material/restore': handleMasterAction('restore-material'),
  '/api/master/material/import': handleMaterialImport,
  '/api/master/material/resume-version/import': handleResumeVersionImport,
  '/api/master/material/resume-version/slot': handleResumeSlotUpload,
  '/api/master/material/ensure-approved-folder': handleEnsureApprovedFolder,
  '/api/master/calendar/add': handleMasterAction('add-calendar-event'),
  '/api/master/calendar/update': handleMasterAction('update-calendar-event'),
  '/api/master/calendar/delete': handleMasterAction('delete-calendar-event'),
  '/api/master/application/event/add': handleMasterAction('add-application-event'),
  '/api/master/application/event/update': handleMasterAction('update-application-event'),
  '/api/master/application/event/delete': handleMasterAction('delete-application-event'),
  '/api/master/application/material/select': handleMasterAction('set-application-selected-material'),
  '/api/master/application/material/confirm': handleMasterAction('confirm-application-material'),
  '/api/master/settings/save': handleMasterAction('save-setting'),
  '/api/master/material/rescan': handleMasterAction('rescan-materials'),
  '/api/master/material/rescan-approved': handleMasterAction('rescan-approved-materials'),
  '/api/master/search/run/create': handleMasterAction('create-search-run'),
  '/api/master/search/run/update': handleMasterAction('update-search-run'),
  '/api/reminders/settings/save': handleReminderSettingsSave,
  '/api/reminders/credential/save': handleReminderCredentialSave,
  '/api/reminders/credential/delete': handleReminderCredentialDelete,
  '/api/reminders/test': handleReminderTest,
};

const server = http.createServer((req, res) => {
  const requestStarted = Date.now();
  res.on('finish', () => logPerformance('api request', Date.now() - requestStarted, { method:req.method, endpoint:req.url.split('?')[0], status:res.statusCode }));
  const rawPath = decodeURIComponent(req.url.split('?')[0]);
  const urlPath = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;

  if (ROUTES[urlPath]) {
    if (req.method !== 'POST') {
      logApiError(req, 405, 'METHOD_NOT_ALLOWED', {});
      sendJSON(res, 405, { ok:false, error:'METHOD_NOT_ALLOWED', message:`该操作当前不支持 ${req.method}` });
      return;
    }
    ROUTES[urlPath](req, res);
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/health') {
    const ready = Boolean(snapshotCache && ((snapshotSource === 'runtime-state' && snapshotCacheMtime === runtimeStateMtime()) || (snapshotSource === 'excel-cache' && snapshotCacheMtime === masterMtime())));
    sendJSON(res, ready ? 200 : 503, { ok:true, ready, loading:Boolean(snapshotLoading), startup_ms:Date.now() - startupAt });
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/reminders/settings') {
    handleReminderSettings(req, res);
    return;
  }

  if (req.method === 'GET' && urlPath === '/api/master/snapshot') {
    handleMasterSnapshot(req, res);
    return;
  }
  if ((req.method === 'GET' || req.method === 'POST') && urlPath === '/api/master/profile/autofill-map') {
    handleProfileAutofillMap(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/master/download') {
    handleMasterDownload(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/master/material/file') {
    handleMaterialFile(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/master/material/version-file') {
    handleMaterialVersionFile(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/master/application/material/file') {
    handleApplicationMaterialFile(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/master/material/open-folder') {
    handleOpenMaterialsFolder(req,res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/master/material/browse-folder') {
    handleBrowseMaterialsFolder(req,res);
    return;
  }

  if (urlPath.startsWith('/api/')) {
    const status = req.method === 'GET' ? 404 : 405;
    const code = status === 404 ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED';
    logApiError(req, status, code, {});
    sendJSON(res, status, { ok:false, error:code, message:status === 404 ? '找不到该 API 接口' : `该操作当前不支持 ${req.method}` });
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405);
    res.end('该操作当前不支持');
    return;
  }

  const servedPath = (urlPath === '/' || urlPath === '/dashboard.html') ? '/product.html' : urlPath;
  const filePath = path.join(ROOT, servedPath);

  // Prevent escaping the dashboard folder.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到页面：' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    if (servedPath === '/product.html') content = Buffer.from(content.toString('utf8').replace('</head>', '<script src="/navigation_registry.js"></script></head>'));
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
});

// Bind to localhost only — this server can now write to job_pool.csv, so it
// shouldn't be reachable from other devices on the network.
server.listen(PORT, '127.0.0.1', () => {
  console.log('CareerPilot running / CareerPilot 已启动: http://localhost:' + PORT + '/');
  console.log('Keep this window open to keep serving; close it or press Ctrl+C to stop.');
  console.log('保持这个窗口开着；关掉窗口或按 Ctrl+C 即可停止服务。');
});
