// Drive the local app in headless Edge: wait for a result, hover a tile, take screenshots.
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1440,900'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack}`));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
const status = await page.$eval('#status', (e) => e.textContent);
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/app_result.png` });
// hover a few points to find a tile with a tooltip
for (const [x, y] of [[760, 560], [700, 420], [820, 300]]) {
  await page.mouse.move(x, y);
  await new Promise((r) => setTimeout(r, 900));
  const visible = await page.$eval('#tip', (e) => !e.hidden);
  if (visible) { await page.screenshot({ path: `${out}/app_hover.png` }); break; }
}
// 3D view
await page.click('#advToggle');
await page.click('#three');
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${out}/app_3d.png` });
console.log('status:', status);
console.log(logs.filter((l) => !l.includes('DevTools')).slice(0, 20).join('\n'));
await browser.close();
