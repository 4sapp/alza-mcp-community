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
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('order2:', page.url());

setStep('order2-select');
const nz = page.locator('a:has-text("Nemám zájem"), button:has-text("Nemám zájem")').first();
if (await nz.count()) { await nz.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(1500); }
const prodRow = page.locator('[data-deliveryid="-11"]').first();
if (await prodRow.count()) {
  await prodRow.evaluate(el => { const r = el.querySelector('label, [role=radio], .MuiRadio-root, button, .MuiButtonBase-root'); if (r) r.click(); else el.click(); });
  await page.waitForTimeout(8000);
}
// select the first pickup place in the places dialog
const dlgBtn = page.locator('[class*=order2Dialogs] button').first();
console.log('dialog place buttons:', await dlgBtn.count());
if (await dlgBtn.count()) {
  const t = (await dlgBtn.textContent().catch(() => '')) || '';
  console.log('clicking place:', t.slice(0, 80));
  await dlgBtn.evaluate(el => el.click());
  await page.waitForTimeout(8000);
}
console.log('order2 state:', (await txt(600)).slice(0, 400));

setStep('order3');
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after continue:', page.url());
let o3 = await txt(4000);
console.log('ORDER3:', o3.slice(0, 1800));

// Order3 guest info: fill email + name + street + city + zip + phone via keyboard (GWT caveat if GWT; React if MUI)
setStep('order3-fill');
const emailInput = page.locator('input[name="userEmail"], #userEmail, input[placeholder*="e-mail" i], input[type="email"]').first();
console.log('email input:', await emailInput.count());
if (await emailInput.count()) {
  await emailInput.evaluate(el => { el.focus(); el.select && el.select(); });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('e2e-user@example.invalid', { delay: 30 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(3000);
}
// fill the remaining visible required fields heuristically
const fillSeq = [
  ['input[name="name"], #name', 'E2E Test'],
  ['input[name="street"], #street', 'Example Street 2'],
  ['input[name="city"], #city', 'Hradec Králové'],
  ['input[name="zip"], #zip', '500 04'],
  ['input[name="inpTelNumber"], #inpTelNumber, input[name="phone"]', '+420601234567'],
];
for (const [sel, val] of fillSeq) {
  const el = page.locator(sel).first();
  if (await el.count() && await el.isVisible().catch(() => false)) {
    await el.evaluate(e => { e.focus(); e.select && e.select(); });
    await page.keyboard.press('Control+a');
    await page.keyboard.type(val, { delay: 25 });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(1500);
    console.log('filled:', sel.slice(0, 40));
  }
}
o3 = await txt(3000);
console.log('AFTER FILL:', o3.slice(0, 1500));

// continue to Order4 (payment)
setStep('order4');
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after order3-continue:', page.url());
const o4 = await txt(4000);
console.log('ORDER4:', o4.slice(0, 2500));

fs.writeFileSync('/tmp/mcz-checkout6.json', JSON.stringify({ step, url: page.url(), body: await txt(6000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
