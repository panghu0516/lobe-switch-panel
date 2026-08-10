FROM node:20-alpine

WORKDIR /app

# ── cloudflared 隧道客户端（固定版本 2026.7.3，可复现；alpine 静态二进制直接可跑）──
RUN wget -q https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared \
    && chmod +x /usr/local/bin/cloudflared \
    && cloudflared --version

# 先拷贝依赖清单，最大化层缓存
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 再拷贝源码
COPY src ./src

# 入口脚本：后台起 cloudflared 隧道 + 前台起主服务
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 状态文件持久化目录（挂载 PVC）
RUN mkdir -p /data

EXPOSE 3000

ENV NODE_ENV=production
CMD ["/entrypoint.sh"]
