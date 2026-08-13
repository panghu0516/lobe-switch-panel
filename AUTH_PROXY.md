# auth-proxy —— 公网入口 Cookie 登录门卫

LobeHub 公网入口统一认证网关，并入驻本镜像（`src/auth-proxy.js`），与面板（`:3000`）、cloudflared 隧道三进程共存。

## 原理

```
公网 → Sealos 入口/证书 → 容器 :8080 (auth-proxy)
   ├─ 未登录 / Cookie 无效 → 302 → /login（内嵌极简登录页，无外部资源）
   ├─ POST /login 密码错   → 302 /login?err=1
   ├─ POST /login 密码对   → Set-Cookie(HMAC 签名, HttpOnly, SameSite=Lax, 7d) → 302 回原路径
   ├─ /logout              → 清 Cookie → 302 /login
   └─ Cookie 有效、Host 命中路由表 → 反代内网服务（流式透传，支持 SSE）
```

## 环境变量（Sealos 注入，真值不进仓库）

| 变量 | 必填 | 说明 |
|---|---|---|
| `DOOR_PASSWORD` | ✅ | 登录密码；缺失或为空 → 门卫拒绝启动（容器日志可见） |
| `DOOR_SECRET` | ✅ | Cookie 签名密钥，**≥16 字节**；缺失/过短 → 拒绝启动 |
| `DOOR_COOKIE_TTL` | 否 | Cookie 有效期秒，默认 `604800`（7 天） |
| `DOOR_PORT` | 否 | 监听端口，默认 `8080`，与默认路由表的 `lobe/panel` 域名映射配套 |
| `DOOR_ROUTES` | 否 | JSON `{"host":"target"}`，与内置映射合并（内置默认：`lobe.tigerhu.xyz → lobehub-v2:3210`、`panel.tigerhu.xyz → 127.0.0.1:3000`） |
| `DOOR_DISABLE` | 否 | `"1"` 时跳过认证直通（仅调试） |

## 约定

- **健康检查**：`GET /health -> 200 OK`（Sealos 探针配在 8080）
- **放行路径**：`/health`、`/login`、`/logout`；其余全部先过认证；未登录一律 `302 /login?next=<原路径>`
- **反代**：仅普通 HTTP（流式，SSE 可透传）；WebSocket upgrade 返回 501（gateway 设备接入走隧道，不经过门卫）
- **安全**：Cookie HMAC 签名防篡改、过期自动失效；登录页 `Cache-Control: no-store`；`next` 仅允许站内相对路径（防开放重定向）