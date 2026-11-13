# Delivery address geocoding

This narrow backend resolves saved delivery/customer addresses independently of route optimization. It uses GUGiK UUG, never the public Nominatim endpoint.

## Deployment contract

- Review/apply `../../sql/delivery_geocode_cache.sql` through the project's migration workflow. This is a first-installation migration: confirm both target tables and functions are absent. It uses plain `CREATE`, never drops or replaces an existing object, and preserves the required RLS/permission restrictions.
- Run the read-only `../../sql/verify_delivery_geocode_private.sql` after applying it; every `passed` value must be true. This inspects actual grants, column permissions, RLS and function privileges without reading address rows.
- Deploy this function as `delivery-geocode` with **`verify_jwt=true`** and this directory's `deno.json`/lockfile.
- Supabase provides the backend URL and service key. No service key belongs in `index.html` or the response.
- Optional `DELIVERY_GEOCODE_ORIGINS` is a comma-separated allowlist; defaults to `https://dostawy.idea-nova.pl,https://andrzej-wer.github.io`.
- Optional `DELIVERY_UUG_URL` changes the upstream compatible UUG endpoint without changing the browser.
- Display `Dane adresowe: GUGiK / PRG` beside nearby distances. Distances are straight-line distances, not road distances or live GPS tracking.

## Browser API

Send `POST /functions/v1/delivery-geocode` with the existing project's anon JWT in `Authorization: Bearer …`, the project's `apikey`, and JSON `{ "address": "the saved address" }`.

An HTTP 200 response contains `address_key`, `address`, `lat`, `lng`, `status`, `precision`, `source`, `updated_at`, `cached`. `status` is `resolved`, `not_found`, or `ambiguous`; the latter two have null coordinates and null precision. `precision` is `address` for the complete matched address point or `building` when a trailing apartment number was omitted. Neither represents a specific apartment's coordinates. The key algorithm is NFC, trim, lowercase, then collapse whitespace; punctuation and building numbers remain significant.

HTTP 429 returns `{ "error": "rate_limited", "retry_after_ms": … }`; wait at least that long. HTTP 400 `address_not_saved` means save the customer/one-off stop first. HTTP 503 represents a provider/database outage and must not be rendered as “no nearby customers”.

Use one frontend queue for the whole page. Render the browser's own previously obtained results immediately and show a completion counter while individual missing addresses are resolved. Cancellation stops subsequent requests. The private backend cache reuses successful coordinates across devices; negative matches are cached for seven days. Address edits produce a new key and do not inherit old coordinates.

Both cache tables have RLS enabled and no privileges for `PUBLIC`, `anon` or `authenticated`. Only the server-side `service_role` can read/write the address cache. The browser must not query `delivery_address_locations` through REST, enumerate it, or load a list of cached addresses. There is no batch/list endpoint. A caller supplies one already-known saved address to the function and receives only that address's result; its own browser memory may retain those individual results.

Only addresses already in `clients_db` or `delivery_plans` (including `addrOverride`) are accepted. The allowlist is cached for 30 seconds in a warm worker and refreshed on a miss. Names, phones and notes are never sent to GUGiK. The service does not accept an arbitrary upstream URL from the browser.

The database enforces one active upstream request plus at least 1100 ms between starts across all Edge workers. Cache lookups bypass this limiter. A 30-second lease expires if a worker dies. Provider failures apply a global backoff.

## Match quality

UUG is queried with `accuracy=0.5` and `exact_number=1`. A resolved point requires one exact city, postcode and house number match; missing city/postcode requires completing the saved address. The street must be identical after normalization or a complete trailing word sequence of the register's expanded name (for example, `Andersa` matches `Generała Władysława Andersa`). Prefixes, spelling similarity and partial words are never accepted. UUG's text-similarity score does not override these metadata checks. Multiple matching points and street/town centroids stay unresolved. PUWG 1992 easting/northing is converted to WGS84 with pinned Proj4js.

Compound numbers are tried intact first. If there is no exact complete-number match, one additional query may omit the final slash-separated apartment segment: `22/2` becomes `22`, while `46/50/135` becomes `46/50`. City, street, postcode and the remaining house number must still match one unique point; there is no fuzzy or town-centroid fallback. Multiple exact complete-number results remain ambiguous. Both requests share the global lease, stay at least 1100 ms apart, and cache the result under the original complete address.

No production geocoding requests or database writes are performed by the tests. Run `deno task check` and `deno task test` in this directory. The numeric projection fixture is from GUGiK documentation; names used in tests are synthetic.

## Primary references

- UUG API: https://services.gugik.gov.pl/uug/opis.html
- PRG data: https://www.geoportal.gov.pl/pl/dane/panstwowy-rejestr-granic-prg/
- Geoportal attribution terms: https://www.geoportal.gov.pl/pl/o-geoportalu/regulamin/
- Proj4js API: https://proj4js.org/
- Supabase function dependencies: https://supabase.com/docs/guides/functions/dependencies

Public Nominatim is deliberately not used here. Its policy limits total app traffic to one request per second, requires caching and attribution, restricts batch geocoding, prohibits autocomplete and submission of personal/confidential data: https://operations.osmfoundation.org/policies/nominatim/
