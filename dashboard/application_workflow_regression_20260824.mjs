import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '../tests/support/playwright_loader.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runDir = path.join(workspace, 'audit', 'application_workflow_runtime_20260824');
const port = '8431';
const base = `http://127.0.0.1:${port}`;
const result = { checks: {}, consoleErrors: [], requestFailures: [], badResponses: [] };
let child;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitReady() { for (let i = 0; i < 120; i += 1) { try { const j = await (await fetch(`${base}/api/health`)).json(); if (j.ready) return j; } catch {} await sleep(100); } throw Error('isolated server not ready'); }
async function stop() { if (!child || child.killed) return; if (process.platform === 'win32') await new Promise(resolve => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); k.once('close', resolve); k.once('error', resolve); setTimeout(resolve, 5000); }); else child.kill('SIGTERM'); await sleep(300); }
async function snapshot(page) { return page.evaluate(async () => (await (await fetch('/api/master/snapshot', { cache: 'no-store' })).json())); }

try {
  await fs.rm(runDir, { recursive: true, force: true }); await fs.mkdir(runDir, { recursive: true });
  await fs.copyFile(path.join(workspace, 'data', 'private', '.runtime', 'careerpilot_state.json'), path.join(runDir, 'careerpilot_state.json'));
  await fs.copyFile(path.join(workspace, 'data', 'private', 'runtime', 'careerpilot_runtime.xlsx'), path.join(runDir, 'careerpilot_runtime.xlsx'));
  child = spawn(process.execPath, [path.join(workspace, 'dashboard', 'server.js')], { cwd: path.join(workspace, 'dashboard'), windowsHide: true, stdio: 'ignore', env: { ...process.env, CAREERPILOT_PORT: port, CAREERPILOT_RUNTIME_STATE_PATH: path.join(runDir, 'careerpilot_state.json'), CAREERPILOT_MASTER_PATH: path.join(runDir, 'careerpilot_runtime.xlsx'), CAREERPILOT_SNAPSHOT_CACHE_PATH: path.join(runDir, 'snapshot.json') } });
  result.health = await waitReady();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('console', message => { if (message.type() === 'error') result.consoleErrors.push(message.text()); });
  page.on('pageerror', error => result.consoleErrors.push(error.message));
  page.on('requestfailed', request => result.requestFailures.push(request.url()));
  page.on('response', response => { if (response.status() >= 400) result.badResponses.push(`${response.status()} ${response.url()}`); });
  await page.goto(`${base}/product.html`, { waitUntil: 'networkidle' });
  await page.locator('[data-view="apps"]').click(); await page.waitForTimeout(150);
  const row = page.locator('#apps tbody tr').first(); const applicationId = await row.getAttribute('data-app'); await row.click();
  result.checks.application_open = Boolean(applicationId) && await page.locator('#drawer [data-record]').count() === 1;
  const choose = page.locator('#drawer [data-choose-cv]').first();
  if (await choose.count()) {
    await choose.click(); await page.waitForTimeout(100);
    const choices = page.locator('input[name="resume-library-choice"]');
    if (await choices.count()) {
      await choices.first().check();
      const save = page.locator('[data-resume-save-application]').last();
      await save.click(); await page.waitForTimeout(250);
      const afterResume = await snapshot(page); const app = afterResume.applications.find(item => item.application_id === applicationId);
      result.checks.resume_selection_saved = Boolean(app?.selected_cv_resume_id || app?.selected_cv_version_id || app?.selected_cv_submission_version_id);
    } else result.checks.resume_selection_saved = false;
    await page.locator('#drawer [data-close]').click().catch(() => {});
  } else result.checks.resume_selection_saved = false;
  await page.locator('#apps tbody tr').first().click(); await page.locator('#drawer [data-record]').click();
  await page.locator('#etype').selectOption('Other'); await page.locator('#edate').fill('2026-08-24'); await page.locator('#enotes').fill('CareerPilot migration regression test');
  await page.locator(`[data-save-progress="${applicationId}"]`).click(); await page.waitForTimeout(250);
  let afterEvent = await snapshot(page); const created = afterEvent.applicationEvents.find(item => item.application_id === applicationId && item.notes === 'CareerPilot migration regression test' && !item.deleted_at);
  result.checks.timeline_event_saved = Boolean(created);
  if (created) { await page.evaluate(async ({ event_id, version }) => fetch('/api/master/application/event/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_id, expected_version: version }) }), { event_id: created.event_id, version: created.version }); }
  await browser.close();
  result.checks.no_browser_errors = result.consoleErrors.length === 0 && result.requestFailures.length === 0 && result.badResponses.length === 0;
  result.ok = Object.values(result.checks).every(Boolean);
  console.log(JSON.stringify(result, null, 2)); if (!result.ok) process.exitCode = 1;
} catch (error) { result.error = error.stack || String(error); console.log(JSON.stringify(result, null, 2)); process.exitCode = 1; }
finally { await stop(); await fs.rm(runDir, { recursive: true, force: true }).catch(() => {}); }
