# 🍪 Cookies & Authentication Guide

This proxy talks to [vibes.ai](https://vibes.ai) using **browser cookies** — vibes.ai has no official API, no API keys, and no OAuth client you can register. Authentication is exactly what your browser does: a vibes.ai session cookie, optionally backed by your Meta login cookies for automatic renewal.

There are **two credentials** you may need to supply:

| Variable | Domain it comes from | Required? | What it does |
|---|---|---|---|
| `VIBES_META_SESSION` | `vibes.ai` | Yes* | Your vibes.ai session (`meta_session` cookie). Authenticates every call to vibes.ai. |
| `AUTH_META_COOKIES` | `auth.meta.com` | No (recommended) | Meta login cookies. Enable **automatic re-login** when the vibes session expires. |

\* Not required if you use [bring-your-own-cookie mode](#auth-modes) — where each client sends its own vibes cookie as the Bearer token.

> 📌 **Short version:** `VIBES_META_SESSION` gets you in the door; `AUTH_META_COOKIES` keeps you in when the first one expires (~30 min idle).

---

## Part 1 — `VIBES_META_SESSION`

### What it is

vibes.ai authenticates you with a single cookie named `meta_session`. Its value is a long token that looks like:

```
e60e910a-242a-4a5c-9d0c-a41b52d9f8ae.b6XqfLm2RtYw3nKj8vHs5zEe9wQq4rTt7uIi6oPp0aSd1fGg
```

(a UUID, a dot, then a ~40-character signature — one single line, no spaces or quotes).

### How to get it (DevTools — Application tab)

1. Log in at **[vibes.ai](https://vibes.ai)** in Chrome / Edge / Firefox (it currently requires a Meta/Facebook account).
2. Press **F12** (or right-click → *Inspect*) to open DevTools.
3. Go to the **Application** tab (Firefox: **Storage** tab).
4. In the left sidebar expand **Cookies** → click **`https://vibes.ai`**.
5. Find the row named **`meta_session`** in the table.
6. Double-click the **Value** cell, select the whole value, and copy it (Ctrl/Cmd+C).
   <br>⚠️ Copy the **Value** column, not the Name column. The value is one long string — make sure you got all of it (resize the cell if needed).
7. That string **is** your `VIBES_META_SESSION`.

### Alternative: Network tab (handy if the Application tab hides long values)

1. With vibes.ai open, open DevTools → **Network** tab.
2. Refresh the page (F5), then click any request sent to `vibes.ai/api/...` (e.g. `me` or `projects`).
3. In the request details open **Headers** → **Request Headers** → find the **`Cookie:`** header.
4. Copy just the part after `meta_session=` up to the first `;` (or to the end if it's the last cookie):

   ```
   Cookie: meta_session=e60e910a-242a-....fGg; cookie_ack=true
                        └────────────── copy this part ──────────────┘
   ```

### How to set it

**Cloudflare Workers (production — the recommended deploy):**

```bash
npx wrangler secret put VIBES_META_SESSION
# paste the cookie value when prompted, press Enter
npx wrangler deploy
```

Or in the dashboard: **Workers & Pages → your worker → Settings → Variables and Secrets → Add → Type: Secret** (name `VIBES_META_SESSION`, value = the cookie). Secrets are encrypted at rest and never appear in logs.

**Local dev with `wrangler dev` (miniflare):**

```bash
cp .dev.vars.example .dev.vars     # then edit .dev.vars:
```

```bash
# .dev.vars  (gitignored — never commit it)
VIBES_META_SESSION="e60e910a-242a-....fGg"
AUTH_META_COOKIES="ps_n=1; ps_l=1; datr=Bxxx...; fs=1; locale=en_GB"
```

**Node / Bun / Deno:**

```bash
VIBES_META_SESSION="e60e910a-242a-....fGg" npm run start:node
```

**Docker / Render / Railway / Fly.io** — set it as a plain environment variable in the service config:

```bash
docker run -e VIBES_META_SESSION="e60e910a-242a-....fGg" ...
```

**Bring-your-own-cookie mode** — don't set it on the server at all; each client passes *their own* cookie as the Bearer token:

```bash
curl https://your-worker.workers.dev/v1/models \
  -H "Authorization: Bearer e60e910a-242a-....fGg"
```

---

## Part 2 — `AUTH_META_COOKIES` (optional, enables auto re-login)

### What it is

Your vibes.ai session expires (~30 min idle). The web app silently re-authenticates through Meta's OIDC flow (vibes.ai → auth.meta.com → back). This proxy can **replay that same flow** — but to do it, it needs your **auth.meta.com cookies** (the Meta login session of the same browser profile).

With `AUTH_META_COOKIES` set, a `401` from vibes.ai triggers an automatic re-login: the proxy mints a fresh `meta_session`, retries your original request once, and your OpenAI-style client never sees the error.

### How to get it (DevTools — Application tab)

1. **Same browser, still logged in to vibes.ai** (the Meta cookies must belong to the same session).
2. Open DevTools (F12) → **Application** tab → **Cookies**.
3. This time click **`https://auth.meta.com`** in the left sidebar.
   <br>*(If you don't see it: visit `https://auth.meta.com` once in that browser, then reopen the tab.)*
4. You'll see several cookies, typically including `ps_n`, `ps_l`, `datr`, `fs`, `locale` (exact set varies by account).
5. Build a single string of `name=value` pairs joined by `; ` (semicolon + space), e.g.:

   ```
   ps_n=1; ps_l=1; datr=Bxxxxxxx...; fs=1; locale=en_GB
   ```

   Double-click each **Value** cell to copy it exactly. Watch out — `datr` values are long; make sure the cell is fully selected.

### Easier alternative: Network tab (recommended — one copy-paste)

1. Open vibes.ai, DevTools → **Network** tab.
2. Refresh the page (F5) and let it load.
3. Look for a request whose domain is **`auth.meta.com`** (filter by "auth" if needed — it appears during the login/refresh redirect chain; if nothing shows, log out and back in to vibes.ai while the Network tab records).
4. Click that request → **Headers** → **Request Headers** → **`Cookie:`**.
5. Right-click the cookie header value → **Copy value**. That entire string is exactly what `AUTH_META_COOKIES` wants:

   ```
   Cookie: ps_n=1; ps_l=1; datr=Bxxx...; fs=1; locale=en_GB
           └──────────── copy the whole thing after "Cookie: " ───────────┘
   ```

   Because the proxy replays your browser's exact `Cookie` header against `auth.meta.com`, the raw header copy is the most reliable format.

### Format rules

- One line, `name=value` pairs separated by `; ` (semicolons).
- **No** `Cookie:` prefix, **no** quotes in the value itself (quotes around the whole string in `.dev.vars`/shell are fine).
- If you copied it from a request header, keep it byte-for-byte.

### How to set it

Setting it **automatically enables auto re-login** — no other flag needed.

**Cloudflare Workers (production):**

```bash
npx wrangler secret put AUTH_META_COOKIES
# paste the full cookie string, press Enter
npx wrangler deploy
```

Or dashboard: **Settings → Variables and Secrets → Add → Type: Secret** (name `AUTH_META_COOKIES`).

**Local dev** — add it to `.dev.vars` (see above).

**Node / Docker / Render / Railway / Fly** — plain environment variable:

```bash
VIBES_META_SESSION="e60e910a-242a-....fGg" \
AUTH_META_COOKIES="ps_n=1; ps_l=1; datr=Bxxx...; fs=1; locale=en_GB" \
npm run start:node
```

**In code** (if you embed the client directly):

```ts
import { VibesClient } from "./src/vibes.js";

const client = new VibesClient(metaSession, {
  authMetaCookies: "ps_n=1; ps_l=1; datr=Bxxx...; fs=1; locale=en_GB",
  // autoRelogin defaults to true when authMetaCookies is provided
});
```

### How the auto re-login works (what you're enabling)

When a vibes.ai call returns `401`:

1. The proxy hits `GET /api/meta-oidc/start` on vibes.ai → gets a redirect to `auth.meta.com` (+ a CSRF cookie).
2. It follows that redirect **sending your `AUTH_META_COOKIES` as the Cookie header** → Meta answers with an auth-code redirect (302).
3. It exchanges the code at `auth.meta.ai/ecto` → redirect back to `vibes.ai`.
4. vibes.ai sets a **fresh `meta_session`** cookie → the proxy swaps it in and retries your original call once.

Concurrent 401s share a single in-flight re-login attempt. If Meta's cookies are themselves expired or rate-limited (a `400` from auth.meta.com), the re-login gives up after 3 tries and the normal `401` surfaces — re-grab cookies from the browser then.

> **Workers note:** unlike the Python server, there is no cookie file on Workers (no writable disk). The fresh `meta_session` lives in the per-isolate client cache only. With `AUTH_META_COOKIES` set, that's fine — new sessions are minted on demand.

---

## Auth modes (how the Bearer token relates to cookies)

The proxy decides per-request:

| Server config | What clients send | Which vibes session is used |
|---|---|---|
| `VIBES_API_KEY` **and** `VIBES_META_SESSION` set | `Authorization: Bearer <VIBES_API_KEY>` | The server-side `VIBES_META_SESSION` (cookie never leaves the server) — **recommended** |
| Only `VIBES_META_SESSION` set | Any (or no) Bearer token | The server-side `VIBES_META_SESSION` |
| Neither set | `Authorization: Bearer <vibes meta_session cookie>` | Each client's own cookie (bring-your-own-cookie) |

`AUTH_META_COOKIES` (if set) applies to whichever session the server uses — in bring-your-own-cookie mode it renews each client's own cookie.

## Environment variable reference

| Name | Where | Required | Purpose |
|---|---|---|---|
| `VIBES_META_SESSION` | secret / env | yes* | vibes.ai `meta_session` cookie value. |
| `AUTH_META_COOKIES` | secret / env | no | auth.meta.com cookie string — enables automatic OIDC re-login. |
| `VIBES_API_KEY` | secret / env | no | If set, clients must send this as the Bearer token instead of the cookie. |
| `VIBES_BASE_URL` | var (`wrangler.toml [vars]`) / env | no | Override upstream (default `https://vibes.ai`). |
| `CORS_ORIGIN` | var / env | no | Reserved for CORS restriction (default: allow all). |

**Secret vs var on Cloudflare:** cookies and API keys must be **Secrets** (`wrangler secret put` / dashboard "Secret" type) — encrypted, hidden from logs and `wrangler.toml`. Only non-sensitive settings belong in `[vars]`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `401` right away | Bad/typo'd `meta_session` | Re-copy from DevTools; watch for truncated values. |
| `401` after ~30 min idle, no `AUTH_META_COOKIES` | Session expired | Re-grab `VIBES_META_SESSION`, or set `AUTH_META_COOKIES` for auto re-login. |
| `401` even with `AUTH_META_COOKIES` | Meta cookies also expired (re-login got `400`) or auth.meta.com rate-limited | Log in to vibes.ai again in the browser, re-copy **both** credentials. |
| `wrangler dev` ignores your cookie | `.dev.vars` missing or misnamed | Must be `.dev.vars` in the project root (not `.dev.vars.example`); restart `npm run dev`. |
| Deployed worker 401s but local works | Secret not set on the deployed worker | `npx wrangler secret list` to verify; `npx wrangler secret put VIBES_META_SESSION` then redeploy. |
| `403 Facebook expired access token` (TTS only) | vibes.ai server-side FB token rotating | Unrelated to your cookies — wait a few minutes and retry. |

## Security notes

- Treat both values as **passwords** — they grant full access to your vibes.ai/Meta session.
- Never commit them. `.dev.vars` is already in `.gitignore`; keep it that way.
- On Cloudflare, always use **Secret** (not plain vars) for both cookie values.
- Set `VIBES_API_KEY` when sharing the worker URL with others, so your real vibes cookie never leaves the server.
- Rotate both after sharing anything.

## The Python sibling

The same two credentials (`VIBES_META_SESSION`, `AUTH_META_COOKIES`) work in the Python repo **[VibesAI-api](https://github.com/mir-ashiq/VibesAI-api)** — see its [COOKIES.md](https://github.com/mir-ashiq/VibesAI-api/blob/main/COOKIES.md) for Python/Docker-specific setup (`--cookie`, `VIBES_COOKIE_FILE`, `set_auth_meta_cookies()`).
