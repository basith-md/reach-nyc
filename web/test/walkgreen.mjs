// Hover a hexagon within walking range of the default pin: walking should carry the Greenest badge.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await new Promise((r) => setTimeout(r, 3500)); await page.evaluate(() => document.querySelector('#tipBubble .tb-x')?.click());
await new Promise((r) => setTimeout(r, 1500));
for (const [x, y] of [[660, 360], [640, 300], [600, 380]]) {
  await page.mouse.move(x - 6, y - 6); await new Promise((r) => setTimeout(r, 200)); await page.mouse.move(x, y);
  await new Promise((r) => setTimeout(r, 1500));
  const t = await page.$eval('#tip', (e) => (e.hidden ? '(hidden)' : [...e.querySelectorAll('.sec .lab')].map((l) => l.innerText.replace(/\n/g, ' ') + (l.parentElement.classList.contains('is-green') ? ' [GREEN]' : '')).join(' / ') + ' :: ' + e.querySelector('.big').innerText.replace(/\n/g, ' ')));
  console.log(x, y, t);
}
console.log('errors', errs.slice(0, 3));
await browser.close();
