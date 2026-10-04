# Chartly

免费公开的音乐榜单 & 奖项 API。完全开放，无需 API Key。部署在 Cloudflare Pages。

## 端点

| 端点 | 说明 |
| --- | --- |
| `GET /api` | 端点索引 |
| `GET /api/charts/billboard/hot-100` | Hot 100 |
| `GET /api/charts/billboard/album-200` | Billboard 200（专辑榜） |
| `GET /api/charts/billboard/global-200` | Global 200 |
| `GET /api/charts/billboard/artist-100` | Artist 100（歌手榜） |
| `GET /api/charts/douban/movie-top250` | 豆瓣电影 Top 250 |
| `GET /api/charts/douban/book-top250` | 豆瓣读书 Top 250 |
| `GET /api/charts/douban/music-top250` | 豆瓣音乐 Top 250 |
| `GET /api/charts/douban/music-top250-bayesian` | 豆瓣音乐 Top 250（贝叶斯加权排序） |
| `GET /api/charts/imdb/top250` | IMDb 电影 Top 250 |
| `GET /api/charts/goodreads/best-books-ever?page=N` | Goodreads Best Books Ever（用户投票榜，100 本/页） |
| `GET /api/awards/grammy/{year}` | 格莱美获奖名单 |
| `GET /api/awards/gma/{year}` | 金曲奖（静态数据） |
| `GET /api/awards/nobel/{year}` | 诺贝尔奖获奖名单 |
| `GET /api/awards/oscars/{year}` | 奥斯卡获奖与提名名单（Wikipedia 源） |
| `GET /api/awards/tga/{year}` | TGA 获奖名单（2014 起，仅获奖者） |

`GET /api` 返回端点索引：

```json
{
  "charts": {
    "billboard": ["/api/charts/billboard/hot-100", "..."],
    "douban": ["/api/charts/douban/movie-top250", "..."],
    "imdb": ["/api/charts/imdb/top250"],
    "goodreads": ["/api/charts/goodreads/best-books-ever"]
  },
  "awards": ["/api/awards/gma/{year}", "/api/awards/grammy/{year}", "..."]
}
```

- 榜单是完整路径，奖项因需要年份而给模板；索引由路由校验用的同一批常量生成，不会与真实路径脱节。

榜单响应：

```json
{
  "date": "2026-08-29",
  "url": "https://www.billboard.com/charts/billboard-200/",
  "entries": [
    { "rank": 1, "title": "...", "artist": "...",
      "cover": "...", "lastWeek": 2, "peak": 1, "weeks": 10 }
  ]
}
```

歌手榜（`artist-100`）的条目没有 `title` 字段，`artist` 即歌手名。`date` 是归一化后的榜单周六（可能与请求的 `?date` 不同），`url` 是数据来源的官网页面。

最小必要原则：响应不回显路径中已包含的 `source` / `chart` / `type`，只返回调用者无法自行推导的字段。

豆瓣 TOP250 响应（电影 / 读书 / 音乐同构）：

```json
{
  "url": "https://movie.douban.com/top250",
  "entries": [
    { "rank": 1, "title": "肖申克的救赎",
      "url": "https://movie.douban.com/subject/1292052/",
      "cover": "https://img3.doubanio.com/view/photo/s_ratio_poster/public/p2934829882.jpg",
      "rating": 9.7, "ratingCount": 3347290,
      "info": "1994 / 美国 / 犯罪 剧情", "quote": "希望让人自由。" }
  ]
}
```

- `rank` 为榜单内序号，`url` 是条目页，`cover` 为列表页缩略图。
- `info` 是页面上原有的 `/` 分隔描述行，含义随榜单变化：电影 = `年份 / 地区 / 类型`，读书 = `作者 / 出版社 / 出版年 / 价格`，音乐 = `歌手 / 发行日期 / 版本 / 介质 / 风格`。
- `quote` 为列表页短评，仅电影与读书有（分别为 135 / 160 条），音乐恒为 `null`；`rating` / `ratingCount` 取不到时为 `null`。
- 只返回主标题：电影页 `title` span 里的外文名（第二个 span）会被丢弃。
- 数据抓取自桌面版列表页 `?start=0,25,…,225` 共 10 页并行合成，缓存 24 小时。
- 音乐榜上游实际只有 **247** 条（豆瓣下架了 3 个条目），`rank` 最大值为 247。
- `rank` 镜像豆瓣官方页面顺序：电影 / 读书按评分排序，音乐榜是豆瓣内部的热度序（非评分序）。`music-top250-bayesian` 返回同一份条目，按贝叶斯加权评分 `WR = v/(v+m)·rating + m/(v+m)·C`（m=25000，C 为全榜均分）降序重排 `rank`，供需要"质量序"的调用方使用。
- 上游任一页解析为空（改版或被拦截）时返回 502，不会静默返回残缺列表。

