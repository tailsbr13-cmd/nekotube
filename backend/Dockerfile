FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p data && chown -R node:node /app
USER node
ENV NODE_ENV=production PORT=3001
EXPOSE 3001
CMD ["node", "server.js"]
