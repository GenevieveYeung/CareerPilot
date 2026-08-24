const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const base = 'http://127.0.0.1:8420/product.html';
const outDir = path.join(__dirname, 'audit', 'ui_language_audit_20260824');
fs.mkdirSync(outDir, { recursive: true });
const exactForbidden = new Set([
  'All', 'Active', 'Need Action', 'Waiting', 'Rejected', 'Current status', 'Submitted', 'Submitted CV', 'Current task',
  'OA received', 'OA deadline', 'Waiting for update', 'Active progress', 'Application details', 'Company', 'Position',
  'Current tasks', 'Deadlines', 'No deadline recorded', 'Record progress', 'No timeline records', 'Timeline', 'Recruitment Event', 'Career Fair',
  '生成搜索 Prompt', '生成定制简历 Prompt', '定制简历 Prompt', '复制 Prompt', 'Currently studying / 在读', 'Legal First / Last Name', 'Resume Version'
]);
const phraseForbidden = ['days left', 'overdue by', 'date not set', 'No open task', 'Application ID:', 'Channel:', 'Deadline:'];

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const report = { pages: [], forbidden: [], consoleErrors };

  async function snap(name) {
    await page.waitForTimeout(500);
    const body = await page.locator('body').innerText();
    const lines = body.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const hits = lines.filter(line => exactForbidden.has(line) || phraseForbidden.some(phrase => line.includes(phrase)));
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage: true });
    report.pages.push({ name, url: page.url(), hits, textSample: lines.slice(0, 80) });
    hits.forEach(hit => report.forbidden.push({ page: name, text: hit }));
  }

  await page.goto(base, { waitUntil: 'networkidle' });
  await snap('01-home');
  for (const view of ['jobs', 'apps', 'calendar', 'mine']) {
    await page.locator(`[data-view="${view}"]`).first().click();
    await page.waitForTimeout(300);
    await snap(`02-${view}`);
  }

  await page.locator('[data-view="apps"]').first().click();
  await page.waitForTimeout(300);
  for (const key of ['all', 'active', 'need-action', 'waiting', 'rejected']) {
    const button = page.locator(`#apps [data-af="${key}"]`);
    if (await button.count()) { await button.click(); await snap(`03-apps-${key}`); }
  }
  const firstApp = page.locator('#apps tbody tr').first();
  if (await firstApp.count()) { await firstApp.click(); await snap('04-application-detail'); const close = page.locator('#drawer [data-close]').first(); if (await close.count()) await close.click(); }

  await page.locator('[data-view="calendar"]').first().click();
  await page.waitForTimeout(300);
  const event = page.locator('#calendar [data-open-event]').first();
  if (await event.count()) { await event.click(); await snap('05-calendar-event-detail'); const close = page.locator('#drawer [data-close]').first(); if (await close.count()) await close.click(); }

  await page.locator('[data-view="mine"]').first().click();
  await page.waitForTimeout(300);
  for (const tab of ['0', '1', '2', '3', '4', '5']) {
    const button = page.locator(`#mine [data-tab="${tab}"]`);
    if (await button.count()) { await button.click(); await page.waitForTimeout(250); await snap(`06-mine-tab-${tab}`); }
  }
  await page.locator('[data-view="jobs"]').first().click();
  await page.waitForTimeout(300);
  const searchButton = page.locator('[data-start-search], [data-run-routine]').first();
  if (await searchButton.count()) { await searchButton.click(); await snap('07-search-prompt-modal'); }

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ screenshots: report.pages.length, forbidden: report.forbidden, consoleErrors: report.consoleErrors }, null, 2));
  await browser.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