IMDb Top 250 响应：

```json
{
  "url": "https://www.imdb.com/chart/top/",
  "entries": [
    { "rank": 1, "title": "The Shawshank Redemption",
      "originalTitle": "The Shawshank Redemption", "year": 1994,
      "url": "https://www.imdb.com/title/tt0111161/",
      "cover": "https://m.media-amazon.com/images/M/MV5BMDAyY2FhYjct...jpg",
      "rating": 9.3, "ratingCount": 3247459,
      "runtimeMinutes": 142, "genres": ["Drama"] }
  ]
}
```

- 数据抓自 IMDb 前端使用的公开 GraphQL 接口 `api.graphql.imdb.com`（`chartTitles`），一次请求返回全部 250 条。官网榜单页 `www.imdb.com/chart/top/` 位于 AWS WAF 之后，服务端直接抓取只会拿到 JS 挑战页（202 空响应），故不走页面抓取。
- 该接口要求携带浏览器来源请求头（`origin` / `referer` / `x-imdb-client-name`），缺失时返回 403；不要求 `User-Agent`，这也是它能在 Cloudflare Workers 中直接调用的原因（Workers 无法自定义出站 `User-Agent`）。
- `rank` 取上游 `currentRank`（1–250）。`title` 为主标题，`originalTitle` 为原始语言标题（英语片两者相同）；`year` / `rating` / `ratingCount` 取不到时为 `null`。`runtimeMinutes` 由上游秒数四舍五入到分钟。`url` 由 IMDb id 拼出。
- 上游返回 GraphQL 错误或空列表时返回 502，不会静默返回残缺列表。
- 授权提示：IMDb 对该接口数据声明仅允许有限的**非商业**用途；公开或商业用途需另行获得 IMDb 授权（见 IMDb 官方条款）。

Goodreads Best Books Ever 响应（分页，100 本/页）：

```json
{
  "url": "https://www.goodreads.com/list/show/1.Best_Books_Ever",
  "entries": [
    { "rank": 1, "title": "The Hunger Games (The Hunger Games, #1)",
      "author": "Suzanne Collins",
      "url": "https://www.goodreads.com/book/show/2767052-the-hunger-games",
      "cover": "https://i.gr-assets.com/images/S/compressed.photo.goodreads.com/books/1586722975i/2767052._SX50_.jpg",
      "rating": 4.36, "ratingCount": 10301598, "score": 4552311 }
  ]
}
```

```text
GET /api/charts/goodreads/best-books-ever          # 第 1 页（rank 1–100）
GET /api/charts/goodreads/best-books-ever?page=2    # 第 2 页（rank 101–200）
```

- Goodreads 无官方 "Top 250"，这里取其最知名的用户投票总榜 **Best Books Ever**。
- **分页**：`?page=N` 返回第 N 页，**每页 100 本**；`rank` 为全书单序号（`(N-1)·100 + 位次`），跨页连续。缺省即第 1 页。
- 上游对列表分页设有 **100 页上限**（10,000 本）：`?page=101` 起会被 Goodreads 静默钳制为第 100 页的同一批数据，故本 API 直接拒绝 `page > 100`（返回 400），避免返回错误序号。注意该榜总数为 79,655 本，但分页只能取到前 10,000 本。
- 抓自列表页 HTML 的 schema.org/Book 结构化标记。Robots.txt 对 `User-agent: *` 允许 `/list/show`（仅禁止 `/search`、`/work`、`/api` 等），且页面无需浏览器 `User-Agent` 即可返回 200，故可在 Workers 直接抓取。
- `score` 是列表的投票分数，也是该榜的排序依据——因此 **`rating` 更低的书可能排在前面**（如 rank 1 的 4.36 分高于 rank 4 的 4.50 分，但 score 更高）。`rating` / `ratingCount` / `score` 取不到时为 `null`。
- `title` / `author` 取列表页展示值（含系列后缀，如 `(The Hunger Games, #1)`）；多位作者时只取首位。
- 上游非 200 或解析为空时返回 502，不会静默返回空列表。缓存按完整 URL（含 `?page`）分别缓存 24 小时。

