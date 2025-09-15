/// <reference types="@cloudflare/workers-types" />

/**
 * Environment variables configured in wrangler.toml
 */
export interface Env {
  CORS_ORIGIN: string;     // Allowed origins, e.g. "https://xxx.vercel.app, http://localhost:3000" or "*"
  UPSTREAM_FLOOD: string;  // Flood catchments: FeatureServer/1/query
  UPSTREAM_WATER: string;  // Water storages:  MapServer/0/query
  CACHE_TTL: string;       // Cache TTL in seconds, e.g. "3600"
}

/**
 * Add CORS headers to a response.
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
 * Build a cache key from the full upstream URL.
 */
function cacheKeyFromURL(u: URL) {
  return new Request(u.toString());
}

/**
 * Apply default query params if they are missing.
 * These are safe defaults for ArcGIS REST "query" endpoints.
 */
function applyDefaults(sp: URLSearchParams, kind: "flood" | "water") {
  if (!sp.has("f")) sp.set("f", "geojson");
  if (!sp.has("returnGeometry")) sp.set("returnGeometry", "true");
  if (!sp.has("outFields")) sp.set("outFields", "*");
  if (!sp.has("where")) sp.set("where", "1=1");

  // Reasonable record caps per dataset (tweak as needed)
  if (kind === "flood") {
    if (!sp.has("resultRecordCount")) sp.set("resultRecordCount", "500");
  } else {
    // water storages are points; allow a bit larger cap
    if (!sp.has("resultRecordCount")) sp.set("resultRecordCount", "1000");
  }
}

/**
 * Worker entry
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const reqOrigin = request.headers.get("Origin") || undefined;

    // --- Preflight ---
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }), env.CORS_ORIGIN, reqOrigin);
    }
    if (request.method !== "GET") {
      return withCORS(new Response("Method Not Allowed", { status: 405 }), env.CORS_ORIGIN, reqOrigin);
    }

    // --- Route selection: /flood or /water (root `/` falls back to /flood for backward compatibility) ---
    let kind: "flood" | "water" = "flood";
    const pathname = url.pathname.replace(/\/+$/, ""); // trim trailing slash
    if (pathname === "/water") kind = "water";
    // pathname === "/flood" or "/" -> flood

    const upstreamBase = kind === "flood" ? env.UPSTREAM_FLOOD : env.UPSTREAM_WATER;
    const upstream = new URL(upstreamBase);

    // --- Build upstream query: pass-through + defaults ---
    const sp = new URLSearchParams(url.search);
    applyDefaults(sp, kind);
    upstream.search = sp.toString();

    // --- Edge cache lookup ---
    const cache = (caches as unknown as { default: Cache }).default;
    const key = cacheKeyFromURL(upstream);
    const cached = await cache.match(key);
    if (cached) {
      return withCORS(cached, env.CORS_ORIGIN, reqOrigin);
    }

    // --- Upstream fetch with timeout ---
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

    // --- Normalize headers + caching policy ---
    const ttl = parseInt(env.CACHE_TTL || "3600", 10);
    const h = new Headers(upstreamRes.headers);
    h.set("Content-Type", "application/json; charset=utf-8");
    h.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=60`);

    const body = await upstreamRes.arrayBuffer();
    const fresh = new Response(body, { status: upstreamRes.status, headers: h });

    // Only cache successful responses
    if (upstreamRes.ok) {
      ctx.waitUntil(cache.put(key, fresh.clone()));
    }

    return withCORS(fresh, env.CORS_ORIGIN, reqOrigin);
  }
};
