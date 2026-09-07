import { chromium } from 'playwright';
import fs from 'fs';
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);
const out = { date: '2026-09-08', steps: [] };
const res = await page.evaluate(async () => {
  const steps = [];
  const j = (o) => { try { return JSON.parse(o); } catch { return o.slice(0, 300); } };
  const wcf = async (name, op, body) => {
    const r = await fetch('https://www.alza.cz/Services/EShopService.svc/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      credentials: 'include',
    });
    const t = await r.text();
    const p = j(t);
    steps.push({ step: name, status: r.status, errorLevel: p && p.d ? p.d.ErrorLevel : (p ? p.ErrorLevel : null),
      message: p && p.d ? (p.d.Message || null) : (p ? p.Message : null),
      alzaPlusAction: p && p.d ? (p.d.alzaPlusPopupDialogAction ? 'ISSUED' : null) : (p ? (p.alzaPlusPopupDialogAction ? 'ISSUED' : null) : null),
      body: t.slice(0, 500) });
    return p;
  };
  const rest = async (name, path, method = 'GET', payload = null) => {
    const r = await fetch('https://www.alza.cz' + path, {
      method,
      headers: payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {},
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: 'include',
    });
    const t = await r.text();
    steps.push({ step: name, status: r.status, body: t.slice(0, 300) });
    return j(t);
  };

  await rest('C1 basket/add FKP0383232 (guest)', '/services/restservice.svc/v2/basket/add', 'POST', { code: 'FKP0383232', amount: 1 });
  const gp = await rest('C2 getDeliveryPaymentGroups v12', '/services/restservice.svc/v12/getDeliveryPaymentGroups');
  let gid = null;
  if (gp && Array.isArray(gp.deliveryGroups)) {
    for (const g of gp.deliveryGroups) {
      if ((g.deliveries || []).some(d => d.deliveryId === 2680)) { gid = g.deliveryGroupId; break; }
    }
  }
  steps.push({ step: 'C2b live deliveryGroupId for 2680', gid });
  const save2 = {
    selectedDeliveriesForGroups: [{ deliveryGroupId: gid, deliveryId: 2680, parcelShopId: '1128203', deliveryAccesoriesIds: [] }],
    paymentId: 103, paymentCardId: 0, alzaPlusSubscriptionId: 0, cetelemLeasingId: 0,
  };
  await wcf('C3 SaveOrder2', 'SaveOrder2', save2);
  await wcf('C4 SaveOrder3 (guest user info)', 'SaveOrder3', {
    registerUser: false, login: 'e2e-user@example.invalid', name: 'E2E Test',
    street: 'Example Street 2', city: 'Hradec Králové', zip: '50004',
    phone: '+420601234567', email: 'e2e-user@example.invalid', countryId: 0,
  });
  await wcf('C5 SaveAndConfirmOrder2 — FIRST attempt (expect 113 gate)', 'SaveAndConfirmOrder2', save2);
  await new Promise(r => setTimeout(r, 2000));
  await wcf('C6 SaveAndConfirmOrder2 — retry (expect 0)', 'SaveAndConfirmOrder2', save2);
  return steps;
});
out.steps = res;
fs.writeFileSync('/tmp/gate113-recheck.json', JSON.stringify(out, null, 1));
for (const s of res) {
  if (s.gid !== undefined) { console.log(`${s.step}: gid=${s.gid}`); continue; }
  console.log(`${s.status} ${s.step.padEnd(52)} ErrorLevel=${s.errorLevel} msg=${(s.message || '').slice(0, 60)} alzaPlus=${s.alzaPlusAction || '-'}`);
}
await browser.close();
