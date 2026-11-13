import { addressKey, buildingFallback, type Hint, mayTryBuildingFallback, parseUugResult, prepareAddress } from "./core.ts";

type JsonRow = Record<string, unknown>;
type CachedLocation = {
  address_key: string;
  address: string;
  lat: number | null;
  lng: number | null;
  status: "resolved" | "not_found" | "ambiguous";
  precision: "address" | "building" | null;
  source: string;
  updated_at: string;
};

const ALLOWED_ORIGINS = new Set(
  (Deno.env.get("DELIVERY_GEOCODE_ORIGINS") || "https://dostawy.idea-nova.pl,https://andrzej-wer.github.io")
    .split(",").map((value) => value.trim()).filter(Boolean),
);
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
// Supabase injects these server-side values. They are never returned to the browser.
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
  JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}").default || "";
const PUBLIC_KEY = Deno.env.get("SUPABASE_ANON_KEY") ||
  JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}").default || "";
const UUG_URL = Deno.env.get("DELIVERY_UUG_URL") || "https://services.gugik.gov.pl/uug/";
const SOURCE = "gugik-uug";

let allowedSnapshot: { owner: string; expires: number; addresses: Map<string, Hint> } | null = null;
let allowedLoading: { owner: string; promise: Promise<Map<string, Hint>> } | null = null;

class RequestFailure extends Error {
  constructor(public code: string, public httpStatus = 503, public retryMs = 0) { super(code); }
}

function response(origin: string, data: unknown, status = 200, retryMs = 0): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "authorization, apikey, content-type, x-client-info";
  }
  if (retryMs) headers["Retry-After"] = String(Math.max(1, Math.ceil(retryMs / 1000)));
  return new Response(JSON.stringify(data), { status, headers });
}

async function databaseRequest(path: string, headers: Record<string, string>, method = "GET", body?: unknown, prefer?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;
    const result = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    if (!result.ok) throw new RequestFailure("database_unavailable");
    const text = await result.text();
    return text ? JSON.parse(text) : null;
  } finally { clearTimeout(timer); }
}

function cacheDatabase(path: string, method = "GET", body?: unknown, prefer?: string): Promise<unknown> {
  const headers: Record<string, string> = { apikey: SERVICE_KEY };
  if (!SERVICE_KEY.startsWith("sb_secret_")) headers.Authorization = "Bearer " + SERVICE_KEY;
  return databaseRequest(path, headers, method, body, prefer);
}

function sourceDatabase(path: string, authorization: string): Promise<unknown> {
  // Saved addresses are read only with the gateway-verified caller's existing
  // permissions/RLS. The service role is restricted to the new private cache.
  return databaseRequest(path, { apikey: PUBLIC_KEY, Authorization: authorization });
}

function rows(value: unknown): JsonRow[] {
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object")) throw new RequestFailure("database_unavailable");
  return value as JsonRow[];
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }

