import { chromium } from '../tests/support/playwright_loader.mjs';

const base = 'http://127.0.0.1:8420';
const report = { health: null, static: {}, data: {}, pages: {}, search: {}, application: {}, performance: {}, consoleErrors: [], requestFailures: [], badResponses: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', request => report.requestFailures.push(`${request.method()} ${request.url()}`));
page.on('response', response => { if (response.status() >= 400) report.badResponses.push(`${response.status()} ${response.url()}`); });

const json = async path => { const response = await fetch(`${base}${path}`); return { status: response.status, body: await response.json() }; };
const visit = async (view, marker) => {
  const started = performance.now();
  await page.locator(`header nav [data-view="${view}"]`).click();
  await page.waitForSelector(`.page.active#${view}`);
  await page.waitForTimeout(80);
  const body = await page.locator(`#${view}`).innerText();
  report.pages[view] = { loaded: body.trim().length > 30 && (!marker || body.includes(marker)), ms: Math.round(performance.now() - started), marker: marker || '' };
  report.performance[view] = report.pages[view].ms;
};

try {
  const started = performance.now();
  report.health = await json('/api/health');
  report.health.elapsed_ms = Math.round(performance.now() - started);
  const root = await fetch(`${base}/`);
  const product = await fetch(`${base}/product.html`);
  report.static = { root: root.status, product: product.status, productHasCareerPilot: (await product.text()).includes('CareerPilot') };

  await page.goto(`${base}/product.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#home .head');
  await visit('home', '今天要做什么');
  await visit('jobs', '岗位');
  await visit('apps', '我的申请');
  const snapshotResponse = await json('/api/master/snapshot');
  const snapshot = snapshotResponse.body;
  report.data.snapshot = { status: snapshotResponse.status, ok: snapshot.ok };
  report.data.counts = { jobs: snapshot.jobs?.length || 0, applications: snapshot.applications?.length || 0, materialVersions: snapshot.materialVersions?.length || 0, events: snapshot.applicationEvents?.length || 0, reminders: snapshot.reminderSettings ? 1 : 0 };
  report.data.hasExistingData = report.data.counts.jobs > 0 && report.data.counts.applications > 0 && report.data.counts.materialVersions > 0;
  await visit('calendar', '日历');
  await visit('mine', '我的');
  const myTabs = await page.locator('#mine .my-tabs [data-my-tab], #mine [data-tab]').allTextContents();
  report.pages.mine.tabs = myTabs;
  report.pages.mine.allTabsPresent = ['个人资料', '求职偏好', '求职资料', '搜索模板', '数据与设置', '提醒设置'].every(label => myTabs.includes(label));

  await page.locator('#mine [data-my-tab="search_templates"]').click();
  await page.waitForTimeout(120);
  const routineButton = page.locator('#mine [data-run-routine]').first();
  report.search.savedTemplateLoaded = await routineButton.count() > 0;
  if (await routineButton.count()) {
    await routineButton.click();
    await page.waitForTimeout(120);
    report.search.promptGenerated = await page.locator('#generated-search-prompt').count() === 1 && (await page.locator('#generated-search-prompt').inputValue()).length > 20;
    await page.locator('#modal [data-cancel]').click().catch(() => {});
  }

  await page.locator('header nav [data-view="apps"]').click();
  const filters = await page.locator('#apps .filters button, #apps [data-af]').allTextContents();
  report.application.filters = filters;
  report.application.filtersChinese = JSON.stringify(filters) === JSON.stringify(['全部', '进行中', '待处理', '等待进展', '已拒绝']);
  const firstRow = page.locator('#apps tbody tr').first();
  if (await firstRow.count()) {
    await firstRow.click();
    const drawerText = await page.locator('#drawer').innerText();
    report.application.detailReadOnly = ['申请详情', '提交简历', '申请时间线', '当前任务'].every(text => drawerText.includes(text));
    report.application.hasResumeControl = await page.locator('#drawer [data-choose-cv], #drawer [data-confirm-candidate]').count() > 0;
    report.application.hasTimelineControl = await page.locator('#drawer [data-record]').count() > 0;
    await page.locator('#drawer [data-close]').click();
  }

  report.summary = {
    startup: report.health.status === 200 && report.health.body.ready === true && report.static.root === 200 && report.static.product === 200,
    pages: Object.values(report.pages).filter(item => item.loaded !== undefined).every(item => item.loaded),
    data: report.data.hasExistingData,
    search: report.search.savedTemplateLoaded && report.search.promptGenerated,
    application: report.application.filtersChinese && report.application.detailReadOnly && report.application.hasResumeControl && report.application.hasTimelineControl,
    browserClean: report.consoleErrors.length === 0 && report.requestFailures.length === 0 && report.badResponses.length === 0,
  };
  report.ok = Object.values(report.summary).every(Boolean);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
} finally {
  await browser.close();
}
