import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import projectPaths from '../../core/project_paths.cjs';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname.replace(/^\/(\w):/, '$1:'));
const paths = projectPaths.getProjectPaths({ repoRoot });
const defaultMaterials = path.join(paths.userDataRoot, 'materials');
const legacyState = path.join(repoRoot, 'data', 'private', '.runtime', 'careerpilot_state.json');
const initialCollections = ['jobs','applications','profile','preferences','routines','searchHistory','statusHistory','trash','syncMetadata','materials','materialDefaults','calendarEvents','companies','applicationEvents','materialLibrary','materialVersions','applicationMaterials','searchRuns','searchResults','settings','resumeMappingAudit'];

async function exists(file) { return Boolean(await fs.stat(file).catch(() => null)); }
async function copyIfPresent(from, to) {
  if (!(await exists(from)) || await exists(to)) return false;
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return true;
}
async function ask(question, fallback = '') {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim();
  rl.close();
  return answer || fallback;
}
async function ensureState() {
  if (await exists(paths.runtimeStatePath)) return false;
  const snapshot = Object.fromEntries(initialCollections.map(key => [key, []]));
  snapshot.settings = [{ key: 'materials_root', value: defaultMaterials, value_type: 'path', description: '求职材料目录', updated_at: new Date().toISOString(), updated_by: 'setup', version: 1 }];
  await fs.mkdir(paths.stateDir, { recursive: true });
  await fs.writeFile(paths.runtimeStatePath, `${JSON.stringify({ format_version: 1, saved_at: new Date().toISOString(), snapshot }, null, 2)}\n`, 'utf8');
  return true;
}

await fs.mkdir(paths.configRoot, { recursive: true });
if (await exists(paths.settingsPath)) {
  console.log(`CareerPilot 已初始化：${paths.settingsPath}`);
  process.exit(0);
}

console.log('欢迎使用 CareerPilot。');
console.log(`用户资料默认保存于：${paths.userDataRoot}`);
const materialsAnswer = await ask('求职材料文件夹', defaultMaterials);
const materialsRoot = path.resolve(materialsAnswer);
const hasLegacy = await exists(legacyState);
let importLegacy = false;
if (hasLegacy) {
  const answer = (await ask('发现旧版 CareerPilot 数据，是否导入现有运行数据？输入 Y 确认', 'N')).toLowerCase();
  importLegacy = answer === 'y' || answer === 'yes';
}

const settings = {
  initialized: true,
  initialized_at: new Date().toISOString(),
  language: 'zh-CN',
  materials_root: materialsRoot,
  migration_mode: importLegacy ? 'first-run-import-approved' : 'new-install',
};
await fs.writeFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
await fs.mkdir(materialsRoot, { recursive: true });
if (importLegacy) {
  await copyIfPresent(legacyState, paths.runtimeStatePath);
  await copyIfPresent(path.join(repoRoot, 'data', 'private', '.runtime', 'careerpilot_snapshot.json'), paths.snapshotCachePath);
  await copyIfPresent(path.join(repoRoot, 'data', 'private', 'runtime', 'careerpilot_runtime.xlsx'), paths.masterPath);
  await copyIfPresent(path.join(repoRoot, 'dashboard', 'job_pool.csv'), paths.legacyJobPoolPath);
  await copyIfPresent(path.join(repoRoot, 'dashboard', 'follow_up.csv'), paths.legacyFollowUpPath);
  console.log('旧版运行数据已复制到本机 CareerPilot 数据目录；原文件保留。');
} else {
  const created = await ensureState();
  console.log(created ? '已创建空白本地数据区。' : '已保留现有本地数据。');
}
console.log('Setup complete.');
console.log('Run: Open CareerPilot.bat');
