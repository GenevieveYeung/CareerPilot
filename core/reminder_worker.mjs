import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSnapshot, applyAction } from './runtime_state.mjs';
import { getReminderSettings, pendingReminderCandidates, buildReminderEmail } from './reminder_service.mjs';
import { hasSmtpAuthCode, readSmtpAuthCode } from './reminder_secrets.mjs';
import { sendEmail } from './smtp_client.mjs';
import projectPaths from './project_paths.cjs';

const paths = projectPaths.getProjectPaths({ repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') });
const workspace = paths.repoRoot;
const mirrorScript = path.join(workspace, 'core', 'sync_runtime_mirror.mjs');
const log = value => process.stdout.write(`${JSON.stringify(value)}\n`);

const snapshot = await getSnapshot();
const settings = getReminderSettings(snapshot);
if (!settings.enabled) { log({ ok: true, enabled: false, sent: 0, skipped: 0, message: '提醒未启用。' }); process.exit(0); }
if (!settings.sender_email || !settings.recipient_email || !(await hasSmtpAuthCode())) { log({ ok: false, error: 'REMINDER_CREDENTIAL_MISSING', message: '提醒已启用，但 QQ Mail 授权码尚未安全配置。', sent: 0 }); process.exit(2); }
const authCode = await readSmtpAuthCode();
const candidates = pendingReminderCandidates(snapshot, new Date());
let sent = 0, skipped = 0, failed = 0;
for (const candidate of candidates) {
  const claim = await applyAction('claim-reminder', candidate);
  if (!claim.claimed) { skipped++; continue; }
  try {
    const email = buildReminderEmail(candidate, process.env.CAREERPILOT_BASE_URL || 'http://127.0.0.1:8420/');
    await sendEmail({ sender: settings.sender_email, authCode, recipient: settings.recipient_email, subject: email.subject, text: email.text });
    await applyAction('mark-reminder-sent', { log_id: claim.log_id, smtp_code: 250 });
    sent++;
  } catch (error) {
    await applyAction('mark-reminder-failed', { log_id: claim.log_id, error: String(error?.message || 'SMTP send failed').replace(/authorization|auth.?code|password|secret/ig, '[redacted]') });
    failed++;
  }
}
if (sent || failed) spawnSync(process.execPath, [mirrorScript], { cwd: workspace, windowsHide: true, stdio: 'ignore', env: process.env });
log({ ok: failed === 0, enabled: true, candidates: candidates.length, sent, skipped, failed });
process.exit(failed ? 1 : 0);
