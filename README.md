# omp-firecrawl

The whole [Firecrawl v2 API](https://docs.firecrawl.dev/api-reference/v2-introduction)
as omp/pi tools, installed once and available in every omp instance: interactive
sessions, `omp -p`, subagents, RPC and ACP hosts.

## Install

```bash
omp plugin link /Users/leebarry/Projects/omp-firecrawl
omp plugin list
```

`plugin link` symlinks the package into `~/.omp/plugins/node_modules` and marks it
enabled, so the extension, its tools and its skill load for every project. To
remove it: `omp plugin uninstall omp-firecrawl`.

## Auth

Resolution order:

1. `FIRECRAWL_API_KEY` (or `FIRECRAWL_KEY`) — re-read on every request
2. on-disk key cache — `~/.omp/cache/firecrawl/credential.json`, mode `0600`
3. 1Password: `op read op://Dev-Env/Firecrawl/credential`
4. keyless — Firecrawl's unauthenticated mode, heavily rate limited

**Why the cache exists:** every omp session, subagent and `omp -p` run is a new
process, so consulting 1Password per process means a prompt per process. The
cache holds the key for 12h (`FIRECRAWL_CREDENTIAL_CACHE_HOURS`), which turns
that into roughly one `op read` per day for the whole machine. A failed lookup
is retried once, then retried again after a minute rather than pinned.

`/firecrawl` reports the resolved mode, cache path, credits and queue depth.
`/firecrawl refresh` deletes the cache and re-reads from 1Password — use it
after rotating the key. Set `FIRECRAWL_CREDENTIAL_CACHE_HOURS=0` to disable the
cache, or `FIRECRAWL_OP_ENABLED=0` to never invoke `op` at all.

## Tools

`web_search` replaces the built-in tool: same name, superset schema, Firecrawl
behind it, and automatic delegation back to omp's native provider chain if
Firecrawl fails. Set `FIRECRAWL_TAKEOVER_WEB_SEARCH=0` to leave the built-in
alone.

`firecrawl_scrape` and `firecrawl_developer` are top-level. Everything else is
discoverable — read `xd://firecrawl_<name>` for the full schema on demand.

### How every agent reaches Firecrawl

There are three paths, because a subagent's tool set depends on how it was
declared:

1. **Unrestricted sessions and subagents** (interactive, `omp -p`, the bundled
   `task` and `sonic` agents) get all 14 tools, including the `web_search`
   shadow. Nothing to configure.
2. **Restricted agents** — anything with an explicit `tools:` list, such as the
   bundled `scout`, `librarian`, `reviewer`, `designer` and
   `security-reviewer` — resolve the *built-in* `web_search`, not the shadow,
   because a name that collides with a built-in loses in a restricted registry.
   Two things cover them:
   - `firecrawl_search` is the same implementation under a non-colliding name.
     Name it in an agent's `tools:` list (or in `--tools`) to get the full
     Firecrawl search surface.
   - The built-in `web_search` itself is pointed at Firecrawl by
     `providers.webSearchOrder: ["firecrawl"]` plus the key this plugin exports
     into the process environment at session start. So even an agent that only
     knows `web_search` searches through Firecrawl.
3. **Delegation** — the plugin ships a `web-researcher` agent with the complete
   Firecrawl surface. Any agent can hand off to it:
   `task({ context, tasks: [{ agent: "web-researcher", task: "..." }] })`. It
   returns `{ answer, sources[], files[], gaps }` and refuses mutating or
   local-file-upload actions unless the task explicitly asks for them.

To make the built-in chain Firecrawl-first on a machine that has not run this
plugin yet:

```bash
omp config set providers.webSearchOrder '["firecrawl"]'
```

| Tool | Endpoints |
|---|---|
| `web_search` | `POST /search` (shadows the built-in) |
| `firecrawl_search` | `POST /search` (same tool, collision-free name for restricted agents) |
| `firecrawl_scrape` | `POST /scrape`, `GET /scrape/{jobId}` |
| `firecrawl_developer` | `POST /search/developer` |
| `firecrawl_research` | `GET /search/research/papers`, `/{id}`, `/{id}/similar` |
| `firecrawl_map` | `POST /map` |
| `firecrawl_crawl` | `POST /crawl`, `GET/DELETE /crawl/{id}`, `/crawl/{id}/errors`, `/crawl/active`, `POST /crawl/params-preview` |
| `firecrawl_batch` | `POST /batch/scrape`, `GET/DELETE /batch/scrape/{id}`, `/batch/scrape/{id}/errors` |
| `firecrawl_parse` | `POST /parse` |
| `firecrawl_extract` | `POST /extract`, `GET /extract/{id}` |
| `firecrawl_agent` | `POST /agent`, `GET/DELETE /agent/{jobId}`, `/trace`, `/snapshots/{id}` |
| `firecrawl_interact` | `POST/GET /interact`, `POST /interact/{id}/execute`, `DELETE /interact/{id}`, `POST/DELETE /scrape/{jobId}/interact` |
| `firecrawl_monitor` | `POST/GET /monitor`, `GET/PATCH/DELETE /monitor/{id}`, `/run`, `/checks`, `/checks/{id}` |
| `firecrawl_account` | `/team/credit-usage(/historical)`, `/team/token-usage(/historical)`, `/team/queue-status`, `/team/activity`, `GET/PUT /team/threat-protection`, `POST /feedback`, `POST /search/{jobId}/feedback`, `POST /support/ask`, `POST /support/docs-search` |

The bundled `firecrawl` skill tells the model which tool to reach for and how to
avoid burning credits.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `FIRECRAWL_API_KEY` | — | API key; highest priority |
| `FIRECRAWL_API_URL` | `https://api.firecrawl.dev` | Self-hosted or proxied endpoint |
| `FIRECRAWL_OP_REF` | `op://Dev-Env/Firecrawl/credential` | 1Password secret reference |
| `FIRECRAWL_OP_ENABLED` | `1` | Disable the 1Password lookup |
| `FIRECRAWL_CREDENTIAL_CACHE_HOURS` | `12` | Key cache lifetime; `0` disables it |
| `FIRECRAWL_CREDENTIAL_CACHE` | `<cache dir>/credential.json` | Key cache location |
| `FIRECRAWL_TAKEOVER_WEB_SEARCH` | `1` | Register `web_search` over the built-in |
| `FIRECRAWL_INLINE_CHARS` | `12000` | Inline budget before content spills to a file |
| `FIRECRAWL_CACHE_DIR` | `~/.omp/cache/firecrawl` | Spill directory |
| `FIRECRAWL_REQUEST_TIMEOUT_MS` | `120000` | Per-request transport ceiling |
| `FIRECRAWL_JOB_TIMEOUT_MS` | `600000` | Wall-clock ceiling for job polling |

## Large output

Anything longer than the inline budget is written to
`$FIRECRAWL_CACHE_DIR/<date>/<slug>-<stamp>.md` and the tool reports the path
plus a head. HTML, raw HTML, PDF layout blocks and long link lists always spill.
Use `read` with a line range to page through them.

## Development

```bash
bun install
bun run check                                   # typecheck + format + lint
bun scripts/smoke.ts --list                     # registered tools and auth state
bun scripts/smoke.ts firecrawl_map '{"url":"https://docs.firecrawl.dev","limit":5}'
```

`scripts/smoke.ts` runs any tool against the live API through the same modules
the extension loads, which is how each tool is verified.
