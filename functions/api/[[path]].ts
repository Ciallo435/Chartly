import { json, errorJson } from "../_lib/response";
import { preflight } from "../_lib/cors";
import { withCache } from "../_lib/cache";
import { rateLimit, clientIp } from "../_lib/ratelimit";
import { fetchBillboardChart, BILLBOARD_CHARTS } from "../_lib/adapters/billboard";
import { fetchDoubanTop250, DOUBAN_CHARTS } from "../_lib/adapters/douban";
import { fetchGrammy } from "../_lib/adapters/grammy";
import { fetchGma } from "../_lib/adapters/gma";
import { fetchNobel } from "../_lib/adapters/nobel";
import { fetchOscars } from "../_lib/adapters/oscars";
import { fetchTga } from "../_lib/adapters/tga";

/**
 * Awards route registry: source → producer + edge-cache TTL (seconds). Adding a
 * new source is one entry here plus one adapter — routing, index and 404/404
 * mapping all derive from this table. Adapters throw `"<source>: ..."` for
 * "no ceremony that year", mapped to 404 by the top-level catch.
 */
const AWARD_ROUTES: Record<string, { ttl: number; fetch: (year: number) => unknown }> = {
  gma: { ttl: 86400, fetch: fetchGma },
  grammy: { ttl: 86400, fetch: fetchGrammy },
  nobel: { ttl: 86400, fetch: fetchNobel },
  oscars: { ttl: 86400, fetch: fetchOscars },
  // TGA results essentially never change; cache for a week.
  tga: { ttl: 604800, fetch: fetchTga },
};

const AWARD_SOURCES = Object.keys(AWARD_ROUTES);

/** GET /api/charts/billboard/{chart} — optional ?date=YYYY-MM-DD historical query. */
async function handleBillboard(request: Request, chart: string): Promise<Response> {
  if (!BILLBOARD_CHARTS.includes(chart)) return errorJson(404, `unknown chart: ${chart}`);

  // Date is normalized to the chart's Saturday week inside the adapter.
  let date: string | undefined;
  const dateParam = new URL(request.url).searchParams.get("date");
  if (dateParam !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam) || Number.isNaN(Date.parse(dateParam))) {
      return errorJson(400, "invalid date, expected YYYY-MM-DD");
    }
    if (dateParam > new Date().toISOString().slice(0, 10)) {
      return errorJson(400, "date is in the future");
    }
    date = dateParam;
  }

  return withCache(request, 3600, async () => json(await fetchBillboardChart(chart, date)));
}

/** GET /api/charts/douban/{chart} — TOP 250 lists are near-static; cache for a day. */
async function handleDouban(request: Request, chart: string): Promise<Response> {
  if (!DOUBAN_CHARTS.includes(chart)) return errorJson(404, `unknown chart: ${chart}`);
  return withCache(request, 86400, async () => json(await fetchDoubanTop250(chart)));
}

/** GET /api/awards/{source}/{year} — dispatch through the registry. */
async function handleAwards(request: Request, source: string, rest0: string): Promise<Response> {
  const year = Number(rest0);
  if (!Number.isInteger(year) || year < 1901 || year > 2100) return errorJson(400, "invalid year");

  const route = AWARD_ROUTES[source];
  if (!route) return errorJson(404, `unknown awards source: ${source}`);

  return withCache(request, route.ttl, async () => json(await route.fetch(year)));
}

/**
 * Index served at GET /api (also the debug page's landing request). Chart paths
 * are complete, award paths are templates since they need a year. Built from
 * the same constants the router validates against, so it cannot drift.
 */
function endpointIndex() {
  return {
    charts: {
      billboard: BILLBOARD_CHARTS.map((chart) => `/api/charts/billboard/${chart}`),
      douban: DOUBAN_CHARTS.map((chart) => `/api/charts/douban/${chart}`),
    },
    awards: AWARD_SOURCES.map((source) => `/api/awards/${source}/{year}`),
  };
}

export const onRequest: PagesFunction = async ({ request, params }) => {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "GET") return errorJson(405, "method not allowed");

  const { ok, retryAfter } = rateLimit(clientIp(request));
  if (!ok) {
    return errorJson(429, "rate limit exceeded (60 req/min)", {
      "Retry-After": String(retryAfter),
    });
  }

  try {
    const [resource, source, id, ...rest] = ((params.path as string[]) ?? []).filter(Boolean);
    if (!resource) return json(endpointIndex());

    // Max three segments: /api/{resource}/{source}/{id}.
    if (rest.length === 0 && id) {
      if (resource === "charts") {
        if (source === "billboard") return await handleBillboard(request, id);
        if (source === "douban") return await handleDouban(request, id);
      } else if (resource === "awards" && source) {
        return await handleAwards(request, source, id);
      }
    }

    return errorJson(404, "not found");
  } catch (err) {
    const message = err instanceof Error ? err.message : "upstream error";
    if (AWARD_SOURCES.some((source) => message.startsWith(`${source}:`))) {
      return errorJson(404, message);
    }
    return errorJson(502, `upstream fetch failed: ${message}`);
  }
};
