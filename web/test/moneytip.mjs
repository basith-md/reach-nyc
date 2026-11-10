// Screenshot hover tooltips in money mode at a few spots.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.click('.budget-sw button[data-b=money]');
await new Promise((r) => setTimeout(r, 600));
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await new Promise((r) => setTimeout(r, 2500));
let k = 0;
for (const [x, y] of [[640, 420], [900, 600]]) {
  await page.mouse.move(x - 5, y - 5); await new Promise((r) => setTimeout(r, 200)); await page.mouse.move(x, y);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: `${out}/mtip${k++}.png` });
}
console.log('errors', errs.slice(0, 3));
await browser.close();
