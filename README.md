# @korallis/omp-firecrawl

The whole [Firecrawl v2 API](https://docs.firecrawl.dev/api-reference/v2-introduction)
as omp/pi tools, installed once and available in every omp instance: interactive
sessions, `omp -p`, subagents, RPC and ACP hosts.

## Install

```bash
# from npm
omp plugin install @korallis/omp-firecrawl

# or straight from GitHub, no npm needed
omp plugin install github:korallis/omp-firecrawl

omp plugin list
```

Either form runs `bun install` in the omp plugins root
(`~/.omp/plugins/node_modules`) and marks the plugin enabled, so its tools,
skill and agent load in every omp instance: interactive sessions, `omp -p`,
subagents, RPC and ACP hosts. Uninstall with
`omp plugin uninstall @korallis/omp-firecrawl`.

The package has **zero runtime dependencies** — the host provides the schema
builder and the extension API, and every import of them is type-only. Nothing
is compiled: omp loads the TypeScript sources directly through Bun.

Project-scoped install (this repo only, shadowing any user-level copy):

```bash
mkdir -p .omp/plugins && cd .omp/plugins
bun init -y >/dev/null && bun install @korallis/omp-firecrawl
```

Local development copy:

```bash
git clone https://github.com/korallis/omp-firecrawl && cd omp-firecrawl
bun install
omp plugin link "$PWD"
```

## Auth

**Three ways to set a key. 1Password is optional and off the critical path.**

```bash
# 1. omp's own plugin settings — persists across sessions, masked in output
omp plugin config set @korallis/omp-firecrawl apiKey fc-your-key
omp plugin config list @korallis/omp-firecrawl
```

```
# 2. in a session
/firecrawl login fc-your-key
```

```bash
# 3. environment
export FIRECRAWL_API_KEY=fc-your-key
```

Option 1 stores it in omp's plugin lockfile
(`~/.omp/plugins/omp-plugins.lock.json`) and is the right choice on a server or
for anyone who has never used 1Password. Option 2 writes
`~/.omp/firecrawl/credential` mode `0600`; `/firecrawl logout` removes it.

Resolution order:

1. `FIRECRAWL_API_KEY` (or `FIRECRAWL_KEY`) — re-read on every request
2. plugin setting `apiKey` — user scope, then project `.omp/plugin-overrides.json`
3. the key file (`FIRECRAWL_KEY_FILE` overrides the path)
4. a cached 1Password read — `~/.omp/cache/firecrawl/credential.json`, `0600`
5. 1Password: `op read op://Dev-Env/Firecrawl/credential`
6. keyless — Firecrawl's unauthenticated mode, heavily rate limited

Steps 4 and 5 exist only so a machine that *does* keep the key in 1Password
does not have to store a copy. They are attempted at most **once per process**,
behind a 3s `op --version` preflight and a 10s read timeout, never on the
startup path, and are abandoned for the rest of the process the moment they
fail. A box with no `op`, or an `op` that cannot reach a vault, costs nothing
and is reported as informational rather than as an error. Set
`FIRECRAWL_OP_ENABLED=0` to skip 1Password entirely.

`/firecrawl` lists **every** source with its current state, so there is no
guessing about where to put a key:

```
auth: keyless

where a key can come from, in priority order:
  env FIRECRAWL_API_KEY: not set
  plugin setting apiKey: not set — omp plugin config set @korallis/omp-firecrawl apiKey fc-...
  key file /home/you/.omp/firecrawl/credential: not created — /firecrawl login fc-...
  1Password op://Dev-Env/Firecrawl/credential: unavailable (1Password CLI unavailable) — optional
```

`/firecrawl refresh` drops cached credentials and re-resolves — use it after
rotating a key, or right after `omp plugin config set`. It never deletes your
key file; `/firecrawl logout` does.

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
| `FIRECRAWL_KEY_FILE` | `~/.omp/firecrawl/credential` | Key written by `/firecrawl login` |
| plugin setting `apiKey` | — | `omp plugin config set @korallis/omp-firecrawl apiKey fc-...` |
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

`scripts/` and `tests/` are development-only and are not published; the
package ships `src/`, `agents/`, `skills/`, `README.md` and `LICENSE`.

### Releasing

```bash
bun run check                       # must be green
bun pm pack                         # inspect the tarball contents
npm publish                         # publishConfig.access is already "public"
                                    # the account has 2FA on publish: npm will
                                    # prompt for an OTP, or use --otp=<code>.
                                    # For CI, use a granular token scoped to
                                    # @korallis/* with "bypass 2FA" enabled.
git tag "v$(jq -r .version package.json)" && git push --tags
```

Bump `version` **and** the `omp.version` / `pi.version` mirrors in
`package.json` together — the plugin loader overwrites the manifest version
from the package version, so a mismatch is silently ignored rather than
reported.
