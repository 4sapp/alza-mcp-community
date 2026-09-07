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
    netlog.push({ step, phase: 'REQ', url: r.url(), method: r.method(), post: body.slice(0, 1500) });
  }
});
page.on('response', async res => {
  if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
    let body = ''; try { body = (await res.text()).slice(0, 5000); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 800) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

// add to cart (new visitor)
await page.goto('https://m.alza.cz/hracky/zviratka-d5303619.htm', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(8000);
const okb = page.locator('button:has-text("Rozumím")');
if (await okb.count()) await okb.click().catch(() => {});
setStep('addtocart');
const addBtn = page.locator('button:has-text("Do košíku")').first();
if (await addBtn.count()) { await addBtn.evaluate(el => el.click()); await page.waitForTimeout(8000); }

// Order1 -> Order2
setStep('order1');
await page.goto('https://m.alza.cz/Order1.htm?self=1', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
const cont1 = page.locator('button:has-text("Pokračovat")').last();
if (await cont1.count()) { await cont1.evaluate(el => el.click()); await page.waitForTimeout(12000); }
console.log('order2:', page.url());

// Order2: dismiss AlzaPlus banner, select AlzaBox
setStep('order2');
const np = page.locator('button:has-text("Nemám zájem"), a:has-text("Nemám zájem")').first();
if (await np.count()) { await np.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(2000); }
// click the AlzaBox option
const alzaBox = page.locator('text=/AlzaBox/').first();
if (await alzaBox.count()) { await alzaBox.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(4000); }
// maybe a box-selection dialog appears (pick a box)
const boxText = await txt(1500);
console.log('after AlzaBox click:', boxText.slice(0, 600));
// if a specific box selection is needed, look for "Vybrat AlzaBox" / list of boxes
for (const label of ['Vybrat AlzaBox', 'Zvolte AlzaBox', 'Pokračovat']) {
  const b = page.locator(`button:has-text("${label}")`).first();
  if (await b.count() && await b.isVisible().catch(() => false)) {
    console.log('order2 clicking:', label);
    await b.evaluate(el => el.click()).catch(() => {});
    await page.waitForTimeout(10000);
    break;
  }
}
console.log('after order2 continue:', page.url(), '|', (await txt(1200)).slice(0, 1000));

// Order3 (user info) — guest: fill email
setStep('order3');
const o3body = await txt(3000);
console.log('ORDER3:', o3body.slice(0, 1500));

fs.writeFileSync('/tmp/mcz-checkout3.json', JSON.stringify({ step, url: page.url(), body: await txt(3000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
