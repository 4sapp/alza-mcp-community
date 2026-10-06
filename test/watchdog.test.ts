import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileApi } from "../src/infra/mobile-api.js";
import { MobileAccount } from "../src/domain/mobile-account.js";
import { parseWatchdogDialog, parseWatchdogList, watchdogIdFromHref } from "../src/domain/watchdog.js";

// Keep unit tests deterministic: never auto-load a real stored OAuth token.
process.env.ALZA_TOKEN_FILE = "none";

type Seen = { url: string; method: string; body: string | null };

function withFetch(handler: (req: Seen) => Response, seen: Seen[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), method: init?.method ?? "GET", body: init?.body == null ? null : String(init.body) };
    seen.push(req);
    return handler(req);
  }) as typeof fetch;
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const empty = (status = 204) => new Response(null, { status });

const BASE = "https://test.alza.invalid";
const UID = "100000001";
const CID = 12999617;
const WID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const EMAIL = "user@example.invalid";
const makeAccount = () => new MobileAccount(new MobileApi({ visitorId: "visitor-test", baseUrl: BASE }));

// Shapes mirror the live 2026-10-06 responses (docs/live-evidence/watchdog-b9-2026-10-06.md), redacted.
const dialogEmpty = {
  title: "Nastavit hlídaní",
  form: {
    method: "POST",
    value: [
      { name: "commodityId", value: CID, itemType: "integer", isHidden: true },
      { name: "email", value: EMAIL, itemType: "string", semanticItemType: "email" },
      { name: "isTrackingStock", value: true, itemType: "boolean" },
      { name: "price", value: 19, itemType: "decimal", max: 19, min: 0 },
      { name: "submitButton", itemType: "submitButton" },
    ],
    href: `https://webapi.alza.cz/api/watchdog/v1?country=CZ&commodityClientId=${UID}`,
  },
  deleteAction: null,
};
const dialogExisting = {
  ...dialogEmpty,
  deleteAction: {
    appLink: "removeProductAvailabilityWatchdog",
    form: { method: "DELETE", value: null, rel: ["form"], href: `https://webapi.alza.cz/api/watchdog/v1/${WID}?country=CZ&commodityClientId=${UID}` },
    enabled: true,
  },
};
const listOne = {
  emptyInfo: null,
  paging: { limit: 20, size: 1, next: null },
  value: [
    {
      commodityName: "Tužka CENTROPEN 9511",
      commodityUrl: `https://www.alza.cz/centropen-9511-d${CID}.htm`,
      commodityDetail: { href: `https://www.alza.cz/api/router/legacy/catalog/product/${CID}?country=CZ`, appLink: "catalogProductDetail" },
      priceInfoV2: { priceNoCurrency: 19 },
      availabilityText: "Skladem > 50 ks",
      updateForm: {
        method: "PATCH",
        value: [
          { name: "isTrackingStock", value: true, itemType: "boolean" },
          { name: "price", value: 15, itemType: "decimal", max: 19 },
        ],
        rel: ["edit-form"],
        href: `https://webapi.alza.cz/api/watchdog/v1/${WID}?country=CZ`,
      },
      deleteAction: { href: `https://www.alza.cz/api/anonymous/v1/watchDogs/${WID}/deleteForm?country=CZ`, appLink: "watchDogDeleteForm" },
    },
  ],
};

