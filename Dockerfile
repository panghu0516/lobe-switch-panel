FROM node:20-alpine

WORKDIR /app

# ── cloudflared 隧道客户端（固定版本 2026.7.3，可复现；alpine 静态二进制直接可跑）──
# 下载源：GitHub 直连 → ghproxy 镜像 → gh-proxy.com 镜像（ACR 国内构建环境 GitHub 可能超时）
RUN set -eux; \
    mkdir -p /usr/local/bin; \
    for url in \
      "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64" \
      "https://ghfast.top/https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64" \
      "https://gh-proxy.com/https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64" \
    ; do \
      echo ">> try: $url"; \
      if wget -q --timeout=60 -O /usr/local/bin/cloudflared "$url"; then \
        chmod +x /usr/local/bin/cloudflared; \
        if cloudflared --version >/dev/null 2>&1; then echo "OK: cloudflared downloaded"; break; fi; \
      fi; \
      rm -f /usr/local/bin/cloudflared; \
    done; \
    test -x /usr/local/bin/cloudflared

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