async function knownAddresses(authorization: string, forceRefresh = false): Promise<Map<string, Hint>> {
  // Keep only one snapshot and one pending source read. A digest isolates
  // callers without retaining or logging their JWT in the cached snapshot.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization));
  const owner = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (;;) {
    if (!forceRefresh && allowedSnapshot?.owner === owner && allowedSnapshot.expires > Date.now()) return allowedSnapshot.addresses;
    const pending = allowedLoading;
    if (pending) {
      if (pending.owner === owner) return pending.promise;
      // A different caller may wait for the bounded loading slot, but must
      // never reuse that caller's data or inherit their authorization failure.
      try { await pending.promise; } catch { /* Retry with this caller's own rights. */ }
      continue;
    }
    break;
  }
  const promise = (async () => {
    const known = new Map<string, Hint>();
    function add(address: unknown, hint: Hint = {}) {
      if (typeof address !== "string" || !address.trim() || address.length > 300) return;
      const key = addressKey(address);
      if (!known.has(key)) known.set(key, hint);
    }
    const clients = rows(await sourceDatabase("clients_db?select=data&order=id.asc&limit=2", authorization));
    if (clients.length > 1) throw new RequestFailure("client_database_ambiguous");
    for (const row of clients) {
      for (const client of rows(row.data)) {
        add(client.addr, { street: text(client.street), city: text(client.city), zip: text(client.zip) });
      }
    }
    // History includes one-off delivery addresses and delivery overrides. Do not
    // accept arbitrary browser strings as a publicly callable geocoding proxy.
    for (let offset = 0; ; offset += 500) {
      if (offset >= 10000) throw new RequestFailure("address_registry_too_large");
      const plans = rows(await sourceDatabase("delivery_plans?select=stops&order=id.asc&limit=500&offset=" + offset, authorization));
      for (const plan of plans) {
        for (const stop of rows(plan.stops)) {
          add(stop.addr);
          add(stop.addrOverride, { street: text(stop.addrStreet), city: text(stop.addrCity), zip: text(stop.addrZip) });
        }
      }
      if (plans.length < 500) break;
    }
    allowedSnapshot = { owner, addresses: known, expires: Date.now() + 30000 };
    return known;
  })();
  const loading = { owner, promise };
  allowedLoading = loading;
  try { return await promise; }
  finally { if (allowedLoading === loading) allowedLoading = null; }
}

async function cached(key: string): Promise<CachedLocation | null> {
  const result = rows(await cacheDatabase("delivery_address_locations?address_key=eq." + encodeURIComponent(key) + "&select=address_key,address,lat,lng,status,precision,source,updated_at&limit=1"));
  if (!result.length) return null;
  const row = result[0] as CachedLocation;
  if (row.status === "resolved" && Number.isFinite(row.lat) && Number.isFinite(row.lng)) return row;
  if (["not_found", "ambiguous"].includes(row.status) && Date.now() - Date.parse(row.updated_at) < 7 * 86400000) return row;
  return null;
}

