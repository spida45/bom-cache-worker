/// <reference types="@cloudflare/workers-types" />

/**
 * Environment variables configured in wrangler.toml
 */
export interface Env {
  CORS_ORIGIN: string; // Allowed origins, e.g. "https://your-frontend.vercel.app, http://localhost:3000" or "*"
  UPSTREAM: string;    // ArcGIS upstream query endpoint
  CACHE_TTL: string;   // Cache duration in seconds (e.g., "3600")
}

/**
 * Add proper CORS headers to a response.
 */
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

/**
 * Build a cache key based on the full upstream URL.
 */
function buildCacheKey(u: URL) {
  return new Request(u.toString());
}

/**
 * Worker entry point.
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const reqUrl = new URL(request.url);
    const reqOrigin = request.headers.get("Origin") || undefined;

    // --- Handle preflight requests ---
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }), env.CORS_ORIGIN, reqOrigin);
    }

    if (request.method !== "GET") {
      return withCORS(
        new Response("Method Not Allowed", { status: 405 }),
        env.CORS_ORIGIN,
        reqOrigin
      );
    }

    // --- Build upstream request ---
    const upstream = new URL(env.UPSTREAM);
    const sp = new URLSearchParams(reqUrl.search);

    // Default parameters (applied only if missing)
    if (!sp.has("f")) sp.set("f", "geojson");
    if (!sp.has("returnGeometry")) sp.set("returnGeometry", "true");
    if (!sp.has("resultRecordCount")) sp.set("resultRecordCount", "200");
    if (!sp.has("outFields")) sp.set("outFields", "*");
    if (!sp.has("where")) sp.set("where", "1=1"); // Default: return all features

    upstream.search = sp.toString();

    // --- Check edge cache ---
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = buildCacheKey(upstream);
    const cached = await cache.match(cacheKey);

    if (cached) {
      return withCORS(cached, env.CORS_ORIGIN, reqOrigin);
    }

    // --- Fetch upstream with timeout ---
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

    // --- Standardize response headers ---
    const ttl = parseInt(env.CACHE_TTL || "3600", 10);
    const h = new Headers(upstreamRes.headers);
    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=60`);

    const body = await upstreamRes.arrayBuffer();
    const fresh = new Response(body, { status: upstreamRes.status, headers: h });

    // Only cache successful responses (status 200–299)
    if (upstreamRes.ok) {
      ctx.waitUntil(cache.put(cacheKey, fresh.clone()));
    }

    return withCORS(fresh, env.CORS_ORIGIN, reqOrigin);
  }
};
