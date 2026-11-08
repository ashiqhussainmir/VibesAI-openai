/**
 * Raw vibes.ai passthrough: any path under /vibes/* is forwarded verbatim
 * (method, query, JSON body) to vibes.ai with the authenticated session.
 * This gives full access to the entire vibes.ai API surface — every endpoint
 * supported by the Python client (and any future ones) works through here.
 *
 *   GET  /vibes/api/projects           → GET  https://vibes.ai/api/projects
 *   POST /vibes/api/generate/prompts   → POST https://vibes.ai/api/generate/prompts
 *   ...
 */

import type { AppContext } from "./app.js";
import { BROWSER_UA, DEFAULT_BASE_URL, type FetchBody } from "./vibes.js";
import { openaiError } from "./openai.js";

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH"]);

export async function handlePassthrough(c: AppContext): Promise<Response> {
  const method = c.req.method;
  if (!ALLOWED_METHODS.has(method)) {
    return c.json(openaiError(405, `method ${method} not allowed`, "invalid_request_error"), 405);
  }

  const metaSession: string = c.get("vibesMetaSession");
  const baseUrl: string = c.get("vibesBaseUrl") ?? DEFAULT_BASE_URL;

  // Path after the /vibes prefix, e.g. "/api/projects".
  const path = c.req.path.replace(/^\/vibes/, "") || "/";
  const target = `${baseUrl}${path}${c.req.url.includes("?") ? "?" + c.req.url.split("?")[1] : ""}`;

  const headers: Record<string, string> = {
    Cookie: `meta_session=${metaSession};cookie_ack=true`,
    "User-Agent": BROWSER_UA,
    Referer: `${baseUrl}/`,
    Origin: baseUrl,
  };

  let body: FetchBody;
  if (method !== "GET" && method !== "DELETE") {
    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      headers["Content-Type"] = "application/json";
      body = await c.req.text();
    } else if (contentType) {
      headers["Content-Type"] = contentType;
      body = await c.req.arrayBuffer();
    }
  }

  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(600_000),
    });

    const respHeaders = new Headers();
    for (const h of ["Content-Type", "Content-Disposition", "Content-Length"]) {
      const v = upstream.headers.get(h);
      if (v) respHeaders.set(h, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
  } catch (e: any) {
    return c.json(openaiError(502, `upstream request failed: ${e?.message ?? String(e)}`), 502);
  }
}
