import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36', acceptDownloads: true });
const page = await ctx.newPage();
const out = { cdnHits: [] };
page.on('request', (req) => { const u = req.url(); if (/pureapk|\.apk|\.xapk/i.test(u)) out.cdnHits.push(u); });
await page.goto('https://apkcombo.com/alza/cz.alza.eshop/download/phone-2026.17.0-apk', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(7000);
out.buttons = await page.evaluate(() => [...document.querySelectorAll('a,button')].map(b => ({ t: (b.innerText || '').slice(0, 40), href: b.href || null })).filter(x => /apk|download/i.test(x.t)).slice(0, 10));
console.log('buttons:', JSON.stringify(out.buttons, null, 1));
console.log('cdn hits so far:', out.cdnHits.slice(0, 5));
// click the version download button, watch for popup/download
try {
  const popupPromise = ctx.waitForEvent('page', { timeout: 20000 });
  await page.getByText(/Download APK/i).first().click({ timeout: 8000 });
  const popup = await popupPromise.catch(() => null);
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    out.popupUrl = popup.url();
    out.popupLinks = await popup.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /pureapk|\.apk/i.test(h)).slice(0, 5)).catch(() => []);
  }
} catch (e) { out.clickErr = String(e).slice(0, 250); }
await page.waitForTimeout(4000);
out.cdnHits = [...new Set(out.cdnHits)];
fs.writeFileSync('/tmp/apk-cdn.json', JSON.stringify(out, null, 1));
console.log('final cdn hits:', JSON.stringify(out.cdnHits.slice(0, 8), null, 1));
console.log('popup:', JSON.stringify({ popupUrl: out.popupUrl, popupLinks: out.popupLinks }));
await browser.close();
