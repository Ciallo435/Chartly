// IMDb TOP 250 adapter.
//
// www.imdb.com/chart/top is behind AWS WAF (returns a 202 JS challenge with an
// empty body for non-browser requests), so scraping the page is not viable from
// an edge runtime. IMDb's own frontend instead reads the chart from its public
// GraphQL endpoint, which returns the whole list in one request:
//
//   POST https://api.graphql.imdb.com/  { chartTitles(first: 250, chart: ...) }
//
// Verified 2026-10: 250 entries, edges ordered by rank (currentRank 1..250).
// The endpoint rejects header-less POSTs with 403 — it needs the browser-origin
// headers below (referer/origin/x-imdb-client-name); a User-Agent is NOT
// required, which is what makes it usable from Cloudflare Workers (Workers
// cannot override the outbound User-Agent).

export interface ImdbEntry {
  rank: number;
  /** IMDb "primary title" (the English/promoted title). */
  title: string;
  /** Original-language title; equals `title` for English-language films. */
  originalTitle: string;
  year: number | null;
  /** Title page, built from the IMDb id: https://www.imdb.com/title/{id}/. */
  url: string;
  cover: string | null;
  rating: number | null;
  ratingCount: number | null;
  runtimeMinutes: number | null;
  genres: string[];
}

export interface ImdbTop250 {
  url: string;
  entries: ImdbEntry[];
}

/** Route names -> IMDb chart type + source page (mirrors BILLBOARD_SLUGS). */
const IMDB_CHARTS_CONFIG: Record<string, { chartType: string; page: string }> = {
  top250: { chartType: "TOP_RATED_MOVIES", page: "https://www.imdb.com/chart/top/" },
};

export const IMDB_CHARTS = Object.keys(IMDB_CHARTS_CONFIG);

const PAGE_SIZE = 250;

// Required by api.graphql.imdb.com; omitting any of these yields 403.
const GRAPHQL_HEADERS = {
  "content-type": "application/json",
  origin: "https://www.imdb.com",
  referer: "https://www.imdb.com/",
  "x-imdb-client-name": "imdb-web-next",
};

/** Selection set for the chart connection; chart type / page size are inlined
 *  in the query because both are fixed here and inlining avoids guessing the
 *  enum's input type. */
const EDGES_SELECTION = `edges {
      currentRank
      node {
        id
        titleText { text }
        originalTitleText { text }
        releaseYear { year }
        ratingsSummary { aggregateRating voteCount }
        primaryImage { url }
        runtime { seconds }
        genres { genres { text } }
      }
    }`;

interface ImdbChartNode {
  id: string;
  titleText: { text: string } | null;
  originalTitleText: { text: string } | null;
  releaseYear: { year: number } | null;
  ratingsSummary: { aggregateRating: number | null; voteCount: number | null } | null;
  primaryImage: { url: string } | null;
  runtime: { seconds: number | null } | null;
  genres: { genres: { text: string }[] } | null;
}

interface ImdbChartEdge {
  currentRank: number | null;
  node: ImdbChartNode;
}

interface ImdbGraphQLResponse {
  data?: { chartTitles?: { edges: ImdbChartEdge[] } };
  errors?: { message?: string }[];
}

/** Maps one GraphQL edge to an entry; rank falls back to the 1-based position
 *  when the upstream `currentRank` is missing. */
function toEntry(edge: ImdbChartEdge, index: number): ImdbEntry {
  const n = edge.node;
  const secs = n.runtime?.seconds;
  return {
    rank: edge.currentRank ?? index + 1,
    title: n.titleText?.text ?? "",
    originalTitle: n.originalTitleText?.text ?? n.titleText?.text ?? "",
    year: n.releaseYear?.year ?? null,
    url: `https://www.imdb.com/title/${n.id}/`,
    cover: n.primaryImage?.url ?? null,
    rating: n.ratingsSummary?.aggregateRating ?? null,
    ratingCount: n.ratingsSummary?.voteCount ?? null,
    runtimeMinutes: secs == null ? null : Math.round(secs / 60),
    genres: n.genres?.genres.map((g) => g.text) ?? [],
  };
}

/**
 * Fetches an IMDb chart (currently only the movie TOP 250) from IMDb's public
 * GraphQL API and normalizes each row. Throws `"imdb upstream: ..."` on a
 * non-OK response, a GraphQL error, or an empty list so the router surfaces a
 * 502 instead of a silently truncated chart.
 */
export async function fetchImdbTop250(chart: string): Promise<ImdbTop250> {
  const config = IMDB_CHARTS_CONFIG[chart];
  if (!config) throw new Error(`unknown chart: ${chart}`);

  const query = `query Top250 {
  chartTitles(first: ${PAGE_SIZE}, chart: { chartType: ${config.chartType} }) {
    ${EDGES_SELECTION}
  }
}`;

  const res = await fetch("https://api.graphql.imdb.com/", {
    method: "POST",
    headers: GRAPHQL_HEADERS,
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`imdb upstream ${res.status}`);

  const payload = (await res.json()) as ImdbGraphQLResponse;
  if (payload.errors?.length) {
    throw new Error(`imdb upstream: ${payload.errors[0]?.message ?? "GraphQL error"}`);
  }

  const edges = payload.data?.chartTitles?.edges ?? [];
  if (edges.length === 0) throw new Error("imdb upstream: no entries parsed");

  return { url: config.page, entries: edges.map(toEntry) };
}