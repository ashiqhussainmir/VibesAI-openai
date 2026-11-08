/**
 * Content-hash → vibes image_ent_id registry.
 *
 * WHY THIS EXISTS
 * vibes.ai only edits images it generated itself: /api/generate/image-edit
 * takes a `sourceImageEntId` and answers "You do not have access" for
 * anything that was merely uploaded. OpenAI-compatible edit requests,
 * however, carry raw image bytes — with no vibes-side handle at all.
 *
 * The bridge: when this proxy returns a generated image, it also records
 * sha256(imageBytes) → image_ent_id. When an edit request arrives, the
 * bytes are hashed the same way; a hit recovers the ent_id and the edit
 * becomes possible. This makes "generate, then edit, then edit again"
 * work through the plain OpenAI-style API for any image this proxy
 * produced (edits register their results too, so iteration chains work).
 *
 * Storage (best-effort, no bindings required):
 *   - L1: in-memory Map (same isolate — instant, survives between requests)
 *   - L2: Cache API (`caches`, per-colo, 7-day TTL) — survives isolate
 *     restarts and covers requests landing on sibling isolates of the same
 *     colo. On runtimes without `caches` (plain Node), L1 is all we get.
 */

/** Registry cache lifetime. fbcdn URLs live a few days; 7d is a sane cap. */
const TTL_SECONDS = 7 * 24 * 60 * 60;
/** Synthetic namespace — never routed anywhere, only a stable cache key. */
const KEY_PREFIX = "https://ent-registry.vibesai-openai.internal/sha256/";
/** Memory bound — generous, but the Map may not grow unbounded. */
const MEMORY_CAP = 1024;

const mem = new Map<string, string>();

/** The runtime's Cache API, when present (Workers, Deno). Plain Node has none. */
async function getCache(): Promise<Cache | null> {
  try {
    if (typeof caches === "undefined") return null;
    const storage = caches as unknown as { default?: Cache; open?: (name: string) => Promise<Cache> };
    if (storage.default) return storage.default;
    if (storage.open) return await storage.open("vibes-ent-registry");
  } catch {
    /* Cache API unavailable — memory-only registry */
  }
  return null;
}

/** sha256(bytes) → lowercase hex. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Record sha256(imageBytes) → entId. Never throws. */
export async function registerGeneratedImage(bytes: ArrayBuffer, entId: string): Promise<void> {
  if (!entId || !bytes.byteLength) return;
  try {
    const hash = await sha256Hex(bytes);
    mem.set(hash, entId);
    if (mem.size > MEMORY_CAP) {
      // FIFO eviction — oldest insert goes first
      const oldest = mem.keys().next().value;
      if (oldest !== undefined) mem.delete(oldest);
    }
    const cache = await getCache();
    if (cache) {
      await cache.put(
        new Request(KEY_PREFIX + hash),
        new Response(JSON.stringify({ entId }), {
          headers: { "Cache-Control": `max-age=${TTL_SECONDS}` },
        }),
      );
    }
  } catch {
    /* best-effort by design */
  }
}

/** Recover the entId for these exact image bytes, if we generated them. */
export async function lookupEntId(bytes: ArrayBuffer): Promise<string | null> {
  if (!bytes.byteLength) return null;
  try {
    const hash = await sha256Hex(bytes);
    const hit = mem.get(hash);
    if (hit) return hit;
    const cache = await getCache();
    if (cache) {
      const resp = await cache.match(KEY_PREFIX + hash);
      if (resp) {
        const body = (await resp.json()) as { entId?: string };
        if (body.entId) {
          mem.set(hash, body.entId);
          return body.entId;
        }
      }
    }
  } catch {
    /* miss is a miss */
  }
  return null;
}

/** Run a best-effort background task on runtimes that support waitUntil,
 *  otherwise complete it inline. Used for post-response registry writes. */
export async function afterResponse(c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } }, task: Promise<unknown>): Promise<void> {
  try {
    // Hono exposes executionCtx on Workers; the getter throws elsewhere.
    const ctx = (c as { executionCtx?: { waitUntil(p: Promise<unknown>): void } }).executionCtx;
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(task);
      return;
    }
  } catch {
    /* no execution context — fall through to inline await */
  }
  await task;
}
