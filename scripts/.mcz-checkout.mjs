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
    netlog.push({ step, phase: 'REQ', url: r.url(), method: r.method(), post: body.slice(0, 800) });
  }
});
page.on('response', async res => {
  if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
    let body = ''; try { body = (await res.text()).slice(0, 2500); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 600) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

await page.goto('https://m.alza.cz/catalog', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(5000);
const okb = page.locator('button:has-text("Rozumím")');
if (await okb.count()) await okb.click().catch(() => {});
await page.waitForTimeout(1000);

setStep('product');
// go straight to the search results and pick a cheap product (Zviratka pexeso, ~129 CZK)
await page.goto('https://m.alza.cz/search.htm?exps=pexeso', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
const prodLink = page.locator('a[href*="zviratka-d5303619"]').first();
console.log('product link count:', await prodLink.count());
let href = await prodLink.getAttribute('href');
console.log('product:', href);
await page.goto('https://m.alza.cz' + href, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
console.log('product URL:', page.url(), '|', (await txt(300)).slice(0, 200));

setStep('addtocart');
const addBtn = page.locator('button:has-text("Do košíku")').first();
console.log('add-to-cart btn:', await addBtn.count());
if (await addBtn.count()) {
  await addBtn.click();
  await page.waitForTimeout(10000);
}
console.log('after add URL:', page.url(), '|', (await txt(300)).slice(0, 250));

setStep('cart');
// find the cart page — try the current URL first, else navigate
let cartUrl = page.url();
if (!/kosik|checkout/i.test(cartUrl)) {
  const cartLink = page.locator('a[href*="kosik"], a[href*="checkout"]').first();
  if (await cartLink.count()) {
    cartUrl = await cartLink.getAttribute('href');
    console.log('cart link:', cartUrl);
    await page.goto('https://m.alza.cz' + (cartUrl.startsWith('http') ? cartUrl.replace('https://m.alza.cz', '') : cartUrl), { waitUntil: 'domcontentloaded', timeout: 60000 });
  } else {
    await page.goto('https://m.alza.cz/kosik.htm', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }
  await page.waitForTimeout(8000);
}
console.log('cart URL:', page.url(), '|', (await txt(600)).slice(0, 500));

setStep('checkout');
// continue to checkout / delivery selection
for (const label of ['Pokračovat', 'Pokračovat do objednávky', 'Pokračovat na dopravné', 'Pokračovat na platbu', 'Objednat', 'Pokračovat v objednávce']) {
  const b = page.locator(`button:has-text("${label}"), a:has-text("${label}")`).first();
  if (await b.count() && await b.isVisible().catch(() => false)) {
    console.log('clicking:', label);
    await b.click();
    await page.waitForTimeout(10000);
    break;
  }
}
console.log('checkout URL:', page.url(), '|', (await txt(800)).slice(0, 700));

fs.writeFileSync('/tmp/mcz-checkout1.json', JSON.stringify({ step, url: page.url(), body: await txt(2000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
