# VibesAI OpenAI-Compatible API

**Unofficial [vibes.ai](https://vibes.ai) API in TypeScript — fully OpenAI-compatible, deployable for free on Cloudflare Workers** (also runs on Node, Deno, Bun, Docker, Render, Railway, Fly.io…).

Point any OpenAI SDK / tool at this server and use vibes.ai's video generation, image generation, timeline AI chat, and text-to-speech through standard OpenAI endpoints.

> TypeScript sibling of [VibesAI-api](https://github.com/mir-ashiq/VibesAI-api) (the Python client + REST server).

---

## Why

- **OpenAI-compatible** → works out of the box with the `openai` Python/JS SDKs, LangChain, LobeChat, Open WebUI, curl, and every tool that speaks the OpenAI API.
- **Edge-ready** → pure Web-standard APIs (`fetch`, `crypto`, streams). No Node built-ins. One codebase, every runtime.
- **Free hosting** → deploys on the Cloudflare Workers free tier. No server, no cost.
- **Full API access** → beyond the OpenAI surface, every raw vibes.ai endpoint is proxied under `/vibes/*`.

## Endpoint map

| OpenAI endpoint | vibes.ai feature |
| --- | --- |
| `GET /v1/models` | Model catalog (`vibes-chat`, `vibes-video`, `vibes-image`, `vibes-tts`, `midjen-*`) |
| `POST /v1/chat/completions` (stream + non-stream) | Timeline AI assistant — natural-language video editing agent, with tool calls |
| `POST /v1/videos/generations` | Sora-style async video generation (t2v / i2v) |
| `GET /v1/videos/generations/{id}` | Poll generation status + progress |
| `GET /v1/videos/generations/{id}/content` | Download the finished MP4 |
| `POST /v1/images/generations` | DALL-E-style image generation (sync, `url` or `b64_json`) |
| `POST /v1/images/edits` | Image editing — multipart (OpenAI SDK) **or** JSON (`image` / `images: [{url}]` as data/https URL) |
| `POST /v1/images/generations/edit` | Same handler, the route the z-ai SDK (`zai.images.generations.edit`) posts to |
| `POST /v1/audio/speech` | OpenAI TTS-style speech synthesis (41 PlayAI voices) |
| `GET /v1/audio/voices` | Voice catalog (convenience extra) |
| `ALL /vibes/*` | **Raw passthrough** to the entire vibes.ai API (projects, batches, ingredients, moodboards, music, lipsync, exports, share links…) |

Extras: `GET /health`, `GET /health/auth` (session check), OpenAI-style JSON errors everywhere, CORS enabled.

## Quick start (local)

```bash
git clone https://github.com/mir-ashiq/VibesAI-openai.git
cd VibesAI-openai
npm install

# Option A — Node
VIBES_META_SESSION="your-vibes-cookie" npm run start:node

# Option B — Workers dev server (miniflare)
cp .dev.vars.example .dev.vars   # fill in VIBES_META_SESSION
npm run dev
```

> 🍪 **Where do I get that cookie?** See **[COOKIES.md](COOKIES.md)** — a step-by-step guide for grabbing both `VIBES_META_SESSION` (the vibes.ai `meta_session` cookie) and `AUTH_META_COOKIES` (auth.meta.com cookies for automatic re-login) from your browser's DevTools, plus how to set them on Cloudflare, Node, and Docker.

```bash
curl http://localhost:8787/v1/models -H "Authorization: Bearer anything"
```

## Deploy to Cloudflare Workers (free)

```bash
npx wrangler login

# Required: your vibes.ai meta_session cookie
npx wrangler secret put VIBES_META_SESSION

# Optional but recommended: force clients to use THIS key instead of the cookie
npx wrangler secret put VIBES_API_KEY

# Optional: auto re-login when the vibes session expires
npx wrangler secret put AUTH_META_COOKIES

npx wrangler deploy
```

You get `https://vibesai-openai.<your-subdomain>.workers.dev`. The free tier (100k requests/day) is plenty — this proxy is stateless and streams responses.

### Environment variables / secrets

| Name | Required | Purpose |
| --- | --- | --- |
| `VIBES_META_SESSION` | yes* | Your vibes.ai `meta_session` cookie (server-side session). Get it from DevTools → Application → Cookies → `vibes.ai`. |
| `VIBES_API_KEY` | no | If set, clients must send this as `Bearer` token; the vibes cookie stays hidden server-side. If unset, **the Bearer token itself is the vibes cookie** (per-user auth). |
| `AUTH_META_COOKIES` | no | auth.meta.com cookie string — enables automatic OIDC re-login when the vibes session expires (see below). |
| `VIBES_BASE_URL` | no | Override upstream (default `https://vibes.ai`). |
| `CORS_ORIGIN` | no | Reserved for CORS restriction (default: allow all). |

> 🍪 **Full guide to getting and setting both cookies:** **[COOKIES.md](COOKIES.md)** — DevTools walkthroughs (Application tab + Network tab), format rules, per-platform setup (wrangler secrets, `.dev.vars`, Node, Docker, Cloudflare dashboard), and troubleshooting.

## Deploy elsewhere

Any Node 18+ host:

```bash
VIBES_META_SESSION="..." PORT=8787 npm run start:node
```

- **Render / Railway / Fly.io**: uses the included `Dockerfile` (or build command `npm install && npm run start:node`).
- **Bun**: `bun src/node.ts` (runs the same code).
- **Deno**: `deno run -A npm:tsx src/node.ts`.

## Auth modes

**Mode 1 — shared session (recommended for personal use):** set `VIBES_META_SESSION` (and optionally `VIBES_API_KEY`). Clients send `Authorization: Bearer <VIBES_API_KEY>` (or any token if no API key is set).

**Mode 2 — bring-your-own-cookie:** don't set `VIBES_META_SESSION`; clients send their own vibes cookie as the Bearer token:

```bash
curl -H "Authorization: Bearer 46d3745d-bec1-4658...." http://localhost:8787/v1/models
```

### Session expiry & auto re-login

vibes.ai sessions expire after ~30 min of inactivity. Two mitigations:

1. The proxy keeps sessions alive passively while traffic flows.
2. Set `AUTH_META_COOKIES` (auth.meta.com cookies from DevTools) and the proxy replays the Meta OIDC redirect chain to obtain a fresh `meta_session` automatically on 401s.

Step-by-step instructions for both cookies: **[COOKIES.md](COOKIES.md)**.

## Usage with OpenAI SDKs

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="https://vibesai-openai.your-subdomain.workers.dev/v1", api_key="your-key")

# chat (timeline AI assistant)
completion = client.chat.completions.create(
    model="vibes-chat",
    messages=[{"role": "user", "content": "Add a 5s sunset clip to the timeline"}],
)

# images
image = client.images.generate(model="vibes-image", prompt="an origami fox", size="1024x1024")

# tts
with client.audio.speech.with_streaming_response.create(
    model="vibes-tts", voice="alloy", input="Hello from Vibes!"
) as resp:
    resp.stream_to_file("hello.mp3")

# videos (Sora-style: create → poll → download)
job = client.post("/videos/generations", body={"model": "vibes-video", "prompt": "a neon rainy street"})
# poll client.get(f"/videos/generations/{job['id']}") until status == "completed"
```

### JavaScript / TypeScript

```ts
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "…/v1", apiKey: "your-key" });

