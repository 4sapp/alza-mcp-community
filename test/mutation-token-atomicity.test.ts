import { afterEach, describe, expect, it } from "vitest";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";

/**
 * Issue #56: a prepare_mutation / checkout_preview token must be consumed
 * synchronously by the first call that presents it, so N concurrent tool calls
 * carrying the same token send at most one upstream request. The transport is
 * a counting fetch mock; nothing here touches the network.
 */
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

function countingFetch(body: unknown = { err: 0, ErrorLevel: 0 }): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    // Yield so concurrent callers interleave the way the SDK's parallel dispatch does.
    await new Promise((r) => setTimeout(r, 5));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));
const payPayload = { order_id: "O1", invoice_number: "I1", payment_id: 7 };

describe("confirmation tokens are consumed atomically (#56)", () => {
  it("lets only one of three concurrent pay_after_order calls with the same token run", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("after_order_payment").confirmationToken;
    const results = await Promise.allSettled([
      account.payAfterOrder(payPayload, t),
      account.payAfterOrder({ ...payPayload, order_id: "O2" }, t),
      account.payAfterOrder(payPayload, t),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results.filter((x) => x.status === "rejected")) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/Invalid or expired after_order_payment confirmation token/);
    }
    expect(calls.filter((c) => c.includes("/afterOrderPayment"))).toHaveLength(1);
  });

  it("lets only one of two concurrent web_place_order calls with the same token reach SendOrder4", async () => {
    const { calls } = countingFetch({ d: { ErrorLevel: 0 } });
    const account = makeAccount();
    const t = account.prepareMutation("web_place_order").confirmationToken;
    const wp = { delivery_id: 1, payment_id: 2, name: "Test User", street: "Street 1", city: "City", zip_code: "11000", phone: "+420000000000", email: "user@example.test" };
    const results = await Promise.allSettled([account.webPlaceOrder(wp, t), account.webPlaceOrder(wp, t)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/SendOrder4"))).toHaveLength(1);
  });

  it("lets only one of two concurrent mutate_list calls with the same token run", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("coupon_add").confirmationToken;
    const results = await Promise.allSettled([
      account.mutateList("coupon_add", t, { coupon: "A" }),
      account.mutateList("coupon_add", t, { coupon: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/addcoupon/"))).toHaveLength(1);
  });

  it("still runs gdpr_export through mutate_list exactly once with one token", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("gdpr_export").confirmationToken;
    const results = await Promise.allSettled([
      account.mutateList("gdpr_export", t, { user_id: "100000001" }),
      account.mutateList("gdpr_export", t, { user_id: "100000001" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/gdprInformation"))).toHaveLength(1);
  });

  it("lets only one of two concurrent place_order calls with the checkout_preview token run", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const preview = await account.previewOrder();
    calls.length = 0;
    const results = await Promise.allSettled([
      account.submitOrder(preview.confirmationToken, {}, {}, {}),
      account.submitOrder(preview.confirmationToken, {}, {}, {}),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/sendOrder2"))).toHaveLength(1);
    expect(calls.filter((c) => c.includes("/orderfinished"))).toHaveLength(1);
  });

  it("consumes the token on a failed attempt too, so a retry needs a fresh prepare_mutation", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const account = makeAccount();
    const t = account.prepareMutation("after_order_payment").confirmationToken;
    await expect(account.payAfterOrder(payPayload, t)).rejects.toThrow(/HTTP 500/);
    await expect(account.payAfterOrder(payPayload, t)).rejects.toThrow(/Invalid or expired after_order_payment confirmation token/);
  });

  it("does not consume a pending token presented for a different action", async () => {
    countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("after_order_payment").confirmationToken;
    await expect(account.cancelOrder("O1", "h", "p", 0, t)).rejects.toThrow(/Invalid or expired cancel_order/);
    await expect(account.payAfterOrder(payPayload, t)).resolves.toBeDefined();
  });
});
