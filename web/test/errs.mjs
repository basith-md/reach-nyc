// Load the page and print status + any errors after 20 s.
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errs = []; page.on('pageerror', (e) => errs.push('pageerror: ' + e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
await page.goto(process.argv[2] || 'http://localhost:5173/', { waitUntil: 'networkidle2', timeout: 60000 }).catch((e) => errs.push('goto: ' + e.message));
await new Promise((r) => setTimeout(r, 20000));
console.log(await page.evaluate(() => document.getElementById('status')?.textContent));
console.log(errs.slice(0, 6).join('\n'));
await browser.close();
