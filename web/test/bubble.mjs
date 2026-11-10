// The tip bubble appears after load; "Run it" applies 20 min / $5 and runs the simulation.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('tipBubble')?.classList.contains('show'), { timeout: 20000 });
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: `${out}/bubble.png` });
await page.click('#tipBubble .tb-go');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 600000 });
console.log(await page.$eval('#simUses', (e) => e.textContent), '|', await page.$eval('#simStatus', (e) => e.textContent));
console.log('errors', errs.slice(0, 3));
await browser.close();
