# ShortFactory — Dockerfile
# Node 20 + ffmpeg + yt-dlp
FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates curl \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

# Crée les dossiers nécessaires (legal est déjà dans le COPY)
RUN mkdir -p tmp output data public/legal

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
