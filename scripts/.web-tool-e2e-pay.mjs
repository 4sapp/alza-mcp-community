import { chromium } from 'playwright';
import fs from 'fs';
const ORDER = '1057075103';
const HASH = '0BB816E57F1B22B2n5BwGFB9CA7';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = { date: '2026-09-08', order: ORDER, hash: HASH, steps: [] };
const res = await page.evaluate(async ({ ORDER, HASH }) => {
  const steps = [];
  const j = (t) => { try { return JSON.parse(t); } catch { return t.slice(0, 300); } };
  const unwrap = (p) => (p && typeof p === 'object' && 'd' in p) ? p.d : p;

  // order read: part id + status
  let partId = null, preStatus = null;
  {
    const r = await fetch(`https://www.alza.cz/api/anonymous/v1/orders/${ORDER}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const o = j(await r.text());
    const part = o && o.parts ? o.parts[0] : null;
    partId = part ? (part.id ?? part.partId) : null;
    preStatus = part ? part.status : (o ? o.status : null);
    steps.push({ step: 'order read (pre-payment)', status: r.status, partId, status: preStatus, keys: o ? Object.keys(o).slice(0, 25) : [] });
  }

  // PA8 read: the after-payment dialog with the real order id + hash
  let dialog = null;
  {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/GetAfterPaymentDialog', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ orderId: ORDER, invoiceId: null, price: null, isPartialPay: false, isSwitchToCashAvailable: false, orderHash: HASH }),
      credentials: 'include',
    });
    const d = unwrap(j(await r.text()));
    const html = (d && d.Value) || '';
    dialog = { status: r.status, errorLevel: d ? d.ErrorLevel : null, methodIds: [...new Set((html.match(/\b(213|216|219|143|144|203|103|234)\b/g) || []))], dialogSnippet: html.slice(0, 200) };
    steps.push({ step: 'G1 GetAfterPaymentDialog (read, real order)', ...dialog });
  }

  // PA9: CreateAfterPayment 144 MojePlatba (the recorded real-payment path)
  {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/CreateAfterPayment', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ orderId: ORDER, paymentId: 144, hash: HASH, enableAD: false, invoiceId: '0', price: null, smsCode: null, smsId: 0, isTrusted: false, amountToPay: null, headerId: null, orderPaymentId: '0' }),
      credentials: 'include',
    });
    const d = unwrap(j(await r.text()));
    steps.push({ step: 'G1 CreateAfterPayment 144 MojePlatba (real order)', status: r.status, errorLevel: d ? d.ErrorLevel : null, message: d ? d.Message : null, value: d && (d.Value ?? d.urlNext ?? d.url_next), raw: JSON.stringify(d).slice(0, 500) });
  }

  // final order state
  {
    const r = await fetch(`https://www.alza.cz/api/anonymous/v1/orders/${ORDER}`, { headers: { Accept: 'application/json' }, credentials: 'include' });
    const o = j(await r.text());
    const part = o && o.parts ? o.parts[0] : null;
    steps.push({ step: 'order read (final)', status: r.status, partId, status: part ? part.status : (o ? o.status : null), price: part ? (part.price ?? part.priceWithVat ?? part.totalPrice) : null });
  }
  return { steps, partId };
}, { ORDER, HASH });
out.steps.push(...res.steps);
out.part_id = res.partId;
const p = '/home/dev/Development/alza-mcp/docs/live-evidence/web-tool-e2e-pay-2026-09-08.json';
fs.writeFileSync(p, JSON.stringify(out, null, 1));
for (const s of res.steps) {
  console.log(`${s.status ?? '-'} ${s.step}`, s.errorLevel !== undefined ? `ErrorLevel=${s.errorLevel}` : '', (s.message || s.status ? '' : ''), JSON.stringify(s.value ?? s.status ?? s.dialogSnippet ?? '').slice(0, 200));
}
await browser.close();
