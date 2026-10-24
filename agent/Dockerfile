# The Mastra chat agent service (ADR-0016/0018): the free
# conversational agent — deepseek-v4.1-flash via Avalai, the Book pool
# (through the Python seam) and web search as its tools — built with
# `mastra build` and served by the generated Hono server. The LibSQL
# thread store lives on the mounted /data volume
# (MASTRA_STORAGE_URL), so a container rebuild never throws a
# Learner's conversation memory away — the same rule the session
# store follows (T27 stage 3).
FROM node:22-alpine

WORKDIR /app

# Install first so the layer caches between source-only changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

ENV NODE_ENV=production \
    PORT=4111 \
    MASTRA_HOST=0.0.0.0 \
    MASTRA_STORAGE_URL=file:/data/mastra.sqlite \
    MASTRA_STUDIO_PATH=/app/.mastra/output/studio

EXPOSE 4111

# mastra build's own start line: the generated server in .mastra/output.
CMD ["node", ".mastra/output/index.mjs"]
