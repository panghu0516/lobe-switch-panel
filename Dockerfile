FROM node:20-alpine

WORKDIR /app

# ── cloudflared 隧道客户端（固定版本 2026.7.3，可复现；alpine 静态二进制直接可跑）──
# 构建机为海外环境，GitHub 官方直连即可；timeout 300 设总时长上限，防止网络抖动把构建拖卡
RUN set -eux; \
    mkdir -p /usr/local/bin; \
    timeout 300 wget -q --timeout=60 -O /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/download/2026.7.3/cloudflared-linux-amd64"; \
    chmod +x /usr/local/bin/cloudflared; \
    cloudflared --version >/dev/null 2>&1; \
    echo "OK: cloudflared downloaded"

# 先拷贝依赖清单，最大化层缓存
COPY package.json ./
# 海外构建机直接用官方 registry，避免国内镜像在海外绕路
RUN npm install --omit=dev --registry=https://registry.npmjs.org

# 再拷贝源码
COPY src ./src

# 入口脚本：后台起 cloudflared 隧道 + 前台起主服务
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 状态文件持久化目录（挂载 PVC）
RUN mkdir -p /data

# 3000 = 主面板；8080 = auth-proxy 门卫（Cookie 登录 + 反代，公网直连入口）
EXPOSE 3000 8080

ENV NODE_ENV=production
CMD ["/entrypoint.sh"]
