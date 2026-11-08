/**
 * OpenAI JavaScript SDK example for VibesAI-openai.
 *
 *   npm install openai
 *   BASE_URL=http://localhost:8787/v1 API_KEY=your-key node openai-js.mjs
 */
import OpenAI from "openai";
import fs from "node:fs";

const client = new OpenAI({
  baseURL: process.env.BASE_URL ?? "http://localhost:8787/v1",
  apiKey: process.env.API_KEY ?? "your-vibes-meta-session-cookie",
});

// ------------------------------------------------------------------ chat
const completion = await client.chat.completions.create({
  model: "vibes-chat",
  messages: [{ role: "user", content: "Add a 5 second sunset clip to the timeline." }],
});
console.log("assistant:", completion.choices[0].message.content);

// ------------------------------------------------------------- streaming
const stream = await client.chat.completions.create({
  model: "vibes-chat",
  messages: [{ role: "user", content: "Describe a cinematic city intro shot." }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? "");
}
console.log();

// ---------------------------------------------------------------- images
const image = await client.images.generate({
  model: "vibes-image",
  prompt: "an origami fox on a desk, studio lighting",
  size: "1024x1024",
  n: 1,
});
console.log("image url:", image.data[0].url);

// ------------------------------------------------------------------ tts
const mp3 = await client.audio.speech.create({ model: "vibes-tts", voice: "alloy", input: "Hello from Vibes!" });
fs.writeFileSync("hello.mp3", Buffer.from(await mp3.arrayBuffer()));
console.log("saved hello.mp3");

// ---------------------------------------------------------------- videos
// Sora-style async video generation (generate, poll, download):
const job = await client.post("/videos/generations", {
  body: { model: "vibes-video", prompt: "A red umbrella on a rainy neon street", size: "1024x1792", n: 1 },
});
console.log("video job:", job.id, job.status);

let status = job;
while (!["completed", "failed"].includes(status.status)) {
  await new Promise((r) => setTimeout(r, 10_000));
  status = await client.get(`/videos/generations/${job.id}`);
  console.log("status:", status.status, `(${status.progress ?? 0}%)`);
}
if (status.status === "completed") console.log("video url:", status.videos[0].url);
