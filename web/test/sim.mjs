// Run a low-resolution connectivity simulation in headless Edge and screenshot the result.
import puppeteer from 'puppeteer-core';

const out = process.argv[2];
const res = process.argv[3] || 'low';
const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.click('#simPanel .panel-head');
await page.click(`input[name=simRes][value=${res}]`);
const t0 = Date.now();
await page.click('#simRun');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 900000 });
const status = await page.$eval('#simStatus', (e) => e.textContent);
const cores = await page.evaluate(() => navigator.hardwareConcurrency);
await page.click('#baseToggle');
await new Promise((r) => setTimeout(r, 2500));
await page.screenshot({ path: `${out}/sim_${res}.png` });
console.log(status, '| wall', Math.round((Date.now() - t0) / 1000), 's | cores', cores, '| errors', errs.slice(0, 3));
await browser.close();
