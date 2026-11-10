// Time mode: set the Simulation panel's spending cap and check the map's area and labels follow it.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const st = () => page.evaluate(() => [document.getElementById('areaTotal').textContent, document.getElementById('heroSub').textContent.trim(), document.getElementById('simUses').textContent, document.getElementById('tpw').value]);
const done = () => page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await done(); console.log('any price :', await st());
const setCap = async (v) => { await page.$eval('#thrIn', (el, v) => { el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, v); await new Promise((r) => setTimeout(r, 800)); await done(); };
await setCap('3'); console.log('cap $3    :', await st());
await setCap('10'); console.log('cap $10   :', await st());
await page.screenshot({ path: process.argv[2] + '/thr_cap.png' });
await setCap(''); console.log('cleared   :', await st());
await page.screenshot({ path: process.argv[2] + '/thr.png' });
console.log('errors', errs.slice(0, 3));
await browser.close();
