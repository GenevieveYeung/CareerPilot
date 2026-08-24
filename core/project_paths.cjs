const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandPath(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.startsWith('%') && text.endsWith('%')) {
    const key = text.slice(1, -1);
    return process.env[key] || text;
  }
  return text.replace(/%([^%]+)%/g, (_, key) => process.env[key] || `%${key}%`);
}

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function readSettings(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function getProjectPaths({ repoRoot } = {}) {
  const resolvedRepoRoot = path.resolve(repoRoot || path.resolve(__dirname, '..'));
  const defaultUserDataRoot = path.join(localAppData(), 'CareerPilot');
  const userDataRoot = path.resolve(expandPath(process.env.CAREERPILOT_USER_DATA_ROOT || defaultUserDataRoot));
  const configRoot = path.join(userDataRoot, 'config');
  const settingsPath = process.env.CAREERPILOT_SETTINGS_PATH
    ? path.resolve(expandPath(process.env.CAREERPILOT_SETTINGS_PATH))
    : path.join(configRoot, 'settings.json');
  const settings = readSettings(settingsPath);
  const dataRoot = path.resolve(expandPath(settings.data_root || path.join(userDataRoot, 'data')));
  const defaultMaterialsRoot = path.join(userDataRoot, 'materials');
  const materialsRoot = path.resolve(expandPath(settings.materials_root || defaultMaterialsRoot));
  const runtimeDir = path.resolve(expandPath(settings.runtime_dir || path.join(dataRoot, 'runtime')));
  const stateDir = path.resolve(expandPath(settings.state_dir || path.join(dataRoot, 'state')));
  const logsRoot = path.resolve(expandPath(settings.logs_root || path.join(userDataRoot, 'logs')));
  const cacheRoot = path.resolve(expandPath(settings.cache_root || path.join(userDataRoot, 'cache')));
  const snapshotsRoot = path.resolve(expandPath(settings.snapshots_root || path.join(materialsRoot, 'snapshots')));
  const legacyRoot = path.join(dataRoot, 'legacy');
  return {
    repoRoot: resolvedRepoRoot,
    appRoot: resolvedRepoRoot,
    userDataRoot,
    configRoot,
    settingsPath,
    settings,
    dataRoot,
    runtimeDir,
    stateDir,
    logsRoot,
    cacheRoot,
    materialsRoot,
    snapshotsRoot,
    legacyRoot,
    masterPath: path.join(runtimeDir, 'careerpilot_runtime.xlsx'),
    runtimeStatePath: path.join(stateDir, 'careerpilot_state.json'),
    snapshotCachePath: path.join(stateDir, 'careerpilot_snapshot.json'),
    runtimePersistenceLog: path.join(logsRoot, 'runtime_persistence.ndjson'),
    apiErrorLog: path.join(logsRoot, 'api_errors.ndjson'),
    performanceLog: path.join(logsRoot, 'performance.ndjson'),
    legacyJobPoolPath: path.join(legacyRoot, 'job_pool.csv'),
    legacyFollowUpPath: path.join(legacyRoot, 'follow_up.csv'),
  };
}

function ensureUserDataLayout(paths = getProjectPaths()) {
  for (const directory of [paths.configRoot, paths.dataRoot, paths.runtimeDir, paths.stateDir, paths.logsRoot, paths.cacheRoot, paths.legacyRoot]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return paths;
}

module.exports = { getProjectPaths, ensureUserDataLayout, expandPath };
