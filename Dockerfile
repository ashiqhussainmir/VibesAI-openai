# Build a slim production image for Node-based hosts (Render, Railway, Fly.io, VPS)
FROM node:22-slim AS base
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts || npm install --ignore-scripts

COPY . .

ENV PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "src/node.ts"]
