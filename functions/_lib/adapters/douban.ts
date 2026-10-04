// Douban TOP 250 adapters (movie / book / music).
//
// Douban's mobile "rexxar" JSON API only exposes the movie_top250 and
// book_top250 collections (music_top250 is 404), so all three are scraped from
// the desktop list pages, which share one pagination contract: ?start=0,25,…,225
// (10 pages, 25 each). Verified 2026-10: 250 movie / 250 book / 247 music
// entries upstream (Douban dropped 3 music subjects), no captcha or anti-bot
// page for a plain browser UA.
//
// Note: only the primary (Chinese) title is returned; movie pages also carry
// foreign titles in a second <span class="title">, which are intentionally
// dropped. The `info` line is the page's own "/"-separated description line and
// its meaning is type-dependent (see DoubanEntry.info).
//
// `rank` always mirrors the official page order. That is rating-sorted for
// movie and book, but the music list follows Douban's undocumented
// popularity-weighted order (verified 2026-10: 116 rating inversions across
// 247 entries, vote counts roughly decreasing). The `music-top250-bayesian`
// route serves the same entries re-ranked by Bayesian rating (see BAYES_M).

export type DoubanType = "movie" | "book" | "music";

export interface DoubanEntry {
  rank: number;
  title: string;
  url: string | null;
  cover: string | null;
  rating: number | null;
  ratingCount: number | null;
  /** Type-dependent: movie = year / region / genre; book = author / publisher /
   *  year / price; music = artist / release date / label / genre. */
  info: string;
  /** Short editorial quote; movie and book only, always null for music. */
  quote: string | null;
}

export interface DoubanTop250 {
  url: string;
  entries: DoubanEntry[];
}

const PAGE_SIZE = 25;
const PAGE_COUNT = 10; // 250 / 25

/** Bayesian prior weight (IMDb's convention). Votes below this count are pulled
 *  toward the list-wide mean rating C, damping small-sample high scores. */
const BAYES_M = 25000;

const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

// List pages split into per-item chunks by these markers; the movie list uses
// <div class="item"> while book and music use <tr class="item">
// (both report exactly one marker per entry).
const ITEM_MARKERS: Record<DoubanType, string> = {
  movie: '<div class="item">',
  book: '<tr class="item"',
  music: '<tr class="item"',
};

const LIST_PAGES: Record<DoubanType, string> = {
  movie: "https://movie.douban.com/top250",
  book: "https://book.douban.com/top250",
  music: "https://music.douban.com/top250",
};

/** Route names -> source type (mirrors BILLBOARD_CHARTS). The `*-bayesian`
 *  variants serve the same entries re-ranked by Bayesian rating. */
const DOUBAN_TYPES: Record<string, DoubanType> = {
  "movie-top250": "movie",
  "book-top250": "book",
  "music-top250": "music",
  "music-top250-bayesian": "music",
};

/** Bayesian-ranked route names (see byBayesianRating). */
const BAYES_CHARTS = new Set(["music-top250-bayesian"]);

export const DOUBAN_CHARTS = Object.keys(DOUBAN_TYPES);

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'");
}

