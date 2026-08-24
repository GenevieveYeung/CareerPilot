const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route('**/api/master/snapshot', async route => {
    const response = await route.fetch();
    const snapshot = await response.json();
    snapshot.applications = [...(snapshot.applications || []), {
      application_id: 'fixture-interview-application', job_id: 'fixture-interview-job',
      company: 'Fixture Interview Co.', job_title: 'Interview-stage fixture', job_url: '',
      attempt_date: '2026-08-20', status: 'Interview', current_stage: 'Interview',
      application_channel: 'UI test fixture', submission_evidence: 'Test only'
    }];
    snapshot.applicationEvents = [...(snapshot.applicationEvents || []), {
      event_id: 'fixture-interview-event', application_id: 'fixture-interview-application',
      job_id: 'fixture-interview-job', event_type: 'Interview Invitation', event_date: '2026-10-01',
      event_time: '', deadline: '', round: '', title: 'Interview invitation', notes: '', deleted_at: ''
    }];
    await route.fulfill({ response, json: snapshot });
  });
  await page.goto('http://127.0.0.1:8420/product.html', { waitUntil: 'networkidle' });
  await page.locator('[data-view="apps"]').click();
  await page.waitForTimeout(250);

  const filters = await page.locator('#apps .filters button').allTextContents();
  const expectedFilters = ['全部', '进行中', '待处理', '等待进展', '已拒绝'];
  if (JSON.stringify(filters) !== JSON.stringify(expectedFilters)) throw new Error(`filters: ${filters}`);

  const body = await page.locator('#apps').innerText();
  for (const expected of ['China Merchants Securities International Company Limited', 'BNP Paribas', 'Ant Group', 'Blackstone', '在线测评', '已拒绝', '在线测评截止：']) {
    if (!body.includes(expected)) throw new Error(`missing ${expected}`);
  }
  const rowCount = await page.locator('#apps tbody tr').count();
  if (rowCount < 4) throw new Error(`row count: ${rowCount}`);
  const statuses = await page.locator('#apps tbody tr td:nth-child(2)').allTextContents();
  for (const expected of ['已投递', '在线测评', '面试', '已拒绝']) {
    if (!statuses.includes(expected)) throw new Error(`status missing ${expected}: ${statuses}`);
  }
  const firstRow = await page.locator('#apps tbody tr').first().innerText();
  if (!firstRow.includes('在线测评截止：')) throw new Error(`deadline not prioritized: ${firstRow}`);

  await page.getByRole('button', { name: '已拒绝', exact: true }).click();
  if (!((await page.locator('#apps').innerText()).includes('Ant Group'))) throw new Error('Rejected filter failed');
  await page.getByRole('button', { name: '全部', exact: true }).click();
  await page.locator('#apps').getByText('Blackstone', { exact: true }).click();
  const drawer = await page.locator('#drawer').innerText();
  for (const expected of ['公司', '职位', '当前状态', '申请时间线', '提交简历', '求职信', '当前任务', '截止日期']) {
    if (!drawer.includes(expected)) throw new Error(`drawer missing ${expected}`);
  }
  console.log(JSON.stringify({ ok: true, filters, rowCount, statuses, firstRow, drawerChecks: 'passed' }));
  await browser.close();
})().catch(error => { console.error(error.stack || error); process.exit(1); });
