import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const careerpilotSecretDir = path.join(localAppData, 'CareerPilot', 'secrets');
const secretDir = process.env.CAREERPILOT_SECRET_DIR || careerpilotSecretDir;
const encryptedAuthCodePath = path.join(secretDir, 'qq_smtp_auth_code.dpapi');
const accountPath = path.join(secretDir, 'qq_smtp_account.json');
const legacySecretDir = path.join(workspace, 'data', 'private', '.secrets');
const legacyEncryptedAuthCodePath = path.join(legacySecretDir, 'qq_smtp_auth_code.dpapi');
let legacyMigrationError = '';
const windowsPowerShellPath = process.env.SystemRoot
  ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';
const powershellEnv = {
  ...process.env,
  PSModulePath: [
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') : '',
    process.env.PSModulePath || '',
  ].filter(Boolean).join(';'),
};

function powershellTransform(mode, value) {
  const script = mode === 'encrypt'
    ? "$v=([Console]::In.ReadToEnd()).Trim(); if([string]::IsNullOrWhiteSpace($v)){ throw 'empty secret' }; $s=ConvertTo-SecureString $v -AsPlainText -Force; $s | ConvertFrom-SecureString"
    : "$v=([Console]::In.ReadToEnd()).Trim(); if([string]::IsNullOrWhiteSpace($v)){ throw 'empty protected secret' }; $s=ConvertTo-SecureString -String $v; [System.Net.NetworkCredential]::new('', $s).Password";
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShellPath, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      env: powershellEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => reject(new Error(`Windows 安全存储不可用：${error.message}`)));
    child.once('close', code => {
      if (code !== 0) return reject(new Error('Windows 用户加密存储操作失败。'));
      const result = stdout.replace(/^\uFEFF/, '').trim();
      if (!result) return reject(new Error('Windows 用户加密存储返回为空。'));
      resolve(result);
    });
    child.stdin.end(String(value));
  });
}

async function writeProtectedAuthCode(value) {
  await fs.mkdir(secretDir, { recursive: true });
  const protectedValue = await powershellTransform('encrypt', value);
  const temp = `${encryptedAuthCodePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${protectedValue}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, encryptedAuthCodePath);
}

async function writeAccount(account) {
  const value = String(account || '').trim();
  if (!value) return;
  const temp = `${accountPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ sender_email: value, updated_at: new Date().toISOString() })}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temp, accountPath);
}

async function migrateLegacyStore() {
  const current = await fs.stat(encryptedAuthCodePath).catch(() => null);
  if (current?.isFile() && current.size > 0) return true;
  const legacy = await fs.readFile(legacyEncryptedAuthCodePath, 'utf8').catch(() => '');
  if (!legacy.trim()) return false;
  try {
    const value = await powershellTransform('decrypt', legacy.trim());
    await writeProtectedAuthCode(value);
    await fs.rm(legacyEncryptedAuthCodePath, { force: true });
    legacyMigrationError = '';
    return true;
  } catch (_) {
    // Never make the settings page fail because an old credential cannot be
    // decrypted. Keep the legacy file untouched for manual recovery/audit.
    legacyMigrationError = '旧版凭据无法解密，请重新配置 SMTP 授权码。';
    return false;
  }
}

export async function saveSmtpAuthCode(authCode, senderEmail = '') {
  const value = String(authCode || '').trim();
  if (!value) throw Object.assign(new Error('请输入 QQ Mail SMTP 授权码。'), { code: 400 });
  try { await writeProtectedAuthCode(value); } catch (error) { throw Object.assign(new Error('Windows 用户加密存储不可用，授权码未保存。'), { code: 500, cause: error }); }
  await writeAccount(senderEmail);
  return { configured: true, storage: 'Windows DPAPI（用户 AppData）' };
}

export async function readSmtpAuthCode() {
  await migrateLegacyStore();
  const protectedValue = await fs.readFile(encryptedAuthCodePath, 'utf8').catch(() => '');
  if (protectedValue.trim()) return powershellTransform('decrypt', protectedValue.trim());
  return '';
}

export async function hasSmtpAuthCode() {
  await migrateLegacyStore();
  const protectedStat = await fs.stat(encryptedAuthCodePath).catch(() => null);
  return Boolean(protectedStat?.isFile() && protectedStat.size > 0);
}

export async function deleteSmtpAuthCode() {
  await Promise.all([
    fs.rm(encryptedAuthCodePath, { force: true }),
    fs.rm(accountPath, { force: true }),
  ]);
  return { configured: false };
}

export async function getSmtpStorageLabel() {
  await migrateLegacyStore();
  const protectedStat = await fs.stat(encryptedAuthCodePath).catch(() => null);
  if (protectedStat?.isFile() && protectedStat.size > 0) return 'Windows DPAPI（用户 AppData）';
  if (legacyMigrationError) return '需要重新配置（旧版凭据无法解密）';
  return '未配置';
}

export async function getSmtpCredentialStorageError() {
  await migrateLegacyStore();
  return legacyMigrationError;
}

export async function getSmtpCredentialAccount() {
  await migrateLegacyStore();
  const data = await fs.readFile(accountPath, 'utf8').catch(() => '');
  try { return String(JSON.parse(data).sender_email || '').trim(); } catch (_) { return ''; }
}

export async function bindSmtpCredentialAccount(senderEmail) {
  if (await hasSmtpAuthCode()) await writeAccount(senderEmail);
  return getSmtpCredentialAccount();
}

export function smtpSecretPath() {
  return encryptedAuthCodePath;
}
