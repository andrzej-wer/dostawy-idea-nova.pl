// Network permission is deliberately NOT granted when running these tests.
// All fetches are intercepted and all addresses/credentials below are synthetic.
Deno.env.set("SUPABASE_URL", "https://test.invalid");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "synthetic-service-key");
const { handler } = await import("./index.ts");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const address = "ul. Testowa 12, 00-001 Testowo";
const provider = { results: [{ city: "Testowo", street: "Testowa", number: "12", code: "00-001", x: "644234.2904", y: "499514.0342" }] };

async function scenario(options: { cached?: boolean; limited?: boolean; unknown?: boolean; upstreamFailure?: boolean; origin?: string; apartmentNumber?: string; exactCompound?: boolean }) {
  const originalFetch = globalThis.fetch;
  const calls: { path: string; method: string; payload?: unknown; at: number; query: string | null }[] = [];
  const requestAddress = options.apartmentNumber ? "ul. Testowa " + options.apartmentNumber + ", 00-001 Testowo" : address;
  let cachedResult: Record<string, unknown> | null = options.cached ? {
    address_key: address.toLowerCase(), address, lat: 52.3, lng: 21.1, status: "resolved", source: "gugik-uug", updated_at: "2026-11-12T00:00:00Z",
  } : null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method || "GET";
    const payload = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: url.pathname, method, payload, at: Date.now(), query: url.searchParams.get("address") });
    let data: unknown;
    if (url.hostname === "services.gugik.gov.pl") {
      assert(!url.searchParams.get("address")?.includes("00-001"), "only address components needed for UUG are sent");
      if (options.upstreamFailure) return new Response("temporarily unavailable", { status: 503 });
      if (options.apartmentNumber) {
        const full = options.apartmentNumber.replace(/\s+/g, "");
        const building = full.slice(0, full.lastIndexOf("/"));
        const attempt = calls.filter((call) => call.path === "/uug/").length;
        data = attempt === 1 && !options.exactCompound ? { results: [] } : { results: [{ ...provider.results[0], number: options.exactCompound ? full : building }] };
      } else data = provider;
    } else if (url.pathname.endsWith("/clients_db")) data = [{ data: [{ addr: requestAddress, city: "Testowo" }] }];
    else if (url.pathname.endsWith("/delivery_plans")) data = [];
    else if (url.pathname.endsWith("/claim_delivery_geocode_slot")) data = [{ granted: !options.limited, retry_after_ms: 1100 }];
    else if (url.pathname.endsWith("/finish_delivery_geocode_slot")) data = null;
    else if (url.pathname.endsWith("/delivery_address_locations") && method === "GET") data = cachedResult ? [cachedResult] : [];
    else if (url.pathname.endsWith("/delivery_address_locations") && method === "POST") { cachedResult = payload; data = [payload]; }
    else throw new Error("Unexpected mock path: " + url.pathname);
    return Response.json(data);
  };
  try {
    const result = await handler(new Request("https://function.invalid", {
      method: "POST",
      headers: { Origin: options.origin || "https://dostawy.idea-nova.pl", Authorization: "Bearer synthetic-anon-jwt", "Content-Type": "application/json" },
      body: JSON.stringify({ address: options.unknown ? "Nieistniejący adres 123, Inne Miasto" : requestAddress }),
    }));
    return { status: result.status, data: await result.json(), calls };
  } finally { globalThis.fetch = originalFetch; }
}

Deno.test("cache hits skip both upstream and the global limiter", async () => {
  const out = await scenario({ cached: true });
  assert(out.status === 200 && out.data.cached === true, "cached success");
  assert(!out.calls.some((call) => call.path.endsWith("claim_delivery_geocode_slot") || call.path === "/uug/"), "no upstream slot or request");
});

Deno.test("uncached saved address is resolved, cached and the global lease is released", async () => {
  const out = await scenario({});
  assert(out.status === 200 && out.data.status === "resolved" && out.data.cached === false, "resolved");
  assert(out.calls.filter((call) => call.path === "/uug/").length === 1, "one upstream request");
  assert(out.calls.some((call) => call.path.endsWith("delivery_address_locations") && call.method === "POST"), "persist result");
  assert(out.calls.at(-1)?.path.endsWith("finish_delivery_geocode_slot"), "lease release");
});

Deno.test("busy limiter returns retry delay without upstream or cache writes", async () => {
  const out = await scenario({ limited: true });
  assert(out.status === 429 && out.data.retry_after_ms >= 1100, "retry response");
  assert(!out.calls.some((call) => call.path === "/uug/"), "no upstream");
  assert(!out.calls.some((call) => call.path.endsWith("delivery_address_locations") && call.method === "POST"), "no cache write");
});

Deno.test("unsaved arbitrary addresses and unapproved origins are rejected", async () => {
  const unknown = await scenario({ unknown: true });
  assert(unknown.status === 400 && unknown.data.error === "address_not_saved", "saved-address allowlist");
  assert(!unknown.calls.some((call) => call.path === "/uug/"), "no arbitrary geocoding");
  const origin = await scenario({ origin: "https://unapproved.invalid" });
  assert(origin.status === 403 && origin.calls.length === 0, "reject origin before database");
});

Deno.test("provider failure backs off and never becomes a cached no-result", async () => {
  const out = await scenario({ upstreamFailure: true });
  assert(out.status === 503 && out.data.retry_after_ms === 60000, "temporary failure");
  assert(!out.calls.some((call) => call.path.endsWith("delivery_address_locations") && call.method === "POST"), "no negative cache for outage");
  const release = out.calls.find((call) => call.path.endsWith("finish_delivery_geocode_slot"));
  assert((release?.payload as { p_backoff_ms?: number })?.p_backoff_ms === 60000, "global backoff");
});

Deno.test("apartment fallback keeps global spacing and caches building precision under the complete address", async () => {
  const out = await scenario({ apartmentNumber: "46 /50/135" });
  assert(out.status === 200 && out.data.status === "resolved" && out.data.precision === "building", "building response");
  assert(out.data.address_key.includes("46 /50/135"), "original key retained");
  const requests = out.calls.filter((call) => call.path === "/uug/");
  assert(requests.length === 2 && requests[1].query?.endsWith("46/50"), "one safe fallback");
  assert(requests[1].at - requests[0].at >= 1095, "global minimum spacing survives second request");
  const release = out.calls.find((call) => call.path.endsWith("finish_delivery_geocode_slot"));
  assert((release?.payload as { p_backoff_ms?: number })?.p_backoff_ms === 1100, "next worker also waits after second request");
});

Deno.test("an exact compound building number never triggers apartment fallback", async () => {
  const out = await scenario({ apartmentNumber: "12/9", exactCompound: true });
  assert(out.status === 200 && out.data.precision === "address", "full address precision");
  assert(out.calls.filter((call) => call.path === "/uug/").length === 1, "no second lookup");
});