奖项响应：

```json
{
  "url": "https://www.grammy.com/awards/68th-annual-grammy-awards-2025/",
  "categories": [
    {
      "name": "Record Of The Year",
      "winner": "Kendrick Lamar , SZA",
      "title": "luther",
      "nominees": ["luther — Kendrick Lamar , SZA", "..."]
    }
  ]
}
```

- `year` 为**颁奖年份**（第 N 届 = N + 1958；第 60 届起官网 slug 用前一年，adapter 自动处理）。响应不回显请求参数，只返回 `url`（官网仪式页）与 `categories`。
- `winner` / `title` 来自页面完整 Winners 表格，覆盖该届**全部奖项**（约 85–95 个分类）。
- `nominees` 仅官网在仪式页渲染了提名卡片的头部奖项（Record/Album/Song of the Year、Best New Artist 等）才有内容，其余为空数组。

Nobel 响应：

```json
{
  "categories": [
    {
      "name": "Physics",
      "laureates": [
        { "name": "John Clarke", "motivation": "for the discovery of macroscopic quantum mechanical tunnelling and energy quantisation in an electric circuit" }
      ]
    }
  ]
}
```

- `year` 为**颁奖年份**（`awardYear`），范围 1901 至当前年。响应不回显请求参数，只返回 `categories`。
- 数据来自官方 API v2.1（`api.nobelprize.org`）实时代理，人名取 `knownName`（组织奖回退 `orgName`，如 2024 和平奖）。
- 未颁奖的类别（如 1940-1942 战争期间）会被剔除；某年全部未颁奖时返回 `"categories": []` 而非 404。

Oscars 响应（固定 Schema，获奖人归一为逗号分隔的人名列表）：

```json
{
  "edition": 98,
  "url": "https://en.wikipedia.org/wiki/98th_Academy_Awards",
  "awards": [
    {
      "name": "Actor in a Leading Role",
      "winner": { "name": "Michael B. Jordan", "work": "Sinners" },
      "nominees": [
        { "name": "Timothée Chalamet", "work": "Marty Supreme" },
        { "name": "Leonardo DiCaprio", "work": "One Battle after Another" }
      ]
    }
  ]
}
```

- 入参为**颁奖年份**（第 N 届 = N + 1928），范围 1929（第 1 届）至当前年；响应返回届数 `edition` 与数据来源 `url`，不回显请求参数。
- 数据抓取自 Wikipedia 奥斯卡条目（oscars.org 位于 Akamai 防护后，会拦截 Cloudflare Workers 的出站请求）。获奖与提名**全部类别**都有；多人获奖合并为逗号分隔的 `name`，同一人因多部影片得奖时 `work` 以 ` / ` 连接（如 1969 年最佳女主角双黄蛋）。
- `Music (Original Song)` 的 `work` 为影片名，词曲作者归一为 `name`。
- 上游条目改版会导致该源暂时 502。

Oscars Org 响应（与 Oscars 同构，数据改抓官网仪式页）：

```json
{
  "edition": 98,
  "url": "https://www.oscars.org/oscars/ceremonies/2026",
  "awards": [
    {
      "name": "Actor in a Leading Role",
      "winner": { "name": "Michael B. Jordan", "work": "Sinners" },
      "nominees": [
        { "name": "Timothée Chalamet", "work": "Marty Supreme" },
        { "name": "Leonardo DiCaprio", "work": "One Battle after Another" }
      ]
    }
  ]
}
```

