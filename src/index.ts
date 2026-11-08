/**
 * Cloudflare Workers entrypoint.
 *
 * Deploy (free tier is enough):
 *   npx wrangler login
 *   npx wrangler secret put VIBES_META_SESSION   // vibes.ai meta_session cookie
 *   npx wrangler secret put AUTH_META_COOKIES    // optional: auto re-login (auth.meta.com cookies)
 *   npx wrangler deploy
 *
 * How to grab both cookies from your browser: see COOKIES.md
 */
import { createApp, type Env } from "./app.js";

const app = createApp((c) => (c.env ?? {}) as Env);

export default app;
