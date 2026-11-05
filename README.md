# insta-crawler-js

JavaScript (Node 22, ES modules) port of `../insta-crawler`, without D1 (logged-out HTTP), D2 (logged-out browser) and D4 (instagrapi private API). Output JSON uses the same snake_case `InstagramMedia` shape as the Python version, so results can be compared directly.

| Method | Command | Login | What it can fetch |
|---|---|---|---|
| D3 Logged-in browser | `login-browser`, `browser-auth`, `sessions` | Burner account | Hashtag feed, Explore, Reels feed, keyword search, profile, location |
| Apify | `provider apify ...` | API token | hashtag, search, profile_posts, post |
| SocialCrawl | `provider socialcrawl ...` | API key | trending, hashtag, hashtag_recent, search, profile_posts, post |
| HikerAPI | `provider hikerapi ...` | API key | hashtag, search (via best hashtag match), profile_posts (reels), post |
| All 3rd party | `compare <capability> <target>` | API keys | Same request on each provider, side by side |
| Hashtag batch | `hashtag-batch --method <provider>` | API key | Top + recent per hashtag, deduped, ranked by engagement/hour |

## Setup

```bash
cd ~/projects/insta-crawler-js
npm install
npx patchright install chromium
cp .env.example .env
npm test
```

`.env` keys: `APIFY_TOKEN`, `SOCIALCRAWL_API_KEY`, `HIKERAPI_KEY`. Only fill the ones you use.

## D3: logged-in browser

```bash
node src/cli.js login-browser burner_a --proxy http://user:pass@host:port
node src/cli.js sessions
node src/cli.js browser-auth hashtag balayage --session burner_a --headed
node src/cli.js browser-auth hashtag balayage --enrich browser --enrich-limit 10
node src/cli.js browser-auth search "ăn vặt hà nội"
```

- Session files (`sessions/<name>.json`, Playwright storage state) and `sessions/pool_state.json` use the same format as the Python project, so existing sessions can be copied over.
- A session that lands on a challenge or login page is cooled down for 24h.
- `--enrich browser` opens each post with the logged-in session to fill likes/comments. Default is `none` (the Python default, logged-out enrichment, depended on D1).

## 3rd-party APIs

```bash
node src/cli.js provider socialcrawl hashtag balayage --limit 5
node src/cli.js provider socialcrawl hashtag_recent balayage --limit 5
node src/cli.js provider hikerapi post DdeRysim9zK --raw
node src/cli.js compare hashtag balayage --limit 20
node src/cli.js hashtag-batch --method socialcrawl --limit 20
```

Results go to `results/` (`compare` writes `compare.json`). Add `--print` to also print the JSON.

## Layout

```
src/
  cli.js              all commands
  browser-capture.js  headless capture, browser enrichment, manual login   (D3)
  session-pool.js     session rotation, per-session proxy, cooldown, target URLs (D3)
  hashtag-batch.js    multi-hashtag collection and ranking
  providers/          apify.js, socialcrawl.js, hikerapi.js, shared base.js
  parsers.js          shape-agnostic normalization of Instagram JSON
  json-tools.js       JSON walking, embedded <script> JSON extraction
  models.js           InstagramMedia shape
test/                 node:test, run with `npm test`
```
