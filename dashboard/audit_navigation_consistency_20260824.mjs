import { chromium } from '../tests/support/playwright_loader.mjs';

const base = 'http://127.0.0.1:8420';
const expected = ['个人资料', '求职偏好', '求职资料', '搜索模板', '数据与设置', '提醒设置'];
const keys = ['profile', 'preferences', 'materials', 'search_templates', 'data_settings', 'reminders'];
const results = { rounds: [], refresh: [], history: {}, responsive: [], consoleErrors: [], requestFailures: [], badResponses: [] };

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 900 } });
page.on('console', message => { if (message.type() === 'error') results.consoleErrors.push(message.text()); });
page.on('pageerror', error => results.consoleErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', request => results.requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || 'failed'}`));
page.on('response', response => { if (response.status() >= 400) results.badResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`); });

async function waitMine() {
  await page.waitForSelector('#mine .my-tabs', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#mine [data-my-tab]').length === 6, null, { timeout: 15000 });
}
async function readState(expectedIndex) {
  await waitMine();
  const labels = await page.locator('#mine [data-my-tab]').allTextContents();
  const active = await page.locator('#mine [data-my-tab].active').getAttribute('data-my-tab');
  const visible = await page.locator('#mine [data-my-tab]').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return { key: node.dataset.myTab, visible: !!(box.width && box.height), left: Math.round(box.left), right: Math.round(box.right) };
  }));
  const text = await page.locator('#mine').innerText();
  const route = new URL(page.url()).hash;
  const ok = JSON.stringify(labels) === JSON.stringify(expected) && active === keys[expectedIndex] && route === `#mine/${keys[expectedIndex]}` && visible.every(item => item.visible);
  return { expectedIndex, labels, active, route, visible, contentSample: text.slice(0, 160), ok };
}
async function goMine() {
  await page.goto(`${base}/#mine/profile`, { waitUntil: 'networkidle' });
  await waitMine();
}
async function clickTab(index) {
  await page.locator('#mine [data-my-tab]').nth(index).click();
  await page.waitForTimeout(100);
  return readState(index);
}

await goMine();
for (let round = 1; round <= 3; round += 1) {
  const states = [];
  for (let index = 0; index < expected.length; index += 1) states.push(await clickTab(index));
  states.push(await clickTab(0));
  results.rounds.push({ round, states, pass: states.every(item => item.ok) });
}

for (let index = 0; index < expected.length; index += 1) {
  await clickTab(index);
  await page.reload({ waitUntil: 'networkidle' });
  await waitMine();
  results.refresh.push(await readState(index));
}

await clickTab(0);
await clickTab(1);
await page.goBack({ waitUntil: 'networkidle' });
await page.waitForTimeout(100);
results.history.back = await readState(0);
await page.goForward({ waitUntil: 'networkidle' });
await page.waitForTimeout(100);
results.history.forward = await readState(1);

for (const width of [1920, 1536, 1366, 1280]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${base}/#mine/profile`, { waitUntil: 'networkidle' });
  await waitMine();
  const state = await readState(0);
  state.width = width;
  state.withinContainer = state.visible.every(item => item.left >= 0 && item.right <= width);
  state.ok = state.ok && state.withinContainer;
  results.responsive.push(state);
}

results.summary = {
  roundsPass: results.rounds.map(round => round.pass),
  refreshPass: results.refresh.every(item => item.ok),
  historyPass: results.history.back?.ok && results.history.forward?.ok,
  responsivePass: results.responsive.every(item => item.ok),
  consoleErrors: results.consoleErrors.length,
  requestFailures: results.requestFailures.length,
  badResponses: results.badResponses.length,
};
console.log(JSON.stringify(results, null, 2));
await browser.close();
