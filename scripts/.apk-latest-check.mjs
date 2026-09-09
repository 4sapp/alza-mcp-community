import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36', acceptDownloads: true });
const page = await ctx.newPage();
const out = { date: '2026-09-09', tried: [] };
const urls = [
  'https://apkcombo.com/alza/cz.alza.eshop/',
  'https://apkcombo.com/alza/',
  'https://apkpure.com/alza/cz.alza.eshop',
];
for (const url of urls) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 3000) ?? '');
    out.tried.push({ url, status: r?.status(), title: await page.title().catch(() => ''), snippet: body.slice(0, 600) });
    // version mentions on the page
    const versions = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      return [...new Set(text.match(/2026\.\d+(\.\d+)?/g))] ?? [];
    });
    out.tried[out.tried.length - 1].versions = versions;
    if (r && r.status() === 200 && versions.length) {
      out.workingUrl = url;
      break;
    }
  } catch (e) {
    out.tried.push({ url, error: String(e).slice(0, 200) });
  }
}
fs.writeFileSync('/tmp/apk-latest-check.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
await browser.close();
