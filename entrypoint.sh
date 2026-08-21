#!/bin/sh
# lobe-switch-panel 入口脚本
# 职责：
#   1. 若配置了 TUNNEL_TOKEN 则后台启动 cloudflared 隧道（gateway/gateway8787 等过渡期入口）
#   2. 若配置了 DOOR_SECRET 则后台启动 auth-proxy 门卫（:8080，TOTP 动态码登录 + 反代，公网直连入口）
#   3. 前台始终运行主服务（面板本身不可因隧道/门卫故障而挂掉）
# 用法：CMD ["/entrypoint.sh"]；环境变量由 Sealos 注入。

set -u

TUNNEL_TOKEN="${TUNNEL_TOKEN:-}"
DOOR_SECRET="${DOOR_SECRET:-}"

# ── 日志持久化：/data 为挂载的 PVC，全部服务日志落盘于此（容器重启不丢）──
LOG_DIR="${LOG_DIR:-/data/logs}"
mkdir -p "$LOG_DIR"
# 简单轮转：日志文件超过 20MB 时压缩保留 .old（busybox gzip）
rotate_log() {
  f="$1"
  if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt 20971520 ]; then
    gzip -c "$f" > "${f}.old.gz" 2>/dev/null || true
    : > "$f"
    echo "[entrypoint] 轮转日志: $f (>20MB 已压缩为 .old.gz)"
  fi
}

# ── 后台启动 cloudflared 隧道 ──
if [ -n "$TUNNEL_TOKEN" ]; then
  echo "[entrypoint] TUNNEL_TOKEN 已配置，启动 cloudflared 隧道..."
  if /usr/local/bin/cloudflared --version >/dev/null 2>&1; then
    rotate_log "$LOG_DIR/cloudflared.log"
    nohup /usr/local/bin/cloudflared tunnel run --token "$TUNNEL_TOKEN" \
      >> "$LOG_DIR/cloudflared.log" 2>&1 &
    echo "[entrypoint] cloudflared 已后台启动 (PID $!)，日志: $LOG_DIR/cloudflared.log"
    sleep 3
  else
    echo "[entrypoint] 警告: cloudflared 二进制不可用，跳过隧道，仅运行面板+门卫"
  fi
else
  echo "[entrypoint] 未配置 TUNNEL_TOKEN，仅运行面板+门卫（无隧道模式）"
fi

# ── 后台启动 auth-proxy 门卫（:8080，TOTP 动态码登录 + 反代）──
if [ -n "$DOOR_SECRET" ]; then
  echo "[entrypoint] DOOR_SECRET 已配置，启动 auth-proxy 门卫 (src/auth-proxy.js)..."
  rotate_log "$LOG_DIR/auth-proxy.log"
  nohup node src/auth-proxy.js >> "$LOG_DIR/auth-proxy.log" 2>&1 &
  echo "[entrypoint] auth-proxy 已后台启动 (PID $!)，日志: $LOG_DIR/auth-proxy.log"
  sleep 1
else
  echo "[entrypoint] 未配置 DOOR_SECRET，跳过门卫（无认证直连，仅调试）"
fi

# ── 前台运行主服务（保持容器存活）──
echo "[entrypoint] 启动 node src/server.js ...（日志: $LOG_DIR/server.log + 容器 stdout）"
rotate_log "$LOG_DIR/server.log"
exec node src/server.js 2>&1 | tee -a "$LOG_DIR/server.log"