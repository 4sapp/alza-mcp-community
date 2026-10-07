import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("undici", () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }));

const { Pickup, normalizePostalCode } = await import("../src/domain/pickup.js");
const { resolveLocale } = await import("../src/infra/locale.js");
const { createFindPickupPointsTool } = await import("../src/tools/find-pickup-points.js");

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/sales-network-places.json", import.meta.url), "utf8")) as unknown;
const cz = resolveLocale("https://www.alza.cz");
const HK = { lat: 50.2092, lng: 15.8328 };

describe("find_pickup_points input handling (#78)", () => {
  beforeEach(() => fetchMock.mockReset());

  it("normalises and validates postal codes", () => {
    expect(normalizePostalCode("110 00")).toBe("11000");
    expect(normalizePostalCode(" 11000 ")).toBe("11000");
    for (const bad of ["", "   ", "1100", "abc12", "110  00", "110 000"]) {
      expect(() => normalizePostalCode(bad)).toThrow(/postal_code must be/);
    }
  });

  it("rejects a blank postal code before geocoding (no arbitrary lockers)", async () => {
    const geocode = vi.fn(async () => HK);
    const pickup = new Pickup(cz, { getJson: async () => FIXTURE, geocode });
    await expect(pickup.findPickupPoints({ postalCode: "   " })).rejects.toThrow(/postal_code must be/);
    expect(geocode).not.toHaveBeenCalled();
  });

  it("treats types: [] like an omitted list (both types), not as 'nothing'", async () => {
    const pickup = new Pickup(cz, { getJson: async () => FIXTURE, geocode: async () => HK });
    const none = await pickup.findPickupPoints({ postalCode: "500 02", types: [] });
    const dflt = await new Pickup(cz, { getJson: async () => FIXTURE, geocode: async () => HK }).findPickupPoints({ postalCode: "500 02" });
    expect(none.points.length).toBeGreaterThan(0);
    expect(none.points.map((p) => p.id)).toEqual(dflt.points.map((p) => p.id));
  });

  it("hands the geocoder the normalised code", async () => {
    const geocode = vi.fn(async () => HK);
    await new Pickup(cz, { getJson: async () => FIXTURE, geocode }).findPickupPoints({ postalCode: "500 02", types: ["alzabox"] });
    expect(geocode).toHaveBeenCalledWith("50002");
  });

  it("'110 00' and '11000' share one Nominatim request", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => [{ lat: "50.08", lon: "14.43" }] });
    const pickup = new Pickup(cz, { getJson: async () => FIXTURE });
    await pickup.findPickupPoints({ postalCode: "110 00", types: ["alzabox"] });
    await pickup.findPickupPoints({ postalCode: "11000", types: ["alzabox"] });
    const nominatim = fetchMock.mock.calls.filter((c) => String(c[0]).includes("nominatim.openstreetmap.org"));
    expect(nominatim).toHaveLength(1);
    expect(String(nominatim[0]![0])).toContain("postalcode=11000");
  });

  it("the tool schema rejects blank and malformed codes and an empty types list, and discloses the geocoder", () => {
    type Field = { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
    let schema: Record<string, Field> = {};
    let description = "";
    const server = {
      registerTool: (_n: string, cfg: { inputSchema: typeof schema; description: string }) => {
        schema = cfg.inputSchema;
        description = cfg.description;
        return {};
      },
    };
    createFindPickupPointsTool({} as never).register(server as never, (async () => ({})) as never);
    expect(schema.postal_code!.safeParse("   ").success).toBe(false);
    expect(schema.postal_code!.safeParse("abc").success).toBe(false);
    expect(schema.postal_code!.safeParse("110 00").success).toBe(true);
    expect(schema.postal_code!.safeParse(" 11000 ").data).toBe("11000");
    expect(schema.types!.safeParse([]).success).toBe(false);
    expect(schema.types!.safeParse(["alzabox"]).success).toBe(true);
    expect(description).toMatch(/nominatim\.openstreetmap\.org/);
  });
});
