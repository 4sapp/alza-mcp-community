import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const out = [];
for (const url of ['https://api.alza.cz/api/user/100000001/v1/alzapremium/trial', 'https://www.alza.cz/api/v1/alzapremium/trial']) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) ?? '');
    out.push({ url: url.slice(0, 70), status: r?.status(), body: body.slice(0, 150) });
  } catch (e) { out.push({ url: url.slice(0, 70), error: String(e).split('\n')[0] }); }
}
fs.writeFileSync('/tmp/a7-apihost.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
await browser.close();
