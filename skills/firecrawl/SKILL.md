---
name: firecrawl
description: Pick the right Firecrawl tool for web research, page reading, structured extraction, crawling, monitoring and browser interaction. Use when searching the web, reading a URL, extracting structured data from pages, mapping or crawling a site, researching papers or library behaviour, or debugging a Firecrawl job.
---

# Firecrawl

The `omp-firecrawl` plugin puts the whole Firecrawl v2 API behind omp tools.
`web_search` is Firecrawl-backed by default and falls back to omp's built-in
providers if Firecrawl fails, so ordinary search needs no special handling.

Everything else is a discoverable device: read `xd://firecrawl_<name>` for its
schema before first use.

## Choose the tool

| Need | Tool |
|---|---|
| Find pages, news, images; scoped to github/research/pdf corpora | `web_search` |
| Error message, library behaviour, API semantics, upgrade breakage | `firecrawl_developer` |
| Academic literature, paper full text, related work | `firecrawl_research` |
| Read one URL as clean markdown, or ask a question about it | `firecrawl_scrape` |
| Read many known URLs | `firecrawl_batch` |
| Discover what URLs a site has | `firecrawl_map` |
| Read a whole site or section you cannot enumerate | `firecrawl_crawl` |
| One schema filled from several pages, possibly discovered | `firecrawl_extract` |
| Multi-step navigation: log in, paginate, fill forms, then extract | `firecrawl_agent` |
| Drive a live browser with Playwright code or a prompt | `firecrawl_interact` |
| PDF/Word/Excel/PowerPoint into markdown, pages, layout blocks | `firecrawl_parse` |
| Watch a page/site/query on a schedule and alert on change | `firecrawl_monitor` |
| Credits, queue depth, activity, policy, job feedback, support | `firecrawl_account` |

## Rules that save credits and time

- **Search before scraping.** `web_search` with `scrape: true` returns ranked
  results *and* their content in one call. Two separate calls cost more.
- **Ask for the smallest format.** `summary` beats `markdown` when you need the
  gist; `{type:"question"}` beats reading a page yourself when you have one
  specific question; `{type:"highlights", query}` beats full markdown when you
  need the passages that matter.
- **Reuse the cache.** `maxAge` defaults to 2 days and cache hits are ~5x
  faster and cheaper. Only pass `maxAge: 0` when freshness is the point.
- **Escalate proxies, don't start there.** `proxy: "auto"` already retries
  `basic` then `enhanced`. Naming `enhanced` up front costs 5 credits per page.
- **Map before you crawl.** `firecrawl_map` is near-instant and tells you
  whether a crawl is worth starting and what `includePaths` to use.
- **Cap crawls.** Always set `limit`. An uncapped crawl of a large site burns
  credits and returns more than any context window can hold.
- **Extraction ladder, cheapest first:** `firecrawl_scrape` with
  `{type:"json"}` (one page) → `firecrawl_extract` (several pages, one schema) →
  `firecrawl_agent` (needs navigation or interaction). Do not start at the top.
- **Delete interact sessions.** A live browser session bills until it is
  deleted or times out.

## Output handling

Large content never lands in the transcript whole. Anything over the inline
budget (default 12,000 chars) is written to
`~/.omp/cache/firecrawl/<date>/<slug>.md` and the tool reports the path — use
`read` with a line range to page through it. HTML, raw HTML, layout blocks and
long link lists are always spilled.

## Auth

Resolution order: `FIRECRAWL_API_KEY` → the `0600` key cache at
`~/.omp/cache/firecrawl/credential.json` (12h, so 1Password is consulted about
once a day rather than once per process) → 1Password
`op://Dev-Env/Firecrawl/credential` → keyless (heavily rate limited).
`/firecrawl` prints the resolved mode, remaining credits and queue depth;
`/firecrawl refresh` re-reads the key after a rotation.

## When a job fails

`firecrawl_account` with `action: "ask"` sends the failing job id to Firecrawl's
support agent and returns a diagnosis. `action: "docs_search"` answers API
questions with citations. Both beat guessing at parameters.
