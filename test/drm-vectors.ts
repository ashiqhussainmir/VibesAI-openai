/**
 * Verify the Sec-MS-GEC v2 TypeScript port against Python edge-tts vectors.
 *   npx tsx test/drm-vectors.ts
 */
import { readFileSync } from "node:fs";
import { generateSecMsGec } from "../src/tts/drm.js";

const vectors: { unix: number; token: string }[] = JSON.parse(
  readFileSync(new URL("./drm_vectors.json", import.meta.url), "utf-8"),
);

let pass = 0;
for (const v of vectors) {
  const got = generateSecMsGec(v.unix);
  const ok = got === v.token;
  if (ok) {
    pass++;
  } else {
    console.error(`FAIL unix=${v.unix}\n  want ${v.token}\n  got  ${got}`);
  }
}
console.log(`drm vectors: ${pass}/${vectors.length} pass`);
process.exit(pass === vectors.length ? 0 : 1);
