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
    netlog.push({ step, phase: 'REQ', url: r.url(), method: r.method(), post: body.slice(0, 2000) });
  }
});
page.on('response', async res => {
  if (res.request().resourceType() === 'xhr' || res.request().resourceType() === 'fetch') {
    let body = ''; try { body = (await res.text()).slice(0, 6000); } catch {}
    netlog.push({ step, phase: 'RES', url: res.url(), status: res.status(), body });
  }
});
const setStep = s => { step = s; };
const txt = async (n = 1000) => (await page.evaluate((n) => document.body ? document.body.innerText.slice(0, n) : '', n)).replace(/\s+/g, ' ');

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

setStep('order2-alzabox');
// click the AlzaBox panel
const ab = page.locator('div.order2-delivery').first();
console.log('AlzaBox panel:', await ab.count());
if (await ab.count()) { await ab.evaluate(el => el.click()); await page.waitForTimeout(5000); }
let boxInfo = await page.evaluate(() => {
  const t = document.body.innerText;
  return { hasBoxSearch: /vyberte|zvolte.*alzabox|vyhledat.*alzabox|box/i.test(t) };
});
console.log('box UI hint:', JSON.stringify(boxInfo));
// search/select a box — look for an input inside the AlzaBox panel
const boxInput = page.locator('div.order2-delivery input[type="text"], div.order2-delivery input[type="search"]').first();
console.log('box input:', await boxInput.count());
if (await boxInput.count()) {
  await boxInput.evaluate(el => el.focus());
  await page.keyboard.type('Hradec', { delay: 80 });
  await page.waitForTimeout(6000);
}
// click the first suggested box
const boxSug = page.locator('li, div').filter({ hasText: /Hradec Králové/i }).first();
if (await boxSug.count()) {
  console.log('clicking box suggestion');
  await boxSug.evaluate(el => el.click()).catch(() => {});
  await page.waitForTimeout(5000);
}
console.log('order2 state:', (await txt(1200)).slice(0, 700));

// continue to Order3
setStep('order3');
await page.locator('button:has-text("Pokračovat")').last().evaluate(el => el.click()).catch(() => {});
await page.waitForTimeout(15000);
console.log('after order2-continue:', page.url());
const o3 = await txt(3000);
console.log('ORDER3:', o3.slice(0, 1500));

fs.writeFileSync('/tmp/mcz-checkout4.json', JSON.stringify({ step, url: page.url(), body: await txt(4000), netlog }, null, 1));
console.log('NETLOG:', netlog.length);
await browser.close();
