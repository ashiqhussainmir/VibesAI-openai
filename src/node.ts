/**
 * Node.js entrypoint (for Render / Railway / Fly.io / any VPS / local dev).
 *
 *   VIBES_META_SESSION="..." npm run start:node
 *   # then: curl -H "Authorization: Bearer anything" localhost:8787/v1/models
 *
 * Also runs unchanged on Bun (`bun src/node.ts`) and Deno (deno run -A npm:tsx src/node.ts).
 */
import { serve } from "@hono/node-server";
import { createApp, type Env } from "./app.js";

const port = Number(process.env.PORT ?? 8787);

const app = createApp(() => process.env as unknown as Env);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`VibesAI OpenAI-compatible API listening on http://localhost:${info.port}`);
});
