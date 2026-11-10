// Money mode: drop a second pin and check the result updates.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const st = () => page.evaluate(() => [document.getElementById('status').textContent, document.getElementById('areaTotal').textContent, document.getElementById('originName').textContent]);
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.click('.budget-sw button[data-b=money]');
await new Promise((r) => setTimeout(r, 600));
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
console.log('money, pin 1:', await st());
await page.mouse.click(900, 650);
for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 1000)); const s = await st(); if (i % 3 === 0 || s[0].startsWith('Computed')) console.log(i, s); if (s[0].startsWith('Computed') && i > 1) break; }
await new Promise((r) => setTimeout(r, 2000));
await page.screenshot({ path: `${out}/moneypin.png` });
console.log('errors', errs.slice(0, 5));
await browser.close();
