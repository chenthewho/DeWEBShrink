# =============================================================================
#  deweb-shrink · MCP over Streamable HTTP
#  ---------------------------------------------------------------------------
#  为什么用 Docker 而不是把本地目录 rsync 上去：
#    sharp 和 esbuild 都是**平台相关的原生模块**（Linux x64 vs macOS arm64 的
#    二进制完全不同）。本地 node_modules 复制到服务器上必然启动失败。
#    镜像里 npm ci 会拉到匹配 Linux 的预编译二进制，干净且可复现。
#
#  构建：docker build -t deweb-shrink:0.3.0 .
#  运行：docker run -d --name deweb-shrink -p 8787:8787 \
#          -e DEWEB_SHRINK_API_KEY=你的密钥 deweb-shrink:0.3.0
# =============================================================================

FROM node:22-slim

# sharp 自带预编译二进制（0.33+ 通过 optionalDependencies 分发），
# 所以这里不需要 apt 装 libvips；只装一个健康检查用得到的 curl 兜底。
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 依赖单独一层：只要 package.json 没变，重建时不用重装
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 源码（测试和 fixtures 不进镜像 —— fixtures 有 13 MB，而且只是测试素材）
COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

EXPOSE 8787

# 探活：不用 curl，直接用 node 免得依赖额外工具
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 用非 root 跑（node 镜像自带 node 用户）
USER node

CMD ["node", "src/http.js"]
