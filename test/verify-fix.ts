/**
 * Credential-free verification of the image-edit fix (route + body parsing
 * + registry round-trip). Run from the repo root:
 *   npx tsx test/verify-fix.ts
 * Exits non-zero on any failure.
 */
import { createApp, type Env } from "../src/app.js";
import { registerGeneratedImage, lookupEntId } from "../src/imagedit.js";

const app = createApp(() => ({ VIBES_META_SESSION: "fake-session", VIBES_API_KEY: "testkey" }) as Env);
const H = { Authorization: "Bearer testkey", "Content-Type": "application/json" };

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`PASS ${name}${detail ? " -> " + detail : ""}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " -> " + detail : ""}`); }
}

// 1) The SDK route must exist (was 404 before the fix — the root cause)
{
  const res = await app.request("/v1/images/generations/edit", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ prompt: "probe" }),
  });
  const body = await res.json() as { error?: { message?: string } };
  check("SDK edit route exists (no 404)", res.status !== 404, `HTTP ${res.status}`);
  check("SDK edit route accepts JSON", res.status === 400 && /`image`|source_image_ent_id/.test(body.error?.message ?? ""), (body.error?.message ?? "").slice(0, 90));
}

// 2) Probe shape: Canvix admin probe sends {model, prompt:'probe'} with no image
//    and reads any 4xx-except-404 as "endpoint reachable"
{
  const res = await app.request("/v1/images/generations/edit", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ model: "vibes-image", prompt: "probe" }),
  });
  check("admin probe shape -> 400 (reachable, not 404)", res.status === 400, `HTTP ${res.status}`);
}

// 3) Legacy OpenAI route still parses multipart
{
  const fd = new FormData();
  fd.append("prompt", "make it blue");
  fd.append("image", new File([new Uint8Array([1, 2, 3, 4])], "x.png", { type: "image/png" }));
  const res = await app.request("/v1/images/edits", { method: "POST", headers: { Authorization: "Bearer testkey" }, body: fd });
  check("legacy multipart route parses", res.status !== 400 || !/Invalid multipart/.test(JSON.stringify(await res.text())), `HTTP ${res.status}`);
}

// 4) Registry round-trip: same bytes -> same entId; different bytes -> miss
{
  const bytes = new Uint8Array([9, 9, 9, 9, 1, 2, 3]).buffer as ArrayBuffer;
  await registerGeneratedImage(bytes, "ent-abc-123");
  const hit = await lookupEntId(bytes);
  const miss = await lookupEntId(new Uint8Array([7, 7, 7]).buffer as ArrayBuffer);
  check("registry round-trip", hit === "ent-abc-123", `hit=${hit}`);
  check("registry miss for unknown bytes", miss === null, `miss=${miss}`);
}

// 5) dataURL image parsing path: prompt + images:[{url}] with a data URL
//    should reach the upload path (fails at vibes call with fake session —
//    any status proves it got past body parsing)
{
  const png1x1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const res = await app.request("/v1/images/generations/edit", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ prompt: "make the background light blue", images: [{ url: png1x1 }], size: "1024x1024" }),
  });
  const txt = await res.text();
  check("SDK JSON + dataURL passes body parsing", res.status !== 400 || /image edit failed|image upload/.test(txt), `HTTP ${res.status}: ${txt.slice(0, 80)}`);
}

// 6) explicit source_image_ent_id path (no image bytes needed)
{
  const res = await app.request("/v1/images/generations/edit", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ prompt: "make it snowy", source_image_ent_id: "1350274674845736" }),
  });
  const txt = await res.text();
  check("source_image_ent_id path passes parsing", res.status !== 400, `HTTP ${res.status}: ${txt.slice(0, 80)}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