describe("watchdog parsing (B9, B9a, B9b)", () => {
  it("extracts the watchdog id from update/delete hrefs", () => {
    expect(watchdogIdFromHref(`https://webapi.alza.cz/api/watchdog/v1/${WID}?country=CZ`)).toBe(WID);
    expect(watchdogIdFromHref(`https://www.alza.cz/api/anonymous/v1/watchDogs/${WID}/deleteForm`)).toBe(WID);
    expect(watchdogIdFromHref("https://webapi.alza.cz/api/watchdog/v1?country=CZ")).toBeNull();
  });

  it("reads the dialog state without leaking anything but the fields it needs", () => {
    expect(parseWatchdogDialog(dialogEmpty)).toEqual({ existingWatchdogId: null, email: EMAIL, priceMax: 19 });
    expect(parseWatchdogDialog(dialogExisting).existingWatchdogId).toBe(WID);
  });

  it("normalises the list (no email in the output)", () => {
    const parsed = parseWatchdogList(listOne);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.items).toEqual([
      { watchdog_id: WID, commodity_id: CID, name: "Tužka CENTROPEN 9511", url: `https://www.alza.cz/centropen-9511-d${CID}.htm`, current_price: 19, availability: "Skladem > 50 ks", is_tracking_stock: true, max_price: 15 },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("@");
    expect(parseWatchdogList({ emptyInfo: { message: "nic" }, paging: { next: null }, value: [] })).toEqual({ items: [], hasMore: false, emptyMessage: "nic" });
  });
});

describe("watchdog tools (domain)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("watchdog_list hits the user watchDogs/commodities route", async () => {
    const seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch(() => json(listOne), seen));
    const out = await makeAccount().watchdogList(UID, 5);
    expect(seen[0]?.url).toBe(`${BASE}/api/users/${UID}/v1/watchDogs/commodities?country=CZ&limit=5`);
    expect(out.count).toBe(1);
    await expect(makeAccount().watchdogList("abc")).rejects.toThrow(/user_id/);
    await expect(makeAccount().watchdogList(UID, 0)).rejects.toThrow(/limit/);
  });

  it("watchdog_set: token guard, validation, then dialog → webapi POST with the pre-filled email (never echoed)", async () => {
    const account = makeAccount();
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID }, "nope")).rejects.toThrow(/watchdog_set confirmation token/);
    let t = account.prepareMutation("watchdog_set");
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID, track_stock: false }, t.confirmationToken)).rejects.toThrow(/nothing to watch/);
    t = account.prepareMutation("watchdog_set");
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID, max_price: -1 }, t.confirmationToken)).rejects.toThrow(/max_price/);

    // threshold must be below the current price (form max)
    vi.stubGlobal("fetch", withFetch(() => json(dialogEmpty), []));
    t = account.prepareMutation("watchdog_set");
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID, max_price: 19 }, t.confirmationToken)).rejects.toThrow(/below the current price \(19 Kč\)/);

    // existing watchdog → refuse
    vi.stubGlobal("fetch", withFetch(() => json(dialogExisting), []));
    t = account.prepareMutation("watchdog_set");
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID, max_price: 15 }, t.confirmationToken)).rejects.toThrow(/already exists.*watchdog_delete/);

    // happy path
    const seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch((req) => {
      if (req.method === "GET") return json(dialogEmpty);
      return json({ watchdogId: WID, commodityId: CID, email: EMAIL, isTrackingStock: true, price: 15, created: "2026-10-06T21:39:37Z" });
    }, seen));
    t = account.prepareMutation("watchdog_set");
    const out = await account.watchdogSet({ user_id: UID, commodity_id: CID, max_price: 15 }, t.confirmationToken);
    expect(seen[0]?.url).toBe(`${BASE}/api/v1/users/${UID}/products/${CID}/watchdogDialog?country=CZ`);
    expect(seen[1]?.url).toBe(`https://webapi.alza.cz/api/watchdog/v1?country=CZ&commodityClientId=${UID}`);
    expect(seen[1]?.method).toBe("POST");
    expect(JSON.parse(seen[1]?.body as string)).toEqual({ commodityId: CID, email: EMAIL, isTrackingStock: true, price: 15 });
    expect(out).toMatchObject({ created: true, watchdog_id: WID, commodity_id: CID, is_tracking_stock: true, max_price: 15 });
    expect(JSON.stringify(out)).not.toContain(EMAIL);
    // single-use token
    await expect(account.watchdogSet({ user_id: UID, commodity_id: CID, max_price: 15 }, t.confirmationToken)).rejects.toThrow(/confirmation token/);
  });

  it("watchdog_set without max_price sends price null (stock-only watch, like the web client)", async () => {
    const account = makeAccount();
    const seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch((req) => (req.method === "GET" ? json(dialogEmpty) : json({ watchdogId: WID, isTrackingStock: true, price: null })), seen));
    const t = account.prepareMutation("watchdog_set");
    const out = await account.watchdogSet({ user_id: UID, commodity_id: CID }, t.confirmationToken);
    expect(JSON.parse(seen[1]?.body as string)).toEqual({ commodityId: CID, email: EMAIL, isTrackingStock: true, price: null });
    expect(out.max_price).toBeNull();
  });

  it("watchdog_delete by commodity resolves the dialog deleteAction, by id deletes directly", async () => {
    const account = makeAccount();
    await expect(account.watchdogDelete({ user_id: UID, watchdog_id: WID }, "nope")).rejects.toThrow(/watchdog_delete confirmation token/);

    let seen: Seen[] = [];
    vi.stubGlobal("fetch", withFetch((req) => (req.method === "GET" ? json(dialogExisting) : empty()), seen));
    let t = account.prepareMutation("watchdog_delete");
    let out = await account.watchdogDelete({ user_id: UID, commodity_id: CID }, t.confirmationToken);
    expect(seen[1]).toMatchObject({ method: "DELETE", url: `https://webapi.alza.cz/api/watchdog/v1/${WID}?country=CZ&commodityClientId=${UID}` });
    expect(out).toEqual({ deleted: true, watchdog_id: WID, commodity_id: CID });

    seen = [];
    vi.stubGlobal("fetch", withFetch(() => empty(), seen));
    t = account.prepareMutation("watchdog_delete");
    out = await account.watchdogDelete({ user_id: UID, watchdog_id: WID.toUpperCase() }, t.confirmationToken);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("DELETE");
    expect(out.watchdog_id).toBe(WID);

    // nothing to delete
    vi.stubGlobal("fetch", withFetch(() => json(dialogEmpty), []));
    t = account.prepareMutation("watchdog_delete");
    await expect(account.watchdogDelete({ user_id: UID, commodity_id: CID }, t.confirmationToken)).rejects.toThrow(/no watchdog is set/);
    t = account.prepareMutation("watchdog_delete");
    await expect(account.watchdogDelete({ user_id: UID, watchdog_id: "not-a-uuid" }, t.confirmationToken)).rejects.toThrow(/UUID/);
  });
});
