FROM node:20-slim

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
# Render sets PORT; default matches config.js fallback.
EXPOSE 10000

CMD ["node", "src/index.js"]
