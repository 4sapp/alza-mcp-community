import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await (await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' })).newPage();
await page.goto('https://www.alza.cz/Services/EShopService.svc?wsdl', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(12000);
const content = await page.evaluate(() => document.body ? document.body.innerText : '');
const isWsdl = /<\?xml|<definitions|<wsdl/i.test(content);
console.log('isWsdl:', isWsdl, 'len:', content.length);
if (isWsdl) {
  const fs = await import('fs');
  fs.writeFileSync('/tmp/eshop-wsdl.txt', content);
} else {
  console.log(content.slice(0, 400));
}
await browser.close();
