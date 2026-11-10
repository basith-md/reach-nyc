// Run a low-res simulation and switch the mapped metric between Effective area and Area.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
console.log('pin view:', await page.$eval('#areaTotal', (e) => e.textContent), '|', await page.$eval('#effLine', (e) => e.textContent));
await page.click('input[name=simRes][value=low]');
await page.click('#simRun');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 300000 });
const leg = () => page.$eval('#simLegend', (e) => e.innerText.split('\n').filter(Boolean).slice(0, 3).join(' / '));
console.log('eff :', await leg());
await page.click('input[name=simMetric][value=area]');
await new Promise((r) => setTimeout(r, 2000));
console.log('area:', await leg());
await page.evaluate(() => document.getElementById('simLegend').scrollIntoView());
await page.screenshot({ path: `${out}/metric_area.png` });
console.log('errors', errs.slice(0, 3));
await browser.close();
