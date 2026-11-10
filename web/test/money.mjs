// Screenshot money-budget mode, then the simulation view with a hover tooltip.
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
await page.screenshot({ path: `${out}/money.png` });
await page.click('#simPanel .panel-head');
await page.click('input[name=simRes][value=low]');
await page.click('#simRun');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 300000 });
await new Promise((r) => setTimeout(r, 1500));
await page.mouse.move(820, 520); await new Promise((r) => setTimeout(r, 300)); await page.mouse.move(825, 525);
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: `${out}/money_sim.png` });
console.log(await page.$eval('#simStatus', (e) => e.textContent), '| errors', errs.slice(0, 3));
await browser.close();
