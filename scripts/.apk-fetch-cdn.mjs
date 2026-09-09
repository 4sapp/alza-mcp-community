import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36', acceptDownloads: true });
const page = await ctx.newPage();
await page.goto('https://apkcombo.com/alza/cz.alza.eshop/download/phone-2026.17.0-apk', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
const href = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).find(h => h.includes('apkcombo.com/d?u=')));
const dlPromise = page.waitForEvent('download', { timeout: 90000 });
try { await page.goto(href, { waitUntil: 'commit', timeout: 60000 }); } catch (e) { console.log('goto note:', String(e).split('\n')[0]); }
const dl = await dlPromise;
await dl.saveAs('/tmp/alza-2026.17.0-redownload.apk');
console.log('saved:', dl.suggestedFilename());
await browser.close();
