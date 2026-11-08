/**
 * App factory — works on every runtime that supports Web fetch:
 *   Cloudflare Workers (src/index.ts), Node >= 18 (src/node.ts), Deno, Bun.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import { DEFAULT_BASE_URL, VibesClient, VibesApiError } from "./vibes.js";
import {
  openaiError,
  handleListModels,
  handleChatCompletions,
  handleCreateVideoGeneration,
  handleGetVideoGeneration,
  handleGetVideoContent,
  handleCreateImageGeneration,
  handleImageEdit,
  handleSpeech,
  handleListVoices,
} from "./openai.js";
import { handlePassthrough } from "./passthrough.js";

export interface Env {
  VIBES_META_SESSION?: string;
  VIBES_API_KEY?: string;
  AUTH_META_COOKIES?: string;
  VIBES_BASE_URL?: string;
  CORS_ORIGIN?: string;
  [k: string]: string | undefined;
}

/** Typed Hono environment shared by all handlers. */
export type AppEnv = {
  Variables: {
    vibesClient: VibesClient;
    vibesMetaSession: string;
    vibesBaseUrl: string;
  };
};

export type AppContext = Context<AppEnv>;

type EnvSource = (c: Context) => Env | Promise<Env>;

// Per-isolate client cache (avoids re-handshaking for every request).
const clientCache = new Map<string, VibesClient>();

function getClient(metaSession: string, env: Env): VibesClient {
  const cacheKey = `${metaSession}|${env.VIBES_BASE_URL ?? ""}|${env.AUTH_META_COOKIES ? "rl" : ""}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client = new VibesClient(metaSession, {
      baseUrl: env.VIBES_BASE_URL || DEFAULT_BASE_URL,
      authMetaCookies: env.AUTH_META_COOKIES,
    });
    if (clientCache.size > 16) clientCache.clear();
    clientCache.set(cacheKey, client);
  }
  return client;
}

/**
 * Resolve auth:
 *  1. If VIBES_API_KEY is set, clients authenticate with it (Bearer) and the
 *     vibes session comes from the server-side VIBES_META_SESSION secret.
 *  2. Otherwise the Bearer token itself IS the vibes.ai meta_session cookie.
 */
function resolveCredentials(token: string | undefined, env: Env): { metaSession: string | null; error?: string } {
  if (env.VIBES_API_KEY) {
    if (token !== env.VIBES_API_KEY) {
      return { metaSession: null, error: "Invalid API key. Expected the value of VIBES_API_KEY as Bearer token." };
    }
    if (!env.VIBES_META_SESSION) {
      return { metaSession: null, error: "Server misconfigured: VIBES_API_KEY is set but VIBES_META_SESSION is missing." };
    }
    return { metaSession: env.VIBES_META_SESSION };
  }
  if (token) return { metaSession: token };
  if (env.VIBES_META_SESSION) return { metaSession: env.VIBES_META_SESSION };
  return {
    metaSession: null,
    error:
      "Missing API key. Send `Authorization: Bearer <vibes meta_session cookie>` (or set VIBES_API_KEY + VIBES_META_SESSION on the server).",
  };
}

function bearerToken(c: Context): string | undefined {
  const auth = c.req.header("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  const xKey = c.req.header("x-api-key");
  if (xKey) return xKey.trim();
  return undefined;
}

/** Middleware: resolve credentials, attach client, enforce auth. */
function authMiddleware(envSource: EnvSource) {
  return async (c: AppContext, next: Next) => {
    const env = await envSource(c);
    const token = bearerToken(c);
    const { metaSession, error } = resolveCredentials(token, env);
    if (!metaSession) {
      return c.json(openaiError(401, error ?? "Unauthorized", "authentication_error", "invalid_api_key"), 401);
    }
    c.set("vibesClient", getClient(metaSession, env));
    c.set("vibesMetaSession", metaSession);
    c.set("vibesBaseUrl", env.VIBES_BASE_URL || DEFAULT_BASE_URL);
    await next();
  };
}

function vibesErrorToResponse(e: unknown): Response | null {
  if (e instanceof VibesApiError) {
    const status = e.status ?? 502;
    const type =
      status === 401
        ? "authentication_error"
        : status === 404
          ? "not_found_error"
          : status < 500
            ? "invalid_request_error"
            : "api_error";
    return Response.json(openaiError(status, e.message, type as any), { status });
  }
  return null;
}

export function createApp(envSource: EnvSource): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // CORS — open by default (browser clients); restrict via CORS_ORIGIN.
  app.use(
    "*",
    cors({
      origin: (origin) => origin || "*",
      allowHeaders: ["Authorization", "Content-Type", "x-api-key", "x-requested-with"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
      maxAge: 86400,
    }),
  );

  // Health / info
  app.get("/", (c) =>
    c.json({
      name: "VibesAI OpenAI-compatible API",
      version: "1.0.0",
      docs: "/v1/models, /v1/chat/completions, /v1/videos/generations, /v1/images/generations, /v1/images/edits, /v1/images/generations/edit, /v1/audio/speech, /vibes/*",
      openapi_compatible: true,
    }),
  );
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/health/auth", authMiddleware(envSource), async (c) => {
    try {
      const me = await c.get("vibesClient").getMe();
      return c.json({ status: "ok", authenticated: true, user: { id: me.id, username: me.username } });
    } catch (e) {
      const mapped = vibesErrorToResponse(e);
      if (mapped) return mapped;
      return c.json(openaiError(502, "auth check failed"), 502);
    }
  });

  app.use("/v1/*", authMiddleware(envSource));
  app.use("/vibes/*", authMiddleware(envSource));

  // ---------------- OpenAI-compatible routes ----------------
  app.get("/v1/models", handleListModels);
  app.post("/v1/chat/completions", handleChatCompletions);

  app.post("/v1/videos/generations", handleCreateVideoGeneration);
  app.get("/v1/videos/generations/:id", handleGetVideoGeneration);
  app.get("/v1/videos/generations/:id/content", handleGetVideoContent);

  app.post("/v1/images/generations", handleCreateImageGeneration);
  app.post("/v1/images/edits", handleImageEdit);
  // z-ai SDK / Canvix shape — the SDK posts JSON to {base}/images/generations/edit
  app.post("/v1/images/generations/edit", handleImageEdit);

  app.post("/v1/audio/speech", handleSpeech);
  app.get("/v1/audio/voices", handleListVoices);

  // ---------------- raw vibes.ai passthrough ----------------
  app.all("/vibes/*", handlePassthrough);

  // ---------------- 404 + error handling ----------------
  app.notFound((c) => c.json(openaiError(404, `unknown route: ${c.req.method} ${c.req.path}`, "not_found_error"), 404));

  app.onError((err, c) => {
    const mapped = vibesErrorToResponse(err);
    if (mapped) return mapped;
    console.error("unhandled error:", err);
    return c.json(openaiError(500, `internal error: ${err?.message ?? String(err)}`), 500);
  });

  return app;
}
