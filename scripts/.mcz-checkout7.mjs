import { chromium } from 'playwright';
import fs from 'fs';

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36', viewport: { width: 412, height: 915 } });
const page = await ctx.newPage();
const netlog = [];
let step = 'init';
page.on('request', r => {
  if (r.resourceType() === 'xhr' || r.resourceType() === 'fetch') {
    let body = ''; try { body = r.postData() || ''; } catch {}
    netlog.push({ step, phase: 'REQ', url: r.url(), method: r.method(), post: body.slice(0, 2500) });
  }
});
page.on('response', async res => {
  if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
    let body = ''; try { body = (await res.text()).slice(0, 6000); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 800) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

await page.goto('https://m.alza.cz/hracky/zviratka-d5303619.htm', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const okb = page.locator('button:has-text("Rozumím")');
if (await okb.count()) await okb.click().catch(() => {});
setStep('addtocart');
const addBtn = page.locator('button:has-text("Do košíku")').first();
if (await addBtn.count()) { await addBtn.evaluate(el => el.click()); await page.waitForTimeout(8000); }

setStep('order1');
await page.goto('https://m.alza.cz/Order1.htm?self=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);

setStep('order2');
await page.goto('https://m.alza.cz/Order2.htm', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
// try selecting a place via the dialog buttons (list all first)
const nz = page.locator('a:has-text("Nemám zájem"), button:has-text("Nemám zájem")').first();
if (await nz.count()) { await nz.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(1500); }
const prodRow = page.locator('[data-deliveryid="-11"]').first();
if (await prodRow.count()) {
  await prodRow.evaluate(el => { const r = el.querySelector('label, [role=radio], .MuiRadio-root, button, .MuiButtonBase-root'); if (r) r.click(); else el.click(); });
  await page.waitForTimeout(8000);
}
const btns = await page.evaluate(() => [...document.querySelectorAll('[class*=order2Dialogs] button, [class*=order2Dialogs] [role=button]')].map(b => (b.textContent || '').trim().slice(0, 60)).slice(0, 12));
console.log('dialog buttons:', JSON.stringify(btns));
// click the button whose text looks like a place (contains "Alza" or "Doručíme")
const clicked = await page.evaluate(() => {
  for (const b of document.querySelectorAll('[class*=order2Dialogs] button, [class*=order2Dialogs] [role=button]')) {
    const t = (b.textContent || '').trim();
    if (/Alza|Doručíme|AlzaBox|Vyzvedněte/i.test(t)) { b.click(); return t.slice(0, 60); }
  }
  return null;
});
console.log('clicked:', clicked);
await page.waitForTimeout(8000);

setStep('order3-direct');
await page.goto('https://m.alza.cz/Order3.htm', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);
console.log('order3:', page.url(), '|', (await txt(900)).slice(0, 700));

setStep('order4-direct');
await page.goto('https://m.alza.cz/Order4.htm', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
await page.waitForTimeout(12000);
console.log('order4:', page.url(), '|', (await txt(1500)).slice(0, 1200));

fs.writeFileSync('/tmp/mcz-checkout7.json', JSON.stringify({ step, url: page.url(), body: await txt(4000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
