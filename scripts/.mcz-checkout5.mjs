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
    let body = ''; try { body = (await res.text()).slice(0, 8000); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 1200) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

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
await page.locator('button:has-text("Pokračovat")').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('order2:', page.url());

setStep('order2-select');
// dismiss AlzaPlus banner
const nz = page.locator('a:has-text("Nemám zájem"), button:has-text("Nemám zájem")').first();
if (await nz.count()) { console.log('dismiss AlzaPlus'); await nz.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(2000); }
// click the "Prodejny" delivery row's radio (MUI radio inside the row)
const prodRow = page.locator('.dp-item, [data-deliveryid="-11"]').first();
console.log('prodejny row:', await prodRow.count());
if (await prodRow.count()) {
  const radio = prodRow.locator('label, [role=radio], .MuiRadio-root, button').first();
  console.log('radio in row:', await radio.count());
  await prodRow.evaluate(el => {
    const r = el.querySelector('label, [role=radio], .MuiRadio-root, button, .MuiButtonBase-root');
    if (r) r.click(); else el.click();
  });
  await page.waitForTimeout(8000);
}
console.log('after select:', (await txt(900)).slice(0, 600));

// continue to Order3
setStep('order3');
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after continue:', page.url());
const o3 = await txt(4000);
console.log('ORDER3 BODY:', o3.slice(0, 2500));

fs.writeFileSync('/tmp/mcz-checkout5.json', JSON.stringify({ step, url: page.url(), body: await txt(5000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
