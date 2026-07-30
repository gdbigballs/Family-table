FROM node:24-bookworm-slim

WORKDIR /app
COPY package.json ./
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/data
EXPOSE 15515

CMD ["node", "server.js"]
