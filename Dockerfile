FROM node:20-alpine

WORKDIR /app

# 先拷贝依赖清单，最大化层缓存
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com

# 再拷贝源码
COPY src ./src

# 状态文件持久化目录（挂载 PVC）
RUN mkdir -p /data

EXPOSE 3000

ENV NODE_ENV=production
CMD ["node", "src/server.js"]
