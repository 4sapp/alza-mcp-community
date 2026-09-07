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
const nz = page.locator('a:has-text("Nemám zájem"), button:has-text("Nemám zájem")').first();
if (await nz.count()) { await nz.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(1500); }
const prodRow = page.locator('[data-deliveryid="-11"]').first();
if (await prodRow.count()) {
  await prodRow.evaluate(el => { const r = el.querySelector('label, [role=radio], .MuiRadio-root, button, .MuiButtonBase-root'); if (r) r.click(); else el.click(); });
  await page.waitForTimeout(8000);
}
const clicked = await page.evaluate(() => {
  for (const b of document.querySelectorAll('[class*=order2Dialogs] button')) {
    const t = (b.textContent || '').trim();
    if (/Alza Hradec|Alza Pardubice|Alza 24\/7/i.test(t)) { b.click(); return t.slice(0, 50); }
  }
  return null;
});
console.log('place clicked:', clicked);
await page.waitForTimeout(6000);

setStep('order2-continue');
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after continue:', page.url(), '|', (await txt(500)).slice(0, 300));

// If still on Order2, the place registration may need the map-list click; try continue once more
if (page.url().includes('Order2')) {
  setStep('order2-continue2');
  await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
  await page.waitForTimeout(15000);
  console.log('after continue2:', page.url(), '|', (await txt(500)).slice(0, 300));
}

setStep('order3');
if (!page.url().includes('Order3')) {
  await page.goto('https://m.alza.cz/Order3.htm', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(12000);
}
console.log('order3:', page.url(), '|', (await txt(1200)).slice(0, 1000));

// fill guest email if present (keyboard typing for GWT SuggestBox)
const emailInput = page.locator('input[name="userEmail"], #userEmail, input[placeholder*="e-mail" i]').first();
if (await emailInput.count()) {
  await emailInput.evaluate(el => { el.focus(); el.select && el.select(); });
  await page.keyboard.type('e2e-user@example.invalid', { delay: 30 });
  await page.keyboard.press('Tab');
  await page.waitForTimeout(8000);
  console.log('email typed; billing section:', (await txt(2500)).includes('Jméno') || (await txt(2500)).includes('jméno'));
}

setStep('order3-continue');
await page.locator('button.order-footer__button-next').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after order3 continue:', page.url(), '|', (await txt(1400)).slice(0, 1200));

fs.writeFileSync('/tmp/mcz-checkout8.json', JSON.stringify({ step, url: page.url(), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
