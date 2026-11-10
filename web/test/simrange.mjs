// Run a low-res simulation, screenshot, then pull the colour-range handles in and screenshot again.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.click('input[name=simRes][value=low]');
await page.click('#simRun');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 300000 });
await page.evaluate(() => document.getElementById('simLegend').scrollIntoView());
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${out}/range_full.png` });
const set = (id, v) => page.$eval(id, (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }, v);
const t0 = Date.now(); await set('#simLo', '25'); await set('#simHi', '75'); const dt = Date.now() - t0;
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: `${out}/range_mid.png` });
console.log('repaint ms', dt, '| legend', await page.$eval('#simLegend', (e) => e.innerText.replace(/\n+/g, ' | ')), '| errors', errs.slice(0, 3));
await browser.close();