export async function handler(request: Request): Promise<Response> {
  const origin = request.headers.get("origin") || "";
  if (!ALLOWED_ORIGINS.has(origin)) return response(origin, { error: "origin_not_allowed" }, 403);
  if (request.method === "OPTIONS") return response(origin, { ok: true });
  if (request.method !== "POST") return response(origin, { error: "method_not_allowed" }, 405);
  // Deploy with verify_jwt=true. Origin checks complement, rather than replace,
  // the gateway's JWT verification and the saved-address allowlist below.
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) return response(origin, { error: "authorization_required" }, 401);
  if (!SUPABASE_URL || !SERVICE_KEY || !PUBLIC_KEY) return response(origin, { error: "backend_not_configured" }, 503);

  let leaseToken: string | null = null;
  let backoffMs = 0;
  let lastUpstreamStart = 0;
  try {
    const body = await request.text();
    if (body.length > 2048) throw new RequestFailure("invalid_address", 400);
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new RequestFailure("invalid_request", 400); }
    if (!payload || typeof payload !== "object" || !("address" in payload)) throw new RequestFailure("invalid_address", 400);
    const address = (payload as { address: unknown }).address;
    if (typeof address !== "string" || !address.trim() || address.length > 300 || /[\u0000-\u001f]/.test(address)) throw new RequestFailure("invalid_address", 400);
    const key = addressKey(address);
    let known = await knownAddresses(authorization);
    if (!known.has(key)) {
      // A client/one-off delivery may have just been saved after this worker's
      // 30-second snapshot. Refresh once before rejecting it.
      known = await knownAddresses(authorization, true);
    }
    if (!known.has(key)) throw new RequestFailure("address_not_saved", 400);
    const previous = await cached(key);
    if (previous) return response(origin, { ...previous, cached: true });

    const token = crypto.randomUUID();
    const lease = rows(await cacheDatabase("rpc/claim_delivery_geocode_slot", "POST", { p_token: token }));
    if (lease.length !== 1 || lease[0].granted !== true) {
      const retryMs = Math.max(1100, Number(lease[0]?.retry_after_ms) || 1500);
      throw new RequestFailure("rate_limited", 429, retryMs);
    }
    leaseToken = token;
    // A different browser may have filled this exact key while we were waiting.
    const afterLease = await cached(key);
    if (afterLease) return response(origin, { ...afterLease, cached: true });

    const expected = prepareAddress(address, known.get(key));
    async function queryUpstream(query: string): Promise<unknown> {
      // Both attempts remain inside the shared lease. A second lookup never
      // bypasses the same minimum interval used between different browsers.
      const remaining = lastUpstreamStart + 1100 - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      const url = new URL(UUG_URL);
      if (url.protocol !== "https:") throw new RequestFailure("provider_not_configured");
      url.searchParams.set("request", "GetAddress");
      url.searchParams.set("address", query);
      url.searchParams.set("accuracy", "0.5");
      url.searchParams.set("exact_number", "1");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      lastUpstreamStart = Date.now();
      try {
        const upstream = await fetch(url, {
          signal: controller.signal,
          headers: { "Accept": "application/json", "User-Agent": "IdeaNovaDelivery/1.0 (https://dostawy.idea-nova.pl)" },
        });
        if (!upstream.ok) {
          backoffMs = upstream.status === 429 || upstream.status === 503 ? 60000 : 15000;
          throw new RequestFailure("geocoder_unavailable", 503, backoffMs);
        }
        const content = await upstream.text();
        if (content.length > 1000000) throw new RequestFailure("invalid_provider_response", 502, 15000);
        return JSON.parse(content);
      } finally { clearTimeout(timer); }
    }
    const providerData = await queryUpstream(expected.query);
    let location = parseUugResult(providerData, expected);
    const fallback = buildingFallback(expected);
    if (location.status !== "resolved" && fallback && mayTryBuildingFallback(providerData, expected)) {
      const fallbackData = await queryUpstream(fallback.query);
      const building = parseUugResult(fallbackData, fallback, "building");
      // Keep the stronger ambiguity signal if the fallback also has no match.
      if (building.status !== "not_found" || location.status === "not_found") location = building;
      // The claim timestamp predates the second lookup. Ensure another worker
      // cannot start immediately after it when this lease is released.
      backoffMs = 1100;
    }
    const record: CachedLocation = {
      address_key: key, address: address.trim(), ...location, source: SOURCE, updated_at: new Date().toISOString(),
    };
    const saved = rows(await cacheDatabase("delivery_address_locations?on_conflict=address_key", "POST", record, "resolution=merge-duplicates,return=representation"));
    if (saved.length !== 1) throw new RequestFailure("cache_save_failed");
    return response(origin, { ...record, cached: false });
  } catch (error) {
    const known = error instanceof RequestFailure;
    if (leaseToken && !backoffMs) backoffMs = known ? error.retryMs : 15000;
    // Never log a customer address, provider URL/body or service credentials.
    console.warn("delivery-geocode", known ? error.code : "request_failed");
    return response(origin, {
      error: known ? error.code : "geocoder_unavailable",
      ...(known && error.retryMs ? { retry_after_ms: error.retryMs } : {}),
    }, known ? error.httpStatus : 503, known ? error.retryMs : 0);
  } finally {
    if (leaseToken) {
      // The slot is claimed before a cache recheck. Account for that database
      // latency so spacing is measured from the real upstream start.
      const releaseBackoff = Math.max(backoffMs, lastUpstreamStart ? 1100 - (Date.now() - lastUpstreamStart) : 0);
      try { await cacheDatabase("rpc/finish_delivery_geocode_slot", "POST", { p_token: leaseToken, p_backoff_ms: releaseBackoff }); }
      catch { console.warn("delivery-geocode", "lease_release_failed"); }
    }
  }
}

if (import.meta.main) Deno.serve(handler);
