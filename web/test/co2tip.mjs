// Hover a few hexagons in time mode and money mode; print the tooltip text (CO2 + Greenest row) and screenshot.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const done = () => page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await done();
await new Promise((r) => setTimeout(r, 3500)); await page.evaluate(() => document.querySelector('#tipBubble .tb-x')?.click());
await new Promise((r) => setTimeout(r, 2500));
const hover = async (x, y, name) => {
  await page.mouse.move(x - 6, y - 6); await new Promise((r) => setTimeout(r, 200)); await page.mouse.move(x, y);
  await new Promise((r) => setTimeout(r, 1500));
  const txt = await page.$eval('#tip', (e) => (e.hidden ? '(hidden)' : e.innerText.replace(/\n+/g, ' | ')));
  console.log(`--- ${name}:`, txt);
  await page.screenshot({ path: `${out}/${name}.png` });
};
await hover(640, 470, 'co2_time_near');
await hover(900, 600, 'co2_time_far');
await page.click('.budget-sw button[data-b=money]');
await new Promise((r) => setTimeout(r, 600)); await done(); await new Promise((r) => setTimeout(r, 2500));
await hover(900, 600, 'co2_money_far');
console.log('errors', errs.slice(0, 3));
await browser.close();
