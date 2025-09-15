/// <reference types="@cloudflare/workers-types" />

export interface Env {
  CORS_ORIGIN: string; // Allowed origins, comma-separated. Example: "https://xxx.vercel.app, http://localhost:3000" or "*"
  UPSTREAM: string;    // Upstream BOM ArcGIS query endpoint
  CACHE_TTL: string;   // Cache TTL in seconds, e.g. "3600"
}

// Wrap response with proper CORS headers
function withCORS(res: Response, originHeader: string, reqOrigin?: string) {
  const allowList = originHeader.split(",").map(s => s.trim());
  const h = new Headers(res.headers);

  if (reqOrigin && (allowList.includes("*") || allowList.includes(reqOrigin))) {
    h.set("Access-Control-Allow-Origin", reqOrigin);
  } else if (allowList.includes("*")) {
    h.set("Access-Control-Allow-Origin", "*");
  }

  h.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Vary", "Origin");

  return new Response(res.body, { status: res.status, headers: h });
}

// Build cache key based on full upstream URL including query params
function buildCacheKey(u: URL) {
  return new Request(u.toString());
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const reqUrl = new URL(request.url);
    const reqOrigin = request.headers.get("Origin") || undefined;

    // Handle preflight request
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }), env.CORS_ORIGIN, reqOrigin);
    }

    // Only GET requests are allowed
    if (request.method !== "GET") {
      return withCORS(new Response("Method Not Allowed", { status: 405 }), env.CORS_ORIGIN, reqOrigin);
    }

    // ---------- 1) Construct upstream URL ----------
    const upstream = new URL(env.UPSTREAM);
    const sp = new URLSearchParams(reqUrl.search);

    // Default query parameters (added if missing)
    if (!sp.has("f")) sp.set("f", "geojson");           // Default format: geojson
    if (!sp.has("returnGeometry")) sp.set("returnGeometry", "true"); // Ensure geometry is returned
    if (!sp.has("resultRecordCount")) sp.set("resultRecordCount", "200"); // Limit record count
    if (!sp.has("outFields")) sp.set("outFields", "*"); // Return all fields

    upstream.search = sp.toString();

    // ---------- 2) Try to get response from edge cache ----------
    const cache = caches.default;
    const cacheKey = buildCacheKey(upstream);
    const cached = await cache.match(cacheKey);
    if (cached) {
      return withCORS(cached, env.CORS_ORIGIN, reqOrigin);
    }

    // ---------- 3) Fetch from upstream with 8s timeout ----------
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), 8000);
    let upstreamRes: Response;

    try {
      upstreamRes = await fetch(upstream.toString(), {
        method: "GET",
        signal: controller.signal,
        headers: { "Accept": "application/json" }
      });
    } catch (e) {
      clearTimeout(timer);
      return withCORS(
        new Response(JSON.stringify({ error: "upstream_timeout_or_network" }), {
          status: 504,
          headers: { "Content-Type": "application/json" }
        }),
        env.CORS_ORIGIN,
        reqOrigin
      );
    } finally {
      clearTimeout(timer);
    }

    // ---------- 4) Normalize headers and store in cache ----------
    const ttl = parseInt(env.CACHE_TTL || "3600", 10);
    const h = new Headers(upstreamRes.headers);

    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=60`);

    const body = await upstreamRes.arrayBuffer();
    const fresh = new Response(body, { status: upstreamRes.status, headers: h });

    // Write to cache asynchronously
    ctx.waitUntil(cache.put(cacheKey, fresh.clone()));

    return withCORS(fresh, env.CORS_ORIGIN, reqOrigin);
  }
};
