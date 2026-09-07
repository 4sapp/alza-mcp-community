import { chromium } from 'playwright';
import fs from 'fs';
const tok = JSON.parse(fs.readFileSync(process.env.HOME + '/.alza-mcp/tokens.json'));
const at = tok.access_token;
const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36' });
const page = await ctx.newPage();
await page.goto('https://www.alza.cz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(10000);

const out = { date: '2026-09-08', token_user_id: tok.user_id, steps: [] };
const res = await page.evaluate(async ({ at }) => {
  const steps = [];
  const call = async (name, path, method = 'GET', payload = null, auth = true) => {
    const headers = { 'Accept': 'application/json', 'Accept-Language': 'cs-CZ,cs;q=0.9' };
    if (payload !== null) headers['Content-Type'] = 'application/json; charset=utf-8';
    if (auth) headers['Authorization'] = 'Bearer ' + at;
    let r, body;
    try {
      r = await fetch('https://www.alza.cz' + path, {
        method, headers,
        body: payload !== null ? JSON.stringify(payload) : undefined,
        credentials: 'include',
      });
      const t = await r.text();
      try { body = JSON.parse(t); } catch { body = t.slice(0, 400); }
    } catch (e) {
      steps.push({ step: name, method, path, status: -1, body: String(e).slice(0, 200) });
      return;
    }
    steps.push({ step: name, method, path, status: r.status, body });
  };

  console.log('== Gap A ==');
  await call('A1 basket/add FKP0383232', '/services/restservice.svc/v2/basket/add', 'POST', { code: 'FKP0383232', amount: 1 });
  await call('A2 getDeliveryPaymentGroups v13', '/services/restservice.svc/v13/getDeliveryPaymentGroups');
  await call('A3 getDeliveryPaymentGroups v12', '/services/restservice.svc/v12/getDeliveryPaymentGroups');
  await call('A4 sendOrder2 (AlzaBox 2680/1128203, payment 103)', '/services/restservice.svc/v7/sendOrder2', 'POST', {
    deliveryGroups: [{ deliveryGroupId: 0, deliveryId: 2680, deliveryServicesIds: [], parcelShopId: '1128203', timeFrameId: 0, timeSlotId: 0 }],
    paymentId: 103, paymentCardId: 0, selectedDeliveryOptionId: 2680,
  });
  await call('A5 sendOrder3 full Parameters', '/services/restservice.svc/v5/sendOrder3', 'POST', { parameters: {
    newUserInfo: false,
    billingInfo: { fName: 'E2e Test', fStreet: 'Testova 1', fCity: 'Hradec Kralove', fZip: '50001', fEmail: 'e2e-user@example.invalid', fPhone: '+420601234567' },
    companyInfo: null,
    deliveryAddress: { dName: 'E2e Test', dStreet: 'Testova 1', dCity: 'Hradec Kralove', dZip: '50001', dEmail: 'e2e-user@example.invalid', dPhone: '+420601234567' },
    email: 'e2e-user@example.invalid', note: '', info: '', confirmPwd: false,
    eduId: null, icDph: null, bic: null, iban: null, bankAccountOwnerName: null,
  }});
  await call('A5b sendOrder3 empty Parameters', '/services/restservice.svc/v5/sendOrder3', 'POST', { parameters: {} });

  console.log('== Gap B ==');
  await call('B1 getafterorderpayments 1056808137/1070772578', '/services/restservice.svc/v2/getafterorderpayments/1056808137/1070772578');
  await call('B2 afterOrderPayment (144, Bearer)', '/api/orders/v4/afterOrderPayment', 'POST', { id: 1056808137, invoiceNumber: '1070772578', paymentId: 144 });
  await call('B3 afterOrderPayment (103, no Bearer)', '/api/orders/v4/afterOrderPayment', 'POST', { id: 1056808137, invoiceNumber: '1070772578', paymentId: 103 }, false);
  return steps;
}, { at });
out.steps = res;
fs.writeFileSync('/tmp/gap-recheck.json', JSON.stringify(out, null, 1));
for (const s of res) {
  const b = typeof s.body === 'string' ? s.body.slice(0, 130) : JSON.stringify(s.body).slice(0, 130);
  console.log(`${s.status} ${s.step.padEnd(42)} ${b.replace(/\n/g, ' ')}`);
}
await browser.close();
