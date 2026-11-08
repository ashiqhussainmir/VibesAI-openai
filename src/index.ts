/**
 * Cloudflare Workers entrypoint.
 *
 * Deploy (free tier is enough):
 *   npx wrangler login
 *   npx wrangler secret put VIBES_META_SESSION
 *   npx wrangler deploy
 */
import { createApp, type Env } from "./app.js";

const app = createApp((c) => (c.env ?? {}) as Env);

export default app;
