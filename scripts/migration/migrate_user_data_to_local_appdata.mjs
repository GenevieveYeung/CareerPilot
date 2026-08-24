import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import projectPaths from '../../core/project_paths.cjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = projectPaths.getProjectPaths({ repoRoot });
const source = {
  state: path.join(repoRoot, 'data', 'private', '.runtime', 'careerpilot_state.json'),
  cache: path.join(repoRoot, 'data', 'private', '.runtime', 'careerpilot_snapshot.json'),
  workbook: path.join(repoRoot, 'data', 'private', 'runtime', 'careerpilot_runtime.xlsx'),
  jobPool: path.join(repoRoot, 'dashboard', 'job_pool.csv'),
  followUp: path.join(repoRoot, 'dashboard', 'follow_up.csv'),
  materials: path.join(repoRoot, 'application_materials'),
};

async function exists(file) { return Boolean(await fs.stat(file).catch(() => null)); }
async function digest(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}
async function copyIfPresent(from, to) {
  if (!(await exists(from))) return { from, to, copied: false, reason: 'source_missing' };
  if (await exists(to)) return { from, to, copied: false, reason: 'target_exists', source_sha256: await digest(from), target_sha256: await digest(to) };
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.copyFile(from, to);
  return { from, to, copied: true, sha256: await digest(to) };
}

await fs.mkdir(target.configRoot, { recursive: true });
await fs.mkdir(target.runtimeDir, { recursive: true });
await fs.mkdir(target.stateDir, { recursive: true });
await fs.mkdir(target.legacyRoot, { recursive: true });
await fs.mkdir(target.logsRoot, { recursive: true });
await fs.mkdir(target.cacheRoot, { recursive: true });

const current = await fs.readFile(target.settingsPath, 'utf8').catch(() => '');
if (current.trim()) throw new Error(`Refusing to overwrite existing user settings: ${target.settingsPath}`);

const copied = [
  await copyIfPresent(source.state, target.runtimeStatePath),
  await copyIfPresent(source.cache, target.snapshotCachePath),
  await copyIfPresent(source.workbook, target.masterPath),
  await copyIfPresent(source.jobPool, target.legacyJobPoolPath),
  await copyIfPresent(source.followUp, target.legacyFollowUpPath),
];

const settings = {
  initialized: true,
  initialized_at: new Date().toISOString(),
  language: 'zh-CN',
  materials_root: source.materials,
  migration_source: repoRoot,
  migration_mode: 'copy-runtime-keep-materials-in-place',
};
await fs.writeFile(target.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
const migrationMap = {
  created_at: new Date().toISOString(),
  source_repo: repoRoot,
  target_user_data_root: target.userDataRoot,
  materials_moved: false,
  materials_root: source.materials,
  copied,
};
await fs.writeFile(path.join(target.configRoot, 'migration-map.json'), `${JSON.stringify(migrationMap, null, 2)}\n`, 'utf8');

const verification = {
  settings: await exists(target.settingsPath),
  runtime_state: await exists(target.runtimeStatePath),
  runtime_workbook: await exists(target.masterPath),
  materials_root: await exists(source.materials),
  target_user_data_root: target.userDataRoot,
};
if (!verification.settings || !verification.runtime_state || !verification.materials_root) {
  throw new Error(`Migration verification failed: ${JSON.stringify(verification)}`);
}
process.stdout.write(JSON.stringify({ ok: true, source, target, copied, verification }));
