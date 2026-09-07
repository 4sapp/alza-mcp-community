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
    netlog.push({ step, phase: 'REQ', url: r.url(), method: r.method(), post: body.slice(0, 1200) });
  }
});
page.on('response', async res => {
  if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
    let body = ''; try { body = (await res.text()).slice(0, 4000); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 800) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

// same visitor as before? No — new context = new visitor. Re-add the item first.
await page.goto('https://m.alza.cz/hracky/zviratka-d5303619.htm', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const okb = page.locator('button:has-text("Rozumím")');
if (await okb.count()) await okb.click().catch(() => {});
const addBtn = page.locator('button:has-text("Do košíku")').first();
setStep('addtocart');
if (await addBtn.count()) { await addBtn.evaluate(el => el.click()); await page.waitForTimeout(8000); }
console.log('cart count state:', (await txt(200)).slice(0, 150));

// Order1 (cart)
setStep('order1');
await page.goto('https://m.alza.cz/Order1.htm?self=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(10000);
console.log('Order1:', (await txt(700)).slice(0, 600));

// continue to Order2 (delivery/payment)
setStep('order2');
for (const label of ['Pokračovat na dopravné', 'Pokračovat na platbu', 'Pokračovat', 'Pokračovat do objednávky', 'Pokračovat v objednávce', 'Pokračovat na adresu', 'Objednat']) {
  const b = page.locator(`button:has-text("${label}")`).first();
  if (await b.count() && await b.isVisible().catch(() => false)) {
    console.log('clicking:', label);
    await b.click();
    await page.waitForTimeout(12000);
    break;
  }
}
console.log('after order1-continue:', page.url(), '|', (await txt(900)).slice(0, 800));

// Order2: select AlzaBox delivery if possible
setStep('order2-delivery');
const bodyNow = await txt(2500);
console.log('ORDER2 BODY:', bodyNow.slice(0, 2000));

fs.writeFileSync('/tmp/mcz-checkout2.json', JSON.stringify({ step, url: page.url(), body: await txt(3000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
