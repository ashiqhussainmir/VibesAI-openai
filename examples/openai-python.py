"""
OpenAI Python SDK example for VibesAI-openai.

    pip install openai
    BASE_URL=http://localhost:8787/v1 API_KEY=your-key python openai-python.py
"""
import os
from openai import OpenAI

base_url = os.environ.get("BASE_URL", "http://localhost:8787/v1")
api_key = os.environ.get("API_KEY", "your-vibes-meta-session-cookie")

client = OpenAI(base_url=base_url, api_key=api_key)

# ------------------------------------------------------------------ chat
completion = client.chat.completions.create(
    model="vibes-chat",
    messages=[
        {"role": "system", "content": "You are a concise video editing assistant."},
        {"role": "user", "content": "Add a 5 second sunset clip to the timeline."},
    ],
)
print("assistant:", completion.choices[0].message.content)

# ------------------------------------------------------------- streaming
stream = client.chat.completions.create(
    model="vibes-chat",
    messages=[{"role": "user", "content": "Describe a cinematic city intro shot."}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta
    if delta.content:
        print(delta.content, end="", flush=True)
print()

# ---------------------------------------------------------------- images
image = client.images.generate(
    model="vibes-image",
    prompt="an origami fox on a desk, studio lighting",
    size="1024x1024",
    n=1,
)
print("image url:", image.data[0].url)

# ------------------------------------------------------------------ tts
with client.audio.speech.with_streaming_response.create(
    model="vibes-tts",
    voice="alloy",
    input="Hello from Vibes!",
) as response:
    response.stream_to_file("hello.mp3")
print("saved hello.mp3")

# ---------------------------------------------------------------- videos
# Sora-style async video generation (generate, poll, download):
video = client.post("/videos/generations", body={"model": "vibes-video", "prompt": "A red umbrella on a rainy neon street", "size": "1024x1792", "n": 1}, cast_to=dict)
job_id = video["id"]
print("video job:", job_id, video["status"])

import time
while True:
    job = client.get(f"/videos/generations/{job_id}", cast_to=dict)
    print("status:", job["status"], f"({job.get('progress', 0)}%)")
    if job["status"] in ("completed", "failed"):
        break
    time.sleep(10)

if job["status"] == "completed":
    print("video url:", job["videos"][0]["url"])