- 入参与返回结构与 `oscars` 完全一致，`url` 指向官网仪式页。
- 两源个别字段略有出入：官网 `Music (Original Song)` 的 `work` 是歌曲名（Wikipedia 源是影片名），人名大小写也可能不同。
- 官网位于 Akamai 防护后，可能拦截 Cloudflare 的出站请求（表现为 502）；若该源不可用请改用 `oscars`（Wikipedia 源）。

TGA 响应（固定 Schema，仅获奖者，无提名）：

```json
{
  "edition": 12,
  "awards": [
    { "name": "Game of the Year", "winner": "Clair Obscur: Expedition 33" },
    { "name": "Best Performance", "winner": "Jennifer English" }
  ]
}
```

- 入参为**颁奖年份**（2014 = 第 1 届），响应返回届数 `edition = year - 2013`，不回显请求参数。
- `winner` 为字符串：游戏类是游戏名，个人类（Performance / Score and Music / Esports Athlete 等）是人名，与官网展示一致。
- 数据源：最新一届取官网 nominees 页内嵌的 `allAwards` 数据（颁奖前 `winner` 为 `null`）；历史届取 Rewind 归档页（`/rewind/year-{N}`，仅含 winner，无 nominees）。类别名统一 Title Case。
- 结果几乎不变，缓存 7 天。

错误统一为 `{ "error": { "status": 404, "message": "..." } }`。

## 历史查询

Billboard 端点支持 `?date=YYYY-MM-DD` 查询历史榜单，日期自动归一到该日期所在周的周六（Billboard 榜单按周六标注）：

```text
GET /api/charts/billboard/hot-100?date=2026-08-15
GET /api/charts/billboard/album-200?date=2020-06-01
```

## 限流与缓存

- 限流：每 IP 60 请求/分钟，超限返回 `429` + `Retry-After`（isolate 内存实现，跨实例为近似计数）。
- 缓存：Cloudflare Cache API，Billboard 榜单 1 小时、豆瓣 / IMDb / Goodreads 榜单 24 小时、奖项 24 小时（TGA 为 7 天），响应带 `X-Cache: HIT/MISS`。
- CORS：全开放（`*`）。

## 本地开发

```bash
npm install
npm run dev        # http://localhost:8788
```

浏览器打开 `http://localhost:8788` 即是 API 调试页。

## 部署

```bash
npm run deploy     # wrangler pages deploy
```

## 结构

```text
functions/
├── _lib/                  # 下划线前缀：不作为路由，仅供导入
│   ├── adapters/          # billboard / douban / imdb / goodreads / grammy / gma / nobel / oscars / tga
│   ├── cache.ts
│   ├── cors.ts
│   ├── ratelimit.ts
│   └── response.ts
└── api/[[path]].ts        # 唯一 API 入口
```

新增数据源只需在 `_lib/adapters/` 加一个文件，并在入口注册。

## 说明

- Billboard / Grammy / 豆瓣为实时抓取上游页面，上游改版会导致该源暂时 502。
- IMDb 走官方前端所用的公开 GraphQL 接口（非页面抓取），实时性好、无 WAF 挑战；但需遵守 IMDb 的非商业使用条款。
- Goodreads 为实时抓取用户投票榜列表页（Robots.txt 允许 `/list/show`），榜单随用户投票缓慢变动。
- **Rate Your Music (RYM) 未实现**：其站点被 Cloudflare 机器人挑战拦截（403 `Cf-Mitigated: challenge`），且 `robots.txt` 明确声明 "Sonemic, Inc. prohibits any kind of automated means (e.g. crawling, scraping) of access ... without express permission"。实时抓取既不可行也违反其服务条款，故不提供该数据源。
- 豆瓣移动端 rexxar JSON API 只提供电影与读书两个 collection（`music_top250` 为 404），故三个榜单统一抓桌面版列表页。
- Nobel 为官方 API 实时代理，数据随 NobelPrize.org 更新（当年奖项于 10 月起陆续公布，公布前查询该年返回空列表）。
- Grammy 年份按官网资格年（eligibility year）命名，请求较新年份会自动回退到最近一届，响应中的 `year` 为实际届次年份。
- GMA（金曲奖）目前为内置静态种子数据，后续按年补充或接入真实抓取。

## TODO

- 引入 Hono 作为路由框架