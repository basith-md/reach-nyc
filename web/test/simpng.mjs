// Run a low-res simulation, click "Download map (PNG)" and save the downloaded file.
import puppeteer from 'puppeteer-core';
const out = process.argv[2];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], defaultViewport: { width: 1440, height: 900 } });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push(e.message));
const cdp = await page.createCDPSession();
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: out });
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => document.getElementById('status')?.textContent?.startsWith('Computed'), { timeout: 120000 });
await page.click('#simPanel .panel-head');
await page.click('input[name=simRes][value=low]');
await page.click('#simRun');
await page.waitForFunction(() => document.getElementById('simStatus')?.textContent?.startsWith('Done'), { timeout: 300000 });
await new Promise((r) => setTimeout(r, 1500));
await page.click('#simPng');
await new Promise((r) => setTimeout(r, 15000));
console.log('errors', errs.slice(0, 3));
await browser.close();
