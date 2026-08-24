import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import projectPaths from '../../core/project_paths.cjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const paths = projectPaths.getProjectPaths({ repoRoot });
const sourceRoot = path.join(repoRoot, 'application_materials');
const targetRoot = path.resolve(repoRoot, '..', 'CareerMaterials');
const backupRoot = path.resolve(repoRoot, '..', 'archive', 'careerpilot_materials_before_portability_20260824');
const oldPrefixes = [sourceRoot, sourceRoot.replaceAll(path.sep, '/')];
const newPrefix = targetRoot.replaceAll(path.sep, '/');

async function exists(file) { return Boolean(await fs.stat(file).catch(() => null)); }
async function filesUnder(root) {
  const result = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) result.push(full);
    }
  }
  await walk(root);
  return result;
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}
function rewriteValue(value) {
  if (typeof value === 'string') {
    let out = value;
    for (const prefix of oldPrefixes) {
      out = out.replaceAll(prefix, newPrefix).replaceAll(prefix.replaceAll('/', '\\'), targetRoot);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(rewriteValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteValue(item)]));
  return value;
}
async function rewriteJSON(file) {
  if (!(await exists(file))) return false;
  const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, `${JSON.stringify(rewriteValue(parsed), null, 2)}\n`, 'utf8');
  return true;
}

if (!(await exists(sourceRoot))) throw new Error(`Materials source does not exist: ${sourceRoot}`);
if (await exists(targetRoot)) throw new Error(`Materials target already exists: ${targetRoot}`);
if (await exists(backupRoot)) throw new Error(`Materials backup already exists: ${backupRoot}`);

const sourceFiles = await filesUnder(sourceRoot);
await fs.cp(sourceRoot, targetRoot, { recursive: true, errorOnExist: true });
const verification = [];
for (const sourceFile of sourceFiles) {
  const relative = path.relative(sourceRoot, sourceFile);
  const targetFile = path.join(targetRoot, relative);
  const [sourceHash, targetHash] = await Promise.all([sha256(sourceFile), sha256(targetFile)]);
  if (sourceHash !== targetHash) throw new Error(`Material checksum mismatch: ${relative}`);
  verification.push({ relative, sha256: sourceHash });
}

await rewriteJSON(paths.runtimeStatePath);
await rewriteJSON(paths.snapshotCachePath);
const settings = JSON.parse(await fs.readFile(paths.settingsPath, 'utf8'));
settings.materials_root = targetRoot;
settings.materials_migrated_at = new Date().toISOString();
settings.migration_mode = 'runtime-and-materials-outside-repo';
await fs.writeFile(paths.settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
await fs.mkdir(path.dirname(backupRoot), { recursive: true });
await fs.rename(sourceRoot, backupRoot);

const report = {
  ok: true,
  source_root: sourceRoot,
  active_materials_root: targetRoot,
  recoverable_backup: backupRoot,
  files_verified: verification.length,
  state_path: paths.runtimeStatePath,
  snapshot_cache_path: paths.snapshotCachePath,
  completed_at: new Date().toISOString(),
};
await fs.writeFile(path.join(paths.configRoot, 'materials-migration-map.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(JSON.stringify(report));
