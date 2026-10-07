import { afterEach, describe, expect, it } from "vitest";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { MobileApi } from "../src/infra/mobile-api.js";
import { AppActionExecutor, isSensitiveFieldName } from "../src/infra/app-action.js";

/**
 * Issues #61 and #62: each typed AppAction tool may only call its own route
 * family (and method), the executor never calls GET-shaped writes or
 * credential/payment/order routes, and camelCase sensitive field names are
 * blocked. Fetch is mocked; nothing here touches the network.
 */
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

function countingFetch(): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response(JSON.stringify({ err: 0 }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls };
}

const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: "https://test.alza.invalid" }));
const act = (href: string, method = "POST", values: Array<{ name: string; value: unknown }> = [], rel: string[] = ["form"]) =>
  ({ form: { meta: { href, method, rel }, values } });
const jpeg = { part_name: "attachments", file_name: "a.jpg", mime_type: "image/jpeg", data_url: "data:image/jpeg;base64," + Buffer.from("hello").toString("base64") };

describe("a token for one AppAction tool cannot drive other routes (#61)", () => {
  it("review_submit refuses the password route even with a valid review_submit token", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("review_submit").confirmationToken;
    await expect(account.reviewSubmit(act("/api/users/999/v2/account/password", "POST", [{ name: "oldPassword", value: "x" }, { name: "password1", value: "n" }]), { rating: 5 }, t)).rejects.toThrow(/blocked|outside the review family|Sensitive/);
    const t2 = account.prepareMutation("review_submit").confirmationToken;
    await expect(account.reviewSubmit(act("/api/users/999/v1/addresses/delete"), { rating: 5 }, t2)).rejects.toThrow(/outside the review family/);
    expect(calls).toHaveLength(0);
  });

  it("address_delete refuses the after-order payment route and payment fields", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const t = account.prepareMutation("address_delete").confirmationToken;
    await expect(account.addressDelete(act("/api/orders/v4/afterOrderPayment", "POST", [{ name: "paymentId", value: 1 }, { name: "cardId", value: 2 }]), { address_id: 4 }, t)).rejects.toThrow(/blocked/);
    expect(calls).toHaveLength(0);
  });

  it("every typed writer is bound to its own family and to POST", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const offFamily = "/api/users/1/v1/orders/search/results";
    const addr = { name: "J", street: "A 1", city: "Praha", zip_code: "11000" };
    await expect(account.addressUpsert("create", act(offFamily), addr, account.prepareMutation("address_create").confirmationToken)).rejects.toThrow(/outside the address family/);
    await expect(account.addressUpsert("edit", act(offFamily), addr, account.prepareMutation("address_edit").confirmationToken)).rejects.toThrow(/outside the address family/);
    await expect(account.addressDelete(act(offFamily), { address_id: 1 }, account.prepareMutation("address_delete").confirmationToken)).rejects.toThrow(/outside the address family/);
    await expect(account.subscriptionActivate(act(offFamily), {}, account.prepareMutation("subscription_activate").confirmationToken)).rejects.toThrow(/outside the subscription family/);
    await expect(account.subscriptionUpdateInstallment(act(offFamily), {}, account.prepareMutation("subscription_update_installment").confirmationToken)).rejects.toThrow(/outside the subscription family/);
    await expect(account.uploadAttachment(act(offFamily, "POST", [], ["multipart"]), { files: [jpeg] }, account.prepareMutation("attachment_upload").confirmationToken)).rejects.toThrow(/outside the attachment family/);
    // In-family href but a GET: writers are POST-only.
    await expect(account.addressDelete(act("/api/users/1/addresses/4", "GET"), { address_id: 4 }, account.prepareMutation("address_delete").confirmationToken)).rejects.toThrow(/method GET is not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("in-family actions still execute", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    await account.reviewSubmit(act("/services/restservice.svc/v1/writeReview"), { rating: 5 }, account.prepareMutation("review_submit").confirmationToken);
    await account.addressDelete(act("/api/users/1/addresses/4/delete"), { address_id: 4 }, account.prepareMutation("address_delete").confirmationToken);
    await account.subscriptionActivate(act("/api/users/1/v1/subscription/activate"), {}, account.prepareMutation("subscription_activate").confirmationToken);
    await account.uploadAttachment(act("/api/complaints/1/attachments", "POST", [], ["multipart"]), { files: [jpeg] }, account.prepareMutation("attachment_upload").confirmationToken);
    expect(calls).toHaveLength(4);
  });

  it("blocks camelCase sensitive field names, including server-provided ones", async () => {
    for (const name of ["oldPassword", "password1", "paymentId", "cardId", "refreshToken", "ibanNumber", "accessToken", "clientSecret", "CVC", "swiftBic", "card_id", "access_token", "Authorization"]) {
      expect(isSensitiveFieldName(name), name).toBe(true);
    }
    for (const name of ["rating", "text", "visitorId", "userId", "zipCode", "isPublic", "addressType", "installmentCount", "search"]) {
      expect(isSensitiveFieldName(name), name).toBe(false);
    }
    const { calls } = countingFetch();
    const account = makeAccount();
    await expect(account.reviewSubmit(act("/services/restservice.svc/v1/writeReview", "POST", [{ name: "paymentId", value: 1 }]), { rating: 5 }, account.prepareMutation("review_submit").confirmationToken)).rejects.toThrow(/Sensitive AppAction field is blocked: paymentId/);
    await expect(account.reviewSubmit(act("/services/restservice.svc/v1/writeReview"), { rating: 5, values: [{ name: "newPassword", value: "x" }] }, account.prepareMutation("review_submit").confirmationToken)).rejects.toThrow(/Sensitive AppAction field is blocked: newPassword/);
    expect(calls).toHaveLength(0);
  });
});

