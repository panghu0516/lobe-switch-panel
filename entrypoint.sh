#!/bin/sh
# lobe-switch-panel 入口脚本
# 职责：若配置了 TUNNEL_TOKEN 则后台启动 cloudflared 隧道（连接 lobe.tigerhu.xyz → lobehub-v2），
#       无论隧道是否可用，前台始终运行主服务（面板本身不可因隧道故障而挂掉）。
# 用法：CMD ["/entrypoint.sh"]；环境变量 TUNNEL_TOKEN 由 Sealos 注入。

set -u

TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"

# ── 后台启动 cloudflared 隧道 ──
if [ -n "$TUNNEL_TOKEN" ]; then
  echo "[entrypoint] TUNNEL_TOKEN 已配置，启动 cloudflared 隧道..."
  # 先确认二进制可用
  if /usr/local/bin/cloudflared --version >/dev/null 2>&1; then
    # nohup 后台运行，日志落 /var/log/cloudflared.log；失败不阻塞主服务
    nohup /usr/local/bin/cloudflared tunnel run --token "$TUNNEL_TOKEN" \
      >> /var/log/cloudflared.log 2>&1 &
    echo "[entrypoint] cloudflared 已后台启动 (PID $!)，日志: /var/log/cloudflared.log"
    # 给隧道几秒握手时间，避免启动风暴
    sleep 3
  else
    echo "[entrypoint] 警告: cloudflared 二进制不可用，跳过隧道，仅运行面板"
  fi
else
  echo "[entrypoint] 未配置 TUNNEL_TOKEN，仅运行面板（无隧道模式）"
fi

# ── 前台运行主服务（保持容器存活）──
echo "[entrypoint] 启动 node src/server.js ..."
exec node src/server.js
