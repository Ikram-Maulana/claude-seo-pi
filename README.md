# claude-seo-pi

[claude-seo](https://github.com/AgriciDaniel/claude-seo) ported to the [pi](https://pi.dev) and [omp](https://omp.sh) coding agents.

33 SEO skills, 20 specialist agents and 50+ Python tools covering technical SEO,
content quality (E-E-A-T), schema markup, GEO/AI search, local SEO, backlinks,
rank tracking and drift monitoring.

## Install

```bash
# pi
pi install npm:claude-seo-pi

# omp
omp plugin install claude-seo-pi
```

### Requirements

| | Needed for | Notes |
|---|---|---|
| **Python 3.10+** | every skill | Required. `/seo setup` builds an isolated virtualenv; it never touches your global site-packages. |
| **Node 22+** | the MCP-backed integrations | Only to run those MCP servers. Not needed for the rest, though the ones below already require 22 themselves. |
| **[pi-subagents](https://www.npmjs.com/package/pi-subagents)** ≥ 0.66.0 | the 20 specialist agents | **pi only.** Install separately, see below. |

Everything else (BeautifulSoup, Playwright/Chromium, Google API clients,
matplotlib/WeasyPrint) is installed into the managed virtualenv by `/seo setup`.

**Provision the runtime once.** Neither `pi install` nor `omp plugin install`
runs provisioning steps, so the Python environment is created on demand:

```
/seo setup      # creates the venv and Chromium (a few hundred MB, one time)
/seo doctor     # read-only check; prints core and Chromium status separately
```

`/seo setup` is idempotent, and the environment lives in a per-user data
directory (`~/.local/share/claude-seo` on Linux, `~/Library/Application
Support/claude-seo` on macOS, `%LOCALAPPDATA%\claude-seo` on Windows), so it
survives package upgrades and is shared between pi and omp.

**On pi, install the subagent extension too:**

```bash
pi install npm:pi-subagents
```

This is what makes the 20 specialist agents dispatchable. It is deliberately not
a dependency of this package: pi does not register a *dependency* as a package,
so a bundled copy would be installed but never loaded, and would risk shadowing
your own. Without it every skill still works; audits simply run sequentially
instead of delegating in parallel. omp has native agent support and needs
nothing extra.

### Verify

```
/seo doctor
```

Expect `"ready": true`. On pi, `pi list` should show `claude-seo-pi`; on omp,
`omp plugin list` and `omp plugin doctor`.

## Quick start

```
# first run, once
/seo setup

# audit a site (delegates to specialist agents in parallel)
/seo audit https://example.com

# or a single page
/seo page https://example.com/pricing
```

A full audit detects the business type (SaaS, local, e-commerce, publisher,
agency), spawns the relevant specialists, and returns a scored report with
findings bucketed Critical / High / Medium / Low plus a sequenced action plan.
Expect it to take a few minutes: it fetches pages, parses HTML, and may run
Lighthouse. Narrow commands are much faster: `/seo schema <url>` or
`/seo sitemap <url>` return in seconds and touch a single concern.

**Nothing here requires an API key.** Without credentials, Core Web Vitals are
lab estimates and indexation is inferred from page signals. Google API
credentials add real field data; MCP extensions add competitive and AI-citation
data. Both are opt-in.

## Commands

Every skill is also directly invocable as `/skill:seo-<name>`.

### Analysis

| Command | What it does |
|---|---|
| `/seo audit <url>` | Full site audit, parallel subagent delegation, health score |
| `/seo page <url>` | Deep single-page analysis |
| `/seo technical <url>` | Crawlability, indexability, security, URLs, mobile, CWV, rendering |
| `/seo content <url>` | E-E-A-T, readability, thin content, AI citation readiness |
| `/seo content-brief <topic> [page-type]` | Competitive content brief with per-section word counts |
| `/seo schema <url>` | Schema.org detection, validation, generation |
| `/seo sitemap <url or generate>` | Sitemap analysis or generation |
| `/seo images <url>` | Alt text, formats, lazy loading, CLS, image SERP |
| `/seo geo <url>` | AI Overviews, ChatGPT, Perplexity visibility |
| `/seo agentic [audit\|fix\|lighthouse\|refresh] <url>` | Agent readiness: WebMCP, Lighthouse agentic browsing |
| `/seo hreflang <url>` | International SEO and hreflang validation |
| `/seo sxo <url> [keyword]` | Search Experience Optimization, SERP backwards analysis |
| `/seo ecommerce <url or keyword>` | Product schema, Shopping and marketplace visibility |
| `/seo local <url>` | Google Business Profile, NAP, citations, reviews |
| `/seo competitor-pages [url or generate] [competitor]` | "X vs Y" comparison pages |
| `/seo cluster <seed-keyword or url>` | SERP-overlap topic clustering, hub-and-spoke design |
| `/seo plan <business-type>` | Strategic planning for saas, local, ecommerce, publisher, agency |
| `/seo programmatic <url or plan>` | Pages at scale, index bloat safeguards |
| `/seo backlinks <url>` | Backlink profile, anchors, toxic signals, disavow |
| `/seo drift baseline\|compare\|history <url>` | Capture and diff SEO baselines over time |
| `/seo flow [stage] [url]` | FLOW framework: find, leverage, optimize, win |

### Integrations

These need credentials or an MCP server, see [Optional integrations](#optional-integrations).

| Command | Needs |
|---|---|
| `/seo google <command> <url>` | Google API key (Tier 0); service account for Tier 1+ |
| `/seo dataforseo <command> <query>` | DataForSEO MCP |
| `/seo firecrawl <command> <url>` | Firecrawl MCP |
| `/seo maps <command> <url\|keyword\|location>` | Free tier works; DataForSEO unlocks more |
| `/seo ahrefs <command> <url>` | Ahrefs MCP |
| `/seo bing <command> <url>` | Bing Webmaster key |
| `/seo matomo <command>` | Matomo URL + token |
| `/seo profound <command>` | Profound key |
| `/seo seranking <command>` | SE Ranking key |
| `/seo unlighthouse <url>` | Node only, no key |
| `/seo image-gen [type] <description>` | Gemini key via nanobanana MCP |

`/seo google` alone has 20+ subcommands (`pagespeed`, `crux`, `crux-history`,
`gsc`, `inspect`, `sitemaps`, `index`, `ga4`, `ga4-pages`, `keywords`, `volume`,
`youtube`, `nlp`, `entities`, `safety`, `quotas`, `report`, …). Run
`/seo google setup` for the credential walkthrough.

### Maintenance

| Command | What it does |
|---|---|
| `/seo setup` | Create or refresh the managed Python runtime and Chromium |
| `/seo doctor` | Read-only health check; reports core and Chromium separately |

## Optional integrations

All optional. Each is off until you configure it; the skill tells you when its
prerequisite is missing. Every installer section below is what the upstream
`install.sh` scripts would have configured; those write to `~/.claude.json`,
which pi and omp do not read, so the equivalent lives here instead.

### Google APIs (free, no MCP server)

Four additive tiers. Start at Tier 0 with one API key; add access only when a
workflow needs it.

| Tier | Credential | Unlocks |
|---|---|---|
| **0** | API key | PageSpeed Insights, CrUX, CrUX History (25-week trends) |
| **1** | + service account or `gcloud` sign-in | + Search Console, URL Inspection, sitemaps, Indexing API |
| **2** | + GA4 property ID | + organic traffic, landing pages, device/country breakdown |
| **3** | + Ads developer token | + Keyword Planner search volume and competition |

All four are free within Google's normal quota limits; you supply your own
Google Cloud project. For Tier 0, go to
[console.cloud.google.com](https://console.cloud.google.com), enable
**PageSpeed Insights API** and **Chrome UX Report API** in your project, create
an API key restricted to those two, and write it to
`~/.config/claude-seo/google-api.json` (`chmod 600`):

```json
{ "api_key": "AIza..." }
```

For Tier 1+, add a service account: download its JSON key, and add its
`client_email` as a user on the Search Console property (Full, or Owner for the
Indexing API) and as a Viewer on the GA4 property. Credentials can also come
from the environment (`GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`,
`GA4_PROPERTY_ID`, `GSC_PROPERTY`). Check what you unlocked with
`/seo google setup` and `/seo google quotas`. If a service account cannot see a
property you own, `gcloud auth application-default login` is the fallback;
`CLAUDE_SEO_GOOGLE_AUTH=adc` prefers it.

The Indexing API only accepts eligible `JobPosting` pages and `BroadcastEvent`
pages embedded in `VideoObject`; a notification is not a guarantee of indexing.
CrUX returns data only when a URL or origin has enough eligible Chrome traffic.

### MCP servers

MCP config is per-runtime. pi reads it through
[pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter) (`pi install npm:pi-mcp-adapter`),
which accepts the standard `.mcp.json` envelope:

| Runtime | Config file |
|---|---|
| pi (user) | `~/.pi/agent/mcp.json` or `~/.config/mcp/mcp.json` |
| pi (project) | `.pi/mcp.json` or `.mcp.json` |
| omp | `~/.omp/agent/mcp.json` |

Add the servers you want under `mcpServers`:

```json
{
  "mcpServers": {
    "firecrawl-mcp": {
      "command": "npx",
      "args": ["-y", "firecrawl-mcp@3.11.0"],
      "env": { "FIRECRAWL_API_KEY": "fc-..." }
    },
    "dataforseo": {
      "command": "npx",
      "args": ["-y", "dataforseo-mcp-server@2.8.10"],
      "env": {
        "DATAFORSEO_USERNAME": "...",
        "DATAFORSEO_PASSWORD": "...",
        "ENABLED_MODULES": "SERP,KEYWORDS_DATA,ONPAGE,DATAFORSEO_LABS,BACKLINKS,DOMAIN_ANALYTICS,BUSINESS_DATA,CONTENT_ANALYSIS,AI_OPTIMIZATION"
      }
    },
    "ahrefs": {
      "command": "npx",
      "args": ["--yes", "--package=@ahrefs/mcp@0.0.11", "mcp"],
      "env": { "AHREFS_API_TOKEN": "..." }
    },
    "nanobanana-mcp": {
      "command": "npx",
      "args": ["-y", "@ycse/nanobanana-mcp@1.1.1"],
      "env": { "GOOGLE_AI_API_KEY": "..." }
    }
  }
}
```

Restart the session, then verify with `/mcp` in pi or your omp MCP command. The
skill checks for its tools before use and tells you if the server is missing.

### Environment variables

These integrations need no MCP server, only credentials:

| Integration | Variable | Where |
|---|---|---|
| Bing Webmaster + IndexNow | `BING_WEBMASTER_API_KEY`, `INDEXNOW_KEY`, `INDEXNOW_KEY_LOCATION` | your shell env, or the runtime's settings `env` block |
| Profound | `PROFOUND_API_KEY` | same |
| SE Ranking | `SERANKING_API_KEY` | same |
| Matomo | `MATOMO_URL`, `MATOMO_API_TOKEN`, `MATOMO_SITE_ID` | same, or `~/.config/claude-seo/matomo.json` (`0600`) |
| Unlighthouse | none | needs only Node 22.18+; no key |

Three runtime variables are set for you by the extension, documented here only
because setting them yourself overrides the default:

| Variable | Default | Effect |
|---|---|---|
| `SEO_PLUGIN_ROOT` | the installed package root | Where skills resolve `$SEO_PLUGIN_ROOT/scripts/claude-seo`. Set at extension load. |
| `CLAUDE_SEO_DATA_DIR` | `~/.local/share/claude-seo` (Linux) | Where the managed venv and Chromium live. Point it somewhere shared to reuse one runtime across installs. |
| `CLAUDE_SEO_PYTHON` | autodetected | An explicit Python 3.10+ interpreter, for a `pyenv`/`conda` setup the autodetect misses. |

## Skills

`seo` (orchestrator) · `seo-agentic` · `seo-ahrefs` · `seo-audit` · `seo-backlinks`
· `seo-bing` · `seo-cluster` · `seo-competitor-pages` · `seo-content` ·
`seo-content-brief` · `seo-dataforseo` · `seo-drift` · `seo-ecommerce` ·
`seo-firecrawl` · `seo-flow` · `seo-geo` · `seo-google` · `seo-hreflang` ·
`seo-image-gen` · `seo-images` · `seo-local` · `seo-maps` · `seo-matomo` ·
`seo-page` · `seo-plan` · `seo-profound` · `seo-programmatic` · `seo-schema` ·
`seo-seranking` · `seo-sitemap` · `seo-sxo` · `seo-technical` · `seo-unlighthouse`

Each skill's own `references/` directory holds the detail for that domain.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `$SEO_PLUGIN_ROOT` expands to nothing | The extension did not load. Check `pi list` / `omp plugin list` and restart the session. |
| "runtime is not ready" from any skill | Run `/seo setup`. Do not `pip install` by hand. |
| Chromium missing but core is fine | Rendered-page features are degraded; raw-fetch analysis still works. Re-run `/seo setup` to retry Chromium. |
| MCP tools not available | The server is not connected. Verify the entry and restart the session. |
| `403 Forbidden` on GSC or GA4 | The service account `client_email` is not a user on the Search Console property, or a Viewer on the GA4 property. |
| `404` on CrUX | Not enough Chrome traffic for that URL or origin. Not a credentials problem. |
| `429` | Quota hit. Wait and retry; check `/seo google quotas`. |
| Agents not dispatchable on pi | `pi install npm:pi-subagents`, then restart. |
| omp agents run at `high` while your session is `max` | Agents inherit the model, not the thinking level. Run `omp config set defaultThinkingLevel max`. |
| A skill cites a file that does not exist | Upstream drift. Please open an issue. |

## Uninstall

```bash
# pi
pi remove npm:claude-seo-pi

# omp
omp plugin uninstall claude-seo-pi
```

The managed Python environment is not removed: delete the per-user data directory
listed under [Install](#install) (or your `CLAUDE_SEO_DATA_DIR`) to reclaim the
disk. Credentials under `~/.config/claude-seo/` are likewise left alone.

## Contributing

This is a port, not a fork: the upstream plugin is vendored at a pinned tag and
transformed at build time, and the generated trees (`skills/`, `agents/`,
`scripts/`, `extensions/`) are rebuilt on every sync, so edit them upstream or in
`tools/sync.mjs`, never in place.

**[CONTRIBUTING.md](CONTRIBUTING.md)** covers the build, the test suites, the
rules the build enforces, and the upstream findings this port deliberately does
not patch.

## Credits

Ported from [claude-seo](https://github.com/AgriciDaniel/claude-seo) v2.4.2 by
[AgriciDaniel](https://github.com/AgriciDaniel), MIT licensed. Upstream
contributors include Lutfiya Miller (seo-cluster), Florian Schmitz (seo-sxo),
Dan Colta (seo-drift) and Chris Muller (seo-hreflang).