describe("read-only AppAction tools only fetch their own read routes (#62)", () => {
  it("claim_detail refuses the GET-shaped coupon write", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    await expect(account.claimDetail(act("/services/restservice.svc/v1/addcoupon/FREE", "GET"))).rejects.toThrow(/blocked/);
    expect(calls).toHaveLength(0);
  });

  it("refuses every known GET mutation route on every reader, even with in-family keywords", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const getWrites = [
      "/services/restservice.svc/v1/addcoupon/FREE",
      "/services/restservice.svc/v1/delcoupon/1",
      "/services/restservice.svc/v2/updBasket/5/1",
      "/services/restservice.svc/v1/unlockbasket",
      "/services/restservice.svc/v1/addOrderService/1/1/1",
      "/services/restservice.svc/v1/rateCommodityDiscussionPosts",
      "/services/restservice.svc/v1/approveOrder4",
      "/services/restservice.svc/v4/sendOrder1",
      "/services/restservice.svc/v1/%61ddcoupon/FREE",
      "/api/claims/../../services/restservice.svc/v1/unlockbasket",
    ];
    for (const href of getWrites) {
      await expect(account.claimDetail(act(href, "GET")), href).rejects.toThrow(/blocked|outside the warranty claim/);
      await expect(account.complaintClaims(act(href, "GET")), href).rejects.toThrow(/blocked|outside the warranty claim/);
      await expect(account.subscriptionOverview(act(href, "GET")), href).rejects.toThrow(/blocked|outside the subscription/);
      await expect(account.addressSearch(act(href, "GET"), "110"), href).rejects.toThrow(/blocked|outside the address/);
    }
    expect(calls).toHaveLength(0);
  });

  it("readers refuse off-family read routes and non-GET methods", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    await expect(account.claimDetail(act("/api/users/1/v1/orders/archive", "GET"))).rejects.toThrow(/outside the warranty claim/);
    await expect(account.subscriptionOverview(act("/api/users/1/v1/warrantyClaims", "GET"))).rejects.toThrow(/outside the subscription/);
    await expect(account.complaintClaims(act("/api/users/1/v1/subscription", "GET"))).rejects.toThrow(/outside the warranty claim/);
    await expect(account.addressSearch(act("/api/users/1/v1/subscription", "GET"), "110")).rejects.toThrow(/outside the address/);
    await expect(account.claimDetail(act("/api/v1/complaints/claims/9/detail", "POST"))).rejects.toThrow(/method POST is not allowed/);
    expect(calls).toHaveLength(0);
  });

  it("readers still execute their own read routes", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    await account.claimDetail(act("/api/v1/complaints/claims/9/detail", "GET"));
    await account.complaintClaims(act("/api/users/1/v1/warrantyClaims/active", "GET"));
    await account.subscriptionOverview(act("/api/users/1/v1/subscription", "GET"));
    await account.addressSearch(act("/api/users/1/addresses/search", "GET"), "110");
    expect(calls).toHaveLength(4);
  });

  it("applies the route policy to redirect targets as well", async () => {
    const seen: string[] = [];
    const executor = new AppActionExecutor({
      baseUrl: "https://test.alza.invalid",
      visitorId: "v",
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response("", { status: 302, headers: { location: "/services/restservice.svc/v1/unlockbasket" } });
      },
    });
    await expect(executor.execute(act("/api/v1/complaints/claims/9/detail", "GET"), { routePolicy: { family: "claim", pathPatterns: [/claim/], methods: ["GET"] } })).rejects.toThrow(/blocked/);
    expect(seen).toHaveLength(1);
  });
});

describe("route checks cannot be sidestepped by path forms a server may route differently (#61/#62)", () => {
  it("refuses ;path parameters, encoded slashes, control characters and trailing dots/spaces", async () => {
    const { calls } = countingFetch();
    const account = makeAccount();
    const writes = [
      "/api/users/999/v2/account/password;review",
      "/api/orders/v4/afterOrderPayment;rating=1",
      "/api/users/999/v1/account;review",
      "/api/users/999/v2/account/password./review",
      "/api/orders/v4/afterOrderPayment%20/review",
      "/api/orders/v4/afterOrderPayment%00review",
      "/api/review%2F..%2F..%2Forders/v4/afterOrderPayment",
    ];
    for (const href of writes) {
      await expect(account.reviewSubmit(act(href), { rating: 5 }, account.prepareMutation("review_submit").confirmationToken), href).rejects.toThrow(/refused|blocked/);
    }
    const reads = [
      "/services/restservice.svc/v1/unlockbasket;claim",
      "/services/restservice.svc/v1/addcoupon;claim=1/FREE",
      "/services/restservice.svc/v1/addcoupon./claim",
    ];
    for (const href of reads) {
      await expect(account.claimDetail(act(href, "GET")), href).rejects.toThrow(/refused|blocked/);
    }
    expect(calls).toHaveLength(0);
  });
});
