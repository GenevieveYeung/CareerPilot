const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const api = async (url, body) => page.evaluate(async ({ url, body }) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await response.json();
    if (!response.ok || json.ok === false) throw new Error(json.message || json.error || 'API failed');
    return json;
  }, { url, body });

  await page.goto('http://127.0.0.1:8421/product.html', { waitUntil: 'networkidle' });
  console.log('loaded');
  await page.locator('[data-view="apps"]').click();
  await page.waitForTimeout(200);

  const preRow = page.locator('#apps tbody tr').filter({ hasText: 'Pre-submit' });
  await preRow.click();
  await page.getByRole('button', { name: /选择简历|更换/ }).first().click();
  console.log('pre drawer');
  await page.locator('input[name="resume-library-choice"]').first().check();
  await page.locator('#modal').getByRole('button', { name: '使用这份简历', exact: true }).click();
  console.log('pre saved');
  await page.waitForTimeout(300);
  const preSnapshot = await page.evaluate(() => fetch('/api/master/snapshot', { cache: 'no-store' }).then(response => response.json()));
  const pre = preSnapshot.applications.find(row => row.application_id === 'qa-resume-pre');
  if (!pre?.selected_cv_resume_id || pre.submitted_resume_id) throw new Error('Pre-submit selection did not stay separate from submitted snapshot');
  await page.locator('#drawer [data-close]').click();

  const oaRow = page.locator('#apps tbody tr').filter({ hasText: 'Already Applied' });
  await oaRow.click();
  console.log('oa drawer');
  const confirmButton = page.locator('#drawer [data-choose-cv]').first();
  if (await confirmButton.count()) {
    await confirmButton.click();
    await page.locator('input[name="resume-library-choice"]').first().check();
    const save = page.locator('#modal').getByRole('button', { name: '使用这份简历', exact: true });
    await save.dblclick();
    console.log('oa saved');
    await page.waitForTimeout(350);
  }
  const after = await page.evaluate(() => fetch('/api/master/snapshot', { cache: 'no-store' }).then(response => response.json()));
  const oa = after.applications.find(row => row.application_id === 'qa-resume-oa');
  if (!oa?.confirmed_by_user || !oa?.submitted_resume_id || !oa?.actual_submitted_file_path) throw new Error('Historical submitted resume confirmation did not persist');
  const historicalRows = after.applicationMaterials.filter(row => row.application_id === 'qa-resume-oa' && !row.deleted_at && row.mapping_status === 'Confirmed');
  if (historicalRows.length > 2) throw new Error(`Duplicate submitted snapshot created: ${historicalRows.length}`);
  await page.locator('#drawer [data-close]').click();

  await page.locator('[data-view="mine"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-tab="2"]').click();
  await page.waitForTimeout(200);
  await page.locator('[data-material-subtab="all"]').click();
  const slotButtons = page.locator('[data-material-slot]');
  if (!(await slotButtons.count())) throw new Error('Independent Word/PDF slot controls missing');
  await slotButtons.first().click();
  const accept = await page.locator('#material-slot-file').getAttribute('accept');
  if (!['.docx', '.pdf'].includes(accept)) throw new Error(`Unexpected slot accept type: ${accept}`);
  await page.getByRole('button', { name: '取消', exact: true }).click();

  console.log(JSON.stringify({ ok: true, preSubmitSeparate: true, historicalConfirmed: true, duplicateSnapshot: false, slotControls: await slotButtons.count() }));
  await browser.close();
})().catch(error => { console.error(error.stack || error); process.exit(1); });
