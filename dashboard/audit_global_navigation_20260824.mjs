import { chromium } from '../tests/support/playwright_loader.mjs';

const base = 'http://127.0.0.1:8420';
const expectedMain = ['首页', '岗位', '申请', '日历', '我的'];
const report = { mainNavigation: [], pages: {}, entryChecks: {}, consoleErrors: [], requestFailures: [], badResponses: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('pageerror', error => report.consoleErrors.push(`pageerror: ${error.message}`));
page.on('requestfailed', request => report.requestFailures.push(`${request.method()} ${request.url()}`));
page.on('response', response => { if (response.status() >= 400) report.badResponses.push(`${response.status()} ${response.url()}`); });

await page.goto(`${base}/`, { waitUntil: 'networkidle' });
await page.waitForSelector('#home .head', { timeout: 15000 });
const mainLabels = await page.locator('header nav [data-view]').allTextContents();
report.mainNavigation.push({ labels: mainLabels, pass: JSON.stringify(mainLabels) === JSON.stringify(expectedMain) });

for (const view of ['home', 'jobs', 'apps', 'calendar', 'mine']) {
  await page.locator(`header nav [data-view="${view}"]`).click();
  await page.waitForTimeout(120);
  const active = await page.locator('.page.active').getAttribute('id');
  report.pages[view] = { active, pass: active === view };
}

await page.locator('header nav [data-view="home"]').click();
const homeLinks = await page.locator('#home [data-go]').count();
if (homeLinks) {
  await page.locator('#home [data-go="apps"]').first().click();
  report.entryChecks.homeToApplications = (await page.locator('.page.active').getAttribute('id')) === 'apps';
  await page.locator('header nav [data-view="home"]').click();
  await page.locator('#home [data-go="calendar"]').first().click();
  report.entryChecks.homeToCalendar = (await page.locator('.page.active').getAttribute('id')) === 'calendar';
}

await page.locator('header nav [data-view="apps"]').click();
await page.waitForSelector('#apps .filters');
const appFilters = await page.locator('#apps [data-af]').allTextContents();
report.entryChecks.applicationFilters = { labels: appFilters, count: appFilters.length, pass: appFilters.length === 5 };
const appRow = page.locator('#apps tbody tr').first();
if (await appRow.count()) {
  await appRow.click();
  report.entryChecks.applicationDetail = {
    opened: await page.locator('#drawerbg.open').count() === 1,
    hasResumeEntry: await page.locator('#drawer [data-choose-cv], #drawer [data-confirm-candidate]').count() > 0,
    hasTimelineEntry: await page.locator('#drawer [data-record]').count() > 0,
  };
  await page.locator('#drawer [data-close]').click();
}

await page.locator('header nav [data-view="calendar"]').click();
const calendarEvent = page.locator('#calendar [data-open-event]').first();
if (await calendarEvent.count()) {
  await calendarEvent.click();
  report.entryChecks.calendarEventDetail = await page.locator('#drawerbg.open').count() === 1;
  await page.locator('#drawer [data-close]').click();
} else report.entryChecks.calendarEventDetail = 'no current event fixture';

await page.locator('header nav [data-view="mine"]').click();
await page.waitForSelector('#mine .my-tabs');
await page.locator('#mine [data-my-tab="profile"]').click();
const controls = {
  profileSave: await page.locator('#mine [data-profile-save-basic]').count(),
};
await page.locator('#mine [data-my-tab="preferences"]').click();
controls.preferencesSave = await page.locator('#mine [data-save-pref]').count();
await page.locator('#mine [data-my-tab="materials"]').click();
controls.materialActions = await page.locator('#mine [data-material-rescan], #mine [data-material-browse], #mine [data-material-open-folder]').count();
await page.locator('#mine [data-my-tab="search_templates"]').click();
controls.searchTemplateActions = await page.locator('#mine [data-run-routine], #mine [data-save-routine], #mine [data-generate-search-prompt]').count();
await page.locator('#mine [data-my-tab="data_settings"]').click();
controls.dataSettingsLoad = await page.locator('#mine [href="/api/master/download"]').count();
await page.locator('#mine [data-my-tab="reminders"]').click();
controls.reminderActions = await page.locator('#mine [data-save-reminder-settings], #mine [data-test-reminder]').count();
report.entryChecks.myControls = controls;
report.summary = {
  mainNavigationPass: report.mainNavigation.every(item => item.pass),
  pagesPass: Object.values(report.pages).every(item => item.pass),
  applicationFiltersPass: report.entryChecks.applicationFilters.pass,
  noBrowserErrors: report.consoleErrors.length === 0,
  noRequestFailures: report.requestFailures.length === 0,
  noBadResponses: report.badResponses.length === 0,
};
console.log(JSON.stringify(report, null, 2));
await browser.close();
