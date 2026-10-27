import fs from 'node:fs';
import { chromium } from 'playwright';

const baseUrl = process.env.COAI_PREVIEW_URL ?? 'http://127.0.0.1:4173';
const result = { checked_at: new Date().toISOString(), url: baseUrl, checks: {}, inference: 'not attempted', sandbox: 'not attempted' };
const browser = await chromium.launch({ headless: true, ...(process.env.COAI_BROWSER_EXECUTABLE ? { executablePath: process.env.COAI_BROWSER_EXECUTABLE } : {}) });
const errors = [];
function check(name, ok) { result.checks[name] = Boolean(ok); if (!ok) throw new Error(`Acceptance failed: ${name}`); }
async function openFixture(page) {
  await page.getByRole('heading', { name: /One thread/ }).waitFor({ timeout: 45000 });
  await page.getByRole('button', { name: /Fix duplicate charges on retry/ }).first().click();
  await page.getByRole('region', { name: 'Judge walkthrough' }).waitFor();
}
try {
  const a = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pageA = await a.newPage();
  const pageB = await b.newPage();
  for (const page of [pageA, pageB]) page.on('pageerror', e => errors.push(e.message));
  await Promise.all([pageA.goto(baseUrl), pageB.goto(baseUrl)]);
  await Promise.all([openFixture(pageA), openFixture(pageB)]);
  check('desktop_and_mobile_load_live_fixture', true);
  check('mobile_has_no_horizontal_overflow', await pageB.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check('live_view_hides_simulation_controls', await pageA.getByRole('button', { name: /pause sim|resume sim/ }).count() === 0);
  await pageA.getByRole('button', { name: 'Try this request', exact: true }).click();
  check('guided_request_is_prepared_without_submission', (await pageA.locator('#composer').inputValue()).startsWith('/fix Change payments.py only:'));
  const text = `Browser acceptance check ${new Date().toISOString()}: shared chat persists across independent sessions.`;
  await pageA.locator('#composer').fill(text);
  await pageA.getByRole('button', { name: 'Send', exact: true }).click();
  await pageB.getByText(text, { exact: true }).waitFor({ timeout: 30000 });
  check('chat_reaches_second_browser_live', true);
  await pageB.reload();
  await openFixture(pageB);
  await pageB.getByText(text, { exact: true }).waitFor();
  check('shared_chat_survives_reload', true);
  const download = pageA.waitForEvent('download');
  await pageA.getByRole('button', { name: 'Export replay', exact: true }).click();
  const artifact = await download;
  await artifact.saveAs('/tmp/coai-acceptance-replay.json');
  const replay = JSON.parse(fs.readFileSync('/tmp/coai-acceptance-replay.json', 'utf8'));
  check('replay_download_contains_shared_chat', replay.schema === 'co-ai.replay.v1' && replay.messages.some(message => message.body === text));
  check('no_browser_runtime_errors', errors.length === 0);
  await pageA.screenshot({ path: '/tmp/coai-desktop-acceptance.png', fullPage: true });
  await pageB.screenshot({ path: '/tmp/coai-mobile-acceptance.png', fullPage: true });
  result.outcome = 'passed';
} catch (error) {
  result.outcome = 'failed'; result.error = error.message; result.runtime_errors = errors;
  process.exitCode = 1;
} finally {
  await browser.close();
  fs.mkdirSync('deploy/evidence', { recursive: true });
  fs.writeFileSync('deploy/evidence/browser-acceptance.json', JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
