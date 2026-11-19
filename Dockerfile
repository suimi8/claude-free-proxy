FROM node:22-alpine

WORKDIR /app

# 拷贝依赖配置
COPY package*.json ./

# 安装生产依赖（如 undici）
RUN npm install --omit=dev

# 拷贝核心源代码与静态资产
COPY src/ ./src/
COPY web/ ./web/
COPY config/ ./config/
COPY start.mjs ./

# 暴露 WebUI 与反代 API 端口
EXPOSE 8787

# 运行环境变量
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8787

# 启动服务
CMD ["node", "src/openai-proxy.mjs"]
