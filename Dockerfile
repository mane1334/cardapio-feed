FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT=3001
WORKDIR /app
COPY package.json ./
COPY backend ./backend
COPY public ./public
COPY data ./data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME /data
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=4s --retries=3 CMD wget -qO- http://127.0.0.1:3001/health || exit 1
CMD ["node", "backend/server.js"]