/** Strips tags, decodes entities and collapses whitespace. */
function plainText(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function grab(s: string, re: RegExp): string | null {
  const m = s.match(re);
  return m ? m[1] : null;
}

/** Plain text of an optional node; an empty node (some book entries carry an
 *  empty .inq span) normalizes to null so the field shape stays uniform. */
function optionalText(raw: string | null): string | null {
  if (raw === null) return null;
  const t = plainText(raw);
  return t === "" ? null : t;
}

/** Fields present in every type: subject link, cover, score and vote count. */
function parseCommon(chunk: string, urlRe: RegExp, coverRe: RegExp) {
  const rating = grab(chunk, /rating_nums?[^>]*>\s*([\d.]+)\s*</);
  const count = grab(chunk, /(\d+)人评价/);
  return {
    url: grab(chunk, urlRe),
    cover: grab(chunk, coverRe),
    rating: rating === null ? null : Number(rating),
    ratingCount: count === null ? null : Number(count),
  };
}

/**
 * Movie chunks: info is the line after <br> in .bd, quote in p.quote. The page
 * also numbers items in <em>, but ranks are assigned globally instead so all
 * three lists share one convention.
 */
function parseMovieChunks(html: string): Omit<DoubanEntry, "rank">[] {
  return html.split(ITEM_MARKERS.movie).slice(1).map((chunk) => {
    const titles = [...chunk.matchAll(/<span class="title">([\s\S]*?)<\/span>/g)].map((m) => plainText(m[1]));
    const bd = grab(chunk, /<div class="bd">([\s\S]*?)<\/p>/);
    return {
      title: titles[0] ?? "",
      ...parseCommon(chunk, /class="pic"[\s\S]*?href="([^"]+)"/, /class="pic"[\s\S]*?<img[^>]*src="([^"]+)"/),
      // The .bd paragraph is "credits<br>year / region / genre" — keep the latter.
      info: bd ? plainText(bd.split(/<br\s*\/?>/).pop()!) : "",
      quote: optionalText(grab(chunk, /<p class="quote">([\s\S]*?)<\/p>/)),
    };
  });
}

/** Book / music chunks: <tr class="item">, title in .pl2, info in p.pl, quote (book) in .inq. */
function parseListingChunks(marker: string) {
  return (html: string): Omit<DoubanEntry, "rank">[] =>
    html.split(marker).slice(1).map((chunk) => {
      const title = grab(chunk, /<div class="pl2">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/);
      const info = grab(chunk, /<p class="pl">([\s\S]*?)<\/p>/);
      return {
        title: title === null ? "" : plainText(title),
        ...parseCommon(chunk, /<a class="nbg" href="([^"]+)"/, /<a class="nbg"[\s\S]*?<img[^>]*src="([^"]+)"/),
        info: info === null ? "" : plainText(info),
        quote: optionalText(grab(chunk, /<span class="inq">([\s\S]*?)<\/span>/)),
      };
    });
}

const PARSERS: Record<DoubanType, (html: string) => Omit<DoubanEntry, "rank">[]> = {
  movie: parseMovieChunks,
  book: parseListingChunks(ITEM_MARKERS.book),
  music: parseListingChunks(ITEM_MARKERS.music),
};

/**
 * Re-ranks entries by Bayesian-weighted rating: WR = v/(v+m)·rating +
 * m/(v+m)·C with C = mean rating across the fetched list, descending. Entries
 * lacking rating or ratingCount sink to the end in their original order.
 */
function byBayesianRating(entries: DoubanEntry[]): DoubanEntry[] {
  const scored = entries.filter((e) => e.rating !== null && e.ratingCount !== null);
  const C = scored.reduce((sum, e) => sum + e.rating!, 0) / (scored.length || 1);
  const wr = new Map(
    entries.map((e) => {
      if (e.rating === null || e.ratingCount === null) return [e, -Infinity];
      const weight = e.ratingCount / (e.ratingCount + BAYES_M);
      return [e, weight * e.rating + (1 - weight) * C];
    }),
  );
  return [...entries].sort((a, b) => wr.get(b)! - wr.get(a)!).map((e, i) => ({ ...e, rank: i + 1 }));
}

/**
 * Fetches all 10 pages of a Douban TOP 250 list in parallel and concatenates
 * them. Ranks are the position in the resulting list: a few upstream pages hold
 * fewer than 25 items (the music list actually has 247 entries), so
 * start + index + 1 would produce gaps.
 */
export async function fetchDoubanTop250(chart: string): Promise<DoubanTop250> {
  const type = DOUBAN_TYPES[chart];
  if (!type) throw new Error(`unknown chart: ${chart}`);

  const path = LIST_PAGES[type];
  const parse = PARSERS[type];
  const pages = await Promise.all(
    Array.from({ length: PAGE_COUNT }, async (_, i) => {
      const start = i * PAGE_SIZE;
      const res = await fetch(`${path}?start=${start}`, { headers: UA });
      if (!res.ok) throw new Error(`douban upstream ${res.status} (${type} start=${start})`);
      const items = parse(await res.text());
      // A captcha / anti-bot page also returns 200 — fail loudly instead of
      // silently serving a truncated list.
      if (items.length === 0) throw new Error(`douban upstream: no entries parsed (${type} start=${start})`);
      return items;
    }),
  );

  const entries = pages.flat().map((entry, i) => ({ ...entry, rank: i + 1 }));
  return { url: path, entries: BAYES_CHARTS.has(chart) ? byBayesianRating(entries) : entries };
}
