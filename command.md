# Commands

Run from the project folder: `node src/cli.js <command> [args] [options]`.
`node src/cli.js` lists commands; `node src/cli.js <command> --help` shows one command's options.

Results are saved to `results/<command>_<target>_<timestamp>.json` unless noted.

## Options shared by several commands

| Option | Default | What it does |
|---|---|---|
| `--output <file>` | auto | Save the JSON to this path instead of `results/...` |
| `--print` | off | Also print the JSON to the terminal |
| `--proxy <url>` | none | Proxy for the browser, e.g. `http://user:pass@host:port` or `socks5://host:port` |
| `--headed` | off | Open a visible browser window (default runs hidden) |
| `--load-media` | off | Load images, videos and fonts. By default they are blocked to load faster; data is the same either way |

---

## D3: logged-in browser (session pool)

### `login-browser <session_name>`
Opens a browser at the Instagram login page. Log in yourself (including any SMS/email check), then press Enter in the terminal. Cookies are saved to `sessions/<session_name>.json`.

```bash
node src/cli.js login-browser burner_a
node src/cli.js login-browser burner_b --proxy http://user:pass@host:port
```

| Option | Default | What it does |
|---|---|---|
| `--proxy <url>` | none | Proxy for this account; saved with the session and reused by `browser-auth` |
| `--sessions-dir <dir>` | `sessions` | Where session files are stored |

### `sessions`
Shows every saved session: uses, challenges, whether it's available, cooldown minutes left.

```bash
node src/cli.js sessions
```

| Option | Default | What it does |
|---|---|---|
| `--sessions-dir <dir>` | `sessions` | Where session files are stored |

### `browser-auth <kind> [value]`
Opens a page with a logged-in session, scrolls, and captures the posts Instagram loads.

```bash
node src/cli.js browser-auth hashtag balayage
node src/cli.js browser-auth explore
node src/cli.js browser-auth reels
node src/cli.js browser-auth search "ăn vặt hà nội"
node src/cli.js browser-auth profile natgeo --session burner_a
node src/cli.js browser-auth location 212988663
node src/cli.js browser-auth hashtag balayage --enrich browser --enrich-limit 10 --show-fields
```

| Kind | Value | Page opened |
|---|---|---|
| `hashtag` | tag name (with or without `#`) | `/popular/<tag>/` |
| `explore` | none | `/explore/` (personalized per account) |
| `reels` | none | `/reels/` (personalized per account) |
| `search` | keyword | `/explore/search/keyword/?q=<keyword>` |
| `profile` | username | `/<username>/` |
| `location` | location id | `/explore/locations/<id>/` |

| Option | Default | What it does |
|---|---|---|
| `--session <name>` | auto | Use this session. Default picks the least recently used session not in cooldown |
| `--sessions-dir <dir>` | `sessions` | Where session files are stored |
| `--scrolls <n>` | 3 | How many times to scroll down |
| `--ignore-cooldown` | off | Allow auto-pick to choose a session in its 24h challenge cooldown |
| `--enrich <browser\|none>` | `none` | `browser`: open each post with the session to fill likes/comments |
| `--enrich-limit <n>` | 24 | Max posts to open when `--enrich browser` |
| `--show-fields` | off | Print every count/play/view field Instagram sent (to see which metrics are available) |
| `--proxy <url>` | session's proxy | Override the proxy saved with the session |
| `--headed`, `--load-media`, `--output`, `--print` | | See shared options |

A session that lands on a challenge or login page gets a 24h cooldown. Run `login-browser <name>` again to resolve it.

---

## 3rd-party APIs (Apify, SocialCrawl, HikerAPI)

Need keys in `.env`: `APIFY_TOKEN`, `SOCIALCRAWL_API_KEY`, `HIKERAPI_KEY`.

### Capabilities

| Capability | Target | apify | socialcrawl | hikerapi |
|---|---|---|---|---|
| `trending` | none | no | global trending reels (deduped) | no |
| `hashtag` | tag name | top posts | top posts | top posts |
| `hashtag_recent` | tag name | no | recent posts | no |
| `search` | keyword | posts of the best-matching hashtag | reels search | posts of the best-matching hashtag |
| `profile_posts` | username or profile URL | posts | posts | reels only |
| `post` | shortcode or post URL | one post | one post | one post |

### `provider <apify|socialcrawl|hikerapi> <capability> [target]`
Calls one provider.

```bash
node src/cli.js provider socialcrawl trending --limit 30
node src/cli.js provider socialcrawl hashtag_recent balayage --limit 5
node src/cli.js provider apify profile_posts natgeo --limit 10
node src/cli.js provider hikerapi post DdeRysim9zK --raw
```

| Option | Default | What it does |
|---|---|---|
| `--limit <n>` | 20 | Max posts to return |
| `--raw` | off | Include the provider's original responses in the JSON |
| `--output`, `--print` | | See shared options |

### `compare <capability> [target]`
Runs the same request on each provider and prints one line per provider: items, field coverage (0-1), seconds, cost. Unsupported capabilities show `not supported`.

```bash
node src/cli.js compare hashtag balayage --limit 20
node src/cli.js compare search "phở" --providers socialcrawl,hikerapi
```

| Option | Default | What it does |
|---|---|---|
| `--providers <a,b>` | all three | Comma list of providers to run |
| `--limit <n>` | 20 | Max posts per provider |
| `--raw` | off | Include original responses |
| `--output <file>` | `compare.json` | Where to save the full results |

### `hashtag-batch --method <socialcrawl|hikerapi|apify>`
For each hashtag, fetches top posts (and recent where the provider supports it), removes duplicates, and ranks posts by engagement per hour. Saves to `results/hashtags_<method>_<timestamp>.json`.

```bash
node src/cli.js hashtag-batch --method socialcrawl --limit 20
node src/cli.js hashtag-batch --method hikerapi --hashtags balayage,curlyhair --rankings top
```

| Option | Default | What it does |
|---|---|---|
| `--method <name>` | required | Provider to use |
| `--hashtags <a,b>` | `balayage,haircolor,copperhair,curlyhair,hairtok,bondrepair` | Hashtags to fetch |
| `--rankings <a,b>` | `top,recent` | Feeds per hashtag. Unsupported ones (e.g. `recent` on hikerapi/apify) are skipped |
| `--limit <n>` | 30 | Posts per hashtag per ranking |
| `--pause <seconds>` | 2 | Wait between requests |
| `--output <file>` | auto | Where to save the results |
