FROM node:22-slim

WORKDIR /app

# yt-dlp for scripts/generate-video-previews.js (video preview clips). The
# standalone binary needs no Python; ffmpeg is not needed - the script pulls
# a video-only stream and Cloudinary does the trim/transcode.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp \
 && chmod +x /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "app.js"]
