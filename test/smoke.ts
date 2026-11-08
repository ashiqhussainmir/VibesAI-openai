/**
 * Live smoke test — hits the real vibes.ai API through the server.
 *
 * Usage:
 *   VIBES_META_SESSION="<cookie>" VIBES_API_KEY=testkey BASE=http://localhost:8787 npm test
 *
 * Or test an in-process app directly (no server needed):
 *   VIBES_META_SESSION="<cookie>" npx tsx test/smoke.ts --in-process
 */
import { createApp, type Env } from "../src/app.js";

const COOKIE = process.env.VIBES_META_SESSION ?? "";
const BASE = process.env.BASE ?? "http://localhost:8787";
const KEY = process.env.VIBES_API_KEY ?? "";
const inProcess = process.argv.includes("--in-process");

let lastImageEntId: string | number | undefined;
let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await fn();
    pass++;
    console.log(`PASS ${name} -> ${String(detail).slice(0, 100)}`);
  } catch (e: any) {
    fail++;
    console.log(`FAIL ${name} -> ${e?.message ?? String(e)}`);
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  if (!COOKIE) {
    console.error("Set VIBES_META_SESSION env var first.");
    process.exit(2);
  }

  let doFetch: typeof fetch;
  if (inProcess) {
    const app = createApp(() => ({ VIBES_META_SESSION: COOKIE, VIBES_API_KEY: "testkey" }) as Env);
    doFetch = (async (url: any, init?: any) => app.request(String(url).replace(BASE, ""), init)) as typeof fetch;
  } else {
    doFetch = fetch;
  }

  const headers = {
    Authorization: `Bearer ${inProcess ? "testkey" : KEY || COOKIE}`,
    "Content-Type": "application/json",
  };
  const j = async (path: string, init?: RequestInit) => {
    const res = await doFetch(`${BASE}${path}`, { ...init, headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}: ${body.slice(0, 200)}`);
    return JSON.parse(body);
  };

  await check("GET /v1/models", async () => {
    const d = await j("/v1/models");
    assert(d.data?.length >= 5, "expected >= 5 models");
    return `${d.data.length} models`;
  });

  await check("GET /health/auth", async () => {
    const d = await j("/health/auth");
    assert(d.authenticated === true, "not authenticated");
    return d.user?.username;
  });

  await check("GET /v1/audio/voices", async () => {
    const d = await j("/v1/audio/voices");
    assert(d.data?.length > 0, "no voices");
    return `${d.data.length} voices`;
  });

  await check("POST /v1/audio/speech", async () => {
    const res = await doFetch(`${BASE}/v1/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "vibes-tts", input: "Hello from the smoke test.", voice: "alloy" }),
    });
    if (res.status === 503) {
      console.log("SKIP POST /v1/audio/speech -> upstream vibes.ai TTS token expired (retry later)");
      return "skipped (upstream)";
    }
    assert(res.ok, `HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    assert(buf.byteLength > 1000, `audio too small: ${buf.byteLength} bytes`);
    return `${buf.byteLength} bytes, content-type=${res.headers.get("content-type")}`;
  });

  await check("POST /v1/images/generations", async () => {
    const d = await j("/v1/images/generations", {
      method: "POST",
      body: JSON.stringify({ model: "vibes-image", prompt: "a tiny origami fox on a desk, studio light", n: 1, size: "1024x1024" }),
    });
    assert(d.data?.[0]?.url, "no image url");
    lastImageEntId = d.data[0].image_ent_id;
    return d.data[0].url.slice(0, 60);
  });

  await check("POST /v1/images/edits (source_image_ent_id)", async () => {
    if (!lastImageEntId) return "skipped (no prior generation)";
    const fd = new FormData();
    fd.set("source_image_ent_id", String(lastImageEntId));
    fd.set("prompt", "make it night time");
    const res = await doFetch(`${BASE}/v1/images/edits`, {
      method: "POST",
      headers: { Authorization: headers.Authorization },
      body: fd,
    });
    const body = await res.text();
    assert(res.ok, `HTTP ${res.status}: ${body.slice(0, 200)}`);
    const d = JSON.parse(body);
    assert(d.data?.[0]?.url || d.data?.[0]?.b64_json, "no edited image");
    return d.data[0].url?.slice(0, 60) ?? "b64 ok";
  });

  await check("POST /v1/chat/completions (non-stream)", async () => {
    const d = await j("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "vibes-chat",
        messages: [{ role: "user", content: "Say hello in exactly five words." }],
      }),
    });
    assert(d.choices?.[0]?.message?.content, "no message content");
    return d.choices[0].message.content.slice(0, 80);
  });

  await check("POST /v1/videos/generations", async () => {
    const d = await j("/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify({ model: "vibes-video", prompt: "A red umbrella on a rainy neon street, cinematic", size: "1024x1792", n: 1 }),
    });
    assert(d.id?.startsWith("batch-"), `unexpected id: ${d.id}`);
    assert(["queued", "in_progress", "completed"].includes(d.status), `unexpected status: ${d.status}`);
    return `id=${d.id} status=${d.status}`;
  });

  await check("POST /v1/chat/completions (stream)", async () => {
    const res = await doFetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "vibes-chat",
        stream: true,
        messages: [{ role: "user", content: "Reply with the single word: streaming" }],
      }),
    });
    assert(res.ok, `HTTP ${res.status}`);
    const text = await res.text();
    assert(text.includes("chat.completion.chunk"), "no chunks in stream");
    assert(text.trimEnd().endsWith("data: [DONE]"), "stream not terminated with [DONE]");
    return `${text.split("\n").filter((l) => l.startsWith("data: {")).length} chunks`;
  });

  await check("GET /vibes/api/auth/me (passthrough)", async () => {
    const d = await j("/vibes/api/auth/me");
    assert(d.user?.username, "no user");
    return d.user.username;
  });

  console.log(`\n=== ${pass}/${pass + fail} checks passed ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