const stream = await client.chat.completions.create({
  model: "vibes-chat",
  messages: [{ role: "user", content: "Add a 5s sunset clip" }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
```

### curl

```bash
# chat
curl -N http://localhost:8787/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"vibes-chat","messages":[{"role":"user","content":"add a sunset clip"}],"stream":true}'

# video generation
curl http://localhost:8787/v1/videos/generations \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"vibes-video","prompt":"a red umbrella in neon rain","size":"1024x1792"}'

# raw vibes API passthrough
curl "http://localhost:8787/vibes/api/projects?limit=5" -H "Authorization: Bearer $KEY"
```

## Request mapping details

### Chat → timeline assistant

- `system`/`developer` messages → vibes `instructions`.
- A single `user` message → vibes `input` (native).
- Multi-turn conversations → vibes `messages` array (server-side history). Continue a vibes conversation with `vibes.conversation_id` in the request body.
- `tools` (OpenAI function-calling format) are converted to the flat vibes tool schema. Tool calls come back as standard `tool_calls`; submit results as `role:"tool"` messages.
- `reasoning_delta` events are exposed as `reasoning_content` (DeepSeek-style).

### Images

- `size` maps to vibes aspect ratios: `1024x1024`→`1:1`, `1024x1792`→`9:16`, `1792x1024`→`16:9`.
- `response_format`: `url` (default, vibes CDN link) or `b64_json`.
- Editing: vibes.ai can **only edit images it generated** (internal ent_id). Two ways to get there:
  - **Automatic** — the proxy hashes every image it generates (and every edit result) and records `sha256(bytes) → ent_id` in a per-colo registry (Cache API, 7-day TTL). When an edit request carries image bytes whose hash matches, the ent_id is recovered and the edit proceeds — no client bookkeeping needed. Generate → edit → edit chains just work; pass images as a file, data URL or https URL.
  - **Explicit** — pass `source_image_ent_id` (the `image_ent_id` from a previous response).
  - Arbitrary images that were never generated through this proxy get a clear `422 source_image_not_editable` explaining the upstream limitation.
- `POST /v1/images/generations/edit` is the same handler as `/v1/images/edits` — it exists because the z-ai SDK (`zai.images.generations.edit`, used by Canvix and friends) posts JSON to `{base}/images/generations/edit`.
- Advanced controls (vibe model, resolution, ingredients, moodboards) via the optional `vibes` object in the request body.

### Videos

- Response shape mirrors OpenAI's Sora API: `{id, status: queued|in_progress|completed|failed, progress, …}`.
- Videos generate asynchronously (30–120s typical). Poll `GET /v1/videos/generations/{id}`, then download via `/content` (MP4 stream) or use the returned CDN URLs.
- i2v (image-to-video): pass `vibes.start_frame` (a frame handle from `/v1/images/generations` → `image_ent_id`) in the request body.

### TTS voices

OpenAI voice names are mapped to PlayAI voices (`alloy`→`play_ai_Marisol`, `echo`→`play_ai_Nigel`, …). You can also pass any raw `play_ai_*` voice id from `GET /v1/audio/voices` (41 available).

## Development

```bash
npm install
npm run typecheck                     # tsc --noEmit
VIBES_META_SESSION="…" npm test       # live smoke test (needs a real cookie)
npm run dev                           # wrangler dev (Workers runtime)
```

## Project structure

```
src/
├── index.ts        # Cloudflare Workers entrypoint
├── node.ts         # Node/Bun/Deno entrypoint
├── app.ts          # Hono app factory: auth, CORS, routing, errors
├── vibes.ts        # VibesClient — fetch-based port of the Python client
├── openai.ts       # OpenAI-compatible handlers
├── passthrough.ts  # /vibes/* raw proxy
└── utils.ts        # UUIDv7, mg_request_id, base64 helpers
test/smoke.ts       # live smoke test against vibes.ai
examples/           # OpenAI SDK snippets (Python + JS)
```

## Notes & disclaimer

- Unofficial — vibes.ai has no public API; this reproduces the web app's network calls. Expect breaking changes when vibes.ai updates.
- Don't commit `.dev.vars` or cookies. Rotate sessions regularly.
- Rate limits are vibes.ai's own. The proxy adds no artificial limits.

## License

MIT — same as [VibesAI-api](https://github.com/mir-ashiq/VibesAI-api).
