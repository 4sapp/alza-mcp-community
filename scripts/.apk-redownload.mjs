import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36', acceptDownloads: true });
const page = await ctx.newPage();
const out = {};
await page.goto('https://apkcombo.com/alza/cz.alza.eshop/download/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
// collect candidate download hrefs
const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /download|\.apk|\.xapk|pureapk/i.test(h)));
out.links = [...new Set(links)].slice(0, 12);
console.log('links:', JSON.stringify(out.links, null, 1));
// try clicking the main APK download button and capture the download
try {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 45000 }),
    page.click('text=Download APK', { timeout: 10000 }).catch(() => page.getByRole('link', { name: /apk/i }).first().click({ timeout: 10000 })),
  ]);
  const path = await download.path();
  out.suggested = download.suggestedFilename();
  out.tempPath = path;
  await download.saveAs('/tmp/alza-2026.17.0-redownload.apk');
  out.saved = true;
} catch (e) {
  out.downloadError = String(e).slice(0, 300);
}
fs.writeFileSync('/tmp/apk-redownload.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 1500));
await browser.close();
