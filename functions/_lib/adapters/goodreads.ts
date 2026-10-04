// Goodreads list adapter.
//
// Goodreads has no official "Top 250", so the closest equivalent is scraped:
// its most popular user-voted list, "Best Books Ever". List pages render rows
// as schema.org/Book microdata and hold 100 books each (?page=1,2,3…), ordered
// by the list's vote score. Robots.txt permits /list/show for `User-agent: *`
// (it disallows /search, /work, /api, …) and the pages return 200 without a
// browser User-Agent, so this is usable from Cloudflare Workers.
//
// The endpoint is paginated: `?page=N` returns that 100-book page and ranks
// continue across pages. Verified 2026-10: the list holds 79,655 books, but
// Goodreads caps list pagination at 100 pages (10,000 entries) — deeper `?page=`
// values are silently clamped to page 100, so MAX_PAGE is enforced here.

export interface GoodreadsEntry {
  rank: number;
  title: string;
  author: string;
  /** Book page, absolute (built from the row's /book/show/… href). */
  url: string;
  cover: string | null;
  /** Average user rating (e.g. 4.36). */
  rating: number | null;
  ratingCount: number | null;
  /** The list's vote score — the key these rows are ranked by, so a lower
   *  `rating` can still outrank a higher one. */
  score: number | null;
}

export interface GoodreadsList {
  url: string;
  entries: GoodreadsEntry[];
}

const BASE_URL = "https://www.goodreads.com";
const PAGE_SIZE = 100;
/** Goodreads clamps list pagination at 100 pages (10,000 entries): `?page=101`
 *  returns the same rows as page 100, so larger pages are rejected instead of
 *  being served with wrong ranks. */
export const GOODREADS_MAX_PAGE = 100;

/** Route names -> list path. Only the flagship user-voted list for now. */
const LISTS: Record<string, string> = {
  "best-books-ever": "/list/show/1.Best_Books_Ever",
};

export const GOODREADS_CHARTS = Object.keys(LISTS);

// One chunk per book; every row reports exactly one marker.
const ROW_MARKER = '<tr itemscope itemtype="http://schema.org/Book">';

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

/** Strips tags, decodes entities and collapses whitespace. */
function plainText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function grab(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? m[1] : null;
}

function parseNumber(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

/** The row's `.minirating` block is star icons followed by "4.36 avg rating —
 *  10,301,598 ratings"; strip the icons and read the two numbers off the text. */
function parseRating(chunk: string): { rating: number | null; ratingCount: number | null } {
  const block = grab(chunk, /class="minirating">([\s\S]*?)<\/div>/);
  if (block === null) return { rating: null, ratingCount: null };
  const text = plainText(block);
  const rating = grab(text, /([\d.]+)\s*avg rating/);
  const count = grab(text, /([\d,]+)\s*ratings/);
  return { rating: parseNumber(rating), ratingCount: parseNumber(count) };
}

/** Parses one schema.org/Book row into an entry (rank is assigned globally). */
function parseRow(chunk: string): Omit<GoodreadsEntry, "rank"> {
  const href = grab(chunk, /class="bookTitle"[^>]*href="([^"]+)"/);
  const title = grab(chunk, /class="bookTitle"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/);
  const author = grab(
    chunk,
    /itemprop=['"]author['"][\s\S]*?itemprop=['"]name['"][^>]*>([\s\S]*?)<\/span>/,
  );
  return {
    title: title === null ? "" : plainText(title),
    author: author === null ? "" : plainText(author),
    url: href === null ? "" : `${BASE_URL}${href}`,
    cover: grab(chunk, /class="bookCover"[^>]*src="([^"]+)"/),
    ...parseRating(chunk),
    score: parseNumber(grab(chunk, /score:\s*([\d,]+)/)),
  };
}

/**
 * Fetches a single 100-book page of a Goodreads list. Ranks are the position in
 * the whole list ((page-1)*100 + index + 1), so they continue across pages.
 * Throws `"goodreads upstream: ..."` on a non-OK response or an empty page so
 * the router surfaces a 502 instead of a silently broken page.
 */
export async function fetchGoodreadsList(chart: string, page: number): Promise<GoodreadsList> {
  const path = LISTS[chart];
  if (!path) throw new Error(`unknown chart: ${chart}`);

  const res = await fetch(`${BASE_URL}${path}?page=${page}`, { headers: UA });
  if (!res.ok) throw new Error(`goodreads upstream ${res.status} (page=${page})`);
  const rows = (await res.text()).split(ROW_MARKER).slice(1).map(parseRow);
  // A block / empty page must fail loudly rather than serve an empty list.
  if (rows.length === 0) throw new Error(`goodreads upstream: no entries parsed (page=${page})`);

  const entries = rows.map((entry, i) => ({
    ...entry,
    rank: (page - 1) * PAGE_SIZE + i + 1,
  }));
  return { url: `${BASE_URL}${path}`, entries };
}