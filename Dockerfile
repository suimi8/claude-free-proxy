FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data && chown node:node /app/data
COPY src/ ./src/
COPY web/webui.html ./web/webui.html
COPY config/*.example.json ./config/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/app/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s CMD ["node", "src/doctor.mjs"]
CMD ["node", "src/openai-proxy.mjs"]
