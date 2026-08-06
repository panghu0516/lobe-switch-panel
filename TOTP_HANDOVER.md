# 项目交接：Lobe 一键开关控制面板 · TOTP 认证与 AUTH_MODE 配置说明

> 交接日期：2026-08-06。本说明覆盖 TOTP 动态码功能、AUTH_MODE 认证模式、二维码绑定、部署与验证。
> 代码仓库：`github.com/panghu0516/lobe-switch-panel`（master）

## 0. 项目现状速览

- 代码仓库：`github.com/panghu0516/lobe-switch-panel`（master）
- 技术栈：Node.js + Express + speakeasy + qrcode
- 容器端口：3000；命名空间：ns-feotrwac
- 白名单 GitHub：panghu0516
- 部署位置：Sealos（独立应用）

---

## 1. 认证体系（核心）

面板有**两层可叠加认证**，由 `AUTH_MODE` 环境变量统一控制。

### 1.1 认证模式（AUTH_MODE）

| AUTH_MODE | 行为 | 必配环境变量 |
|:--|:--|:--|
| `github` | 只要 GitHub 登录 | GITHUB_CLIENT_ID / SECRET / CALLBACK_URL |
| `totp` | **只要动态码，跳过 GitHub** | TOTP_SECRET |
| `both` | GitHub + 动态码（默认双保险） | 上述都要 |
| 空 / 其他值 | **拒绝访问**（防裸奔） | — |

> AUTH_MODE 未设置时默认 `both`。`totp` 模式下 GITHUB_* 三个变量可不填，认证仅凭动态码。

### 1.2 关键逻辑

- `requireAuth` 按 AUTH_MODE 分流：
  - `totp` 模式：`session.totpVerified` 为真即放行，不要求 session.user
  - `github`/`both` 模式：要求 GitHub 登录（session.user）
- `requireTotp`：`TOTP_SECRET` 为空则跳过；本会话已 `totpVerified` 则放行
- 首页 `/` 按 AUTH_MODE 跳转：
  - `totp` 模式未验证 → 跳 `/totp/verify`
  - 其他模式未登录 → 跳 `/auth/login`；已登录但未验证动态码 → 跳 `/totp/verify`
- 前端 `LOGIN_URL`、`logged-out` 页"重新登录"链接均按 AUTH_MODE 动态生成

---

## 2. 已实现端点

| 端点 | 作用 |
|------|------|
| GET /totp/setup | 未配置时生成 secret，展示**二维码 + base32 密钥**；已配置则提示改环境变量 |
| GET /totp/verify | 动态码输入页 |
| POST /totp/verify | 校验动态码，通过则 session.totpVerified=true 并跳首页 |
| 中间件 requireTotp | 串联到 /status、/pause、/resume |
| callback 后 | 若 TOTP 启用且未验证，跳 /totp/verify |
| 首页 / | 按 AUTH_MODE 跳转（见上） |

---

## 3. 环境变量完整清单

```plain
PORT=3000
GITHUB_CLIENT_ID=            # github / both 模式需要
GITHUB_CLIENT_SECRET=        # github / both 模式需要
GITHUB_CALLBACK_URL=         # github / both 模式需要
ALLOWED_GITHUB_LOGIN=panghu0516
SESSION_SECRET=              # 随机长串，openssl rand -hex 32
KUBE_API_SERVER=             # Sealos k8s server 地址
KUBE_SA_TOKEN=               # 最小权限 SA token
KUBE_NAMESPACE=ns-feotrwac
APPS_CONFIG=[{"name":"lobehub-v2","kind":"StatefulSet","replicas":1},...]
STATE_FILE=/data/state.json
TOTP_SECRET=                 # 绑定生成的 base32 密钥（totp / both 模式需要）
AUTH_MODE=both               # github | totp | both（空则拒绝访问）
```

---

## 4. 首次绑定 TOTP（关键步骤）

⚠️ 核心铁律：**TOTP_SECRET 为空时，每次访问 /totp/setup 都会重新生成一个新密钥**。

1. Sealos 重新构建 + 重新部署（认最新 master）
2. **先清空 / 删除 TOTP_SECRET** → 重新部署（否则 setup 页显示"已启用"不生成新密钥）
3. 浏览器访问 `https://<域名>/totp/setup`
4. 页面显示**二维码 + base32 密钥**，用微软 Authenticator 扫码
5. ⚠️ **扫码后千万别刷新页面**（刷新会换新密钥，导致绑定与填入不一致）
6. 把显示的 base32 密钥原样（不带空格换行）填入 `TOTP_SECRET` → 重新部署
7. 验证：Authenticator 里的动态码应为 **6 位**数字

---

## 5. 重新绑定（已启用后）

代码**不提供重置入口**（安全考虑，改环境变量更稳妥）：

1. Sealos 环境变量中**更换 TOTP_SECRET** 为新值
2. 重新部署
3. 在 Authenticator 中删除旧账户、重新扫码绑定新密钥

---

## 6. 验证流程

- [ ] `/totp/setup` 未配置时显示二维码 + 密钥
- [ ] AUTH_MODE=totp：访问首页直接跳 `/totp/verify`，不经过 GitHub
- [ ] 错误动态码 → 401 拒绝
- [ ] 正确动态码 → 进入面板
- [ ] 退出后重登 → 需重新输动态码
- [ ] 自家设备不退出 → session 有效期内免输

---

## 7. 已知坑与注意

1. **TOTP_SECRET 为空时 setup 页每次访问都重新生成密钥** → 绑定后不可刷新页面
2. **body parser 必须配**（express.json + urlencoded）否则动态码验证恒失败
3. **用 speakeasy 而非 otplib**：otplib 新版是 ESM，CommonJS 下报错
4. **TOTP_SECRET 固定**：绑定后不可随意改，改后需重新绑定
5. **服务器时间**：TOTP 依赖集群时钟，window:1 容忍 1 步漂移
6. **GitHub force_login 无效**：GitHub 不认此参数，别再加
7. **动态码标准 6 位**：speakeasy 默认 digits=6；若 Authenticator 显示 8 位，多半绑定了别的服务
8. **改含 HTML 代码用精确行级替换**，避免误删其他端点（踩过坑）

---

## 8. 安全边界

- 白名单固定 panghu0516（GitHub 模式）
- TOTP 动态码是第二道验证（针对陌生设备）
- KUBE_SA_TOKEN 最小权限（仅 4 个应用 scale）
- 凭证 value 绝不读写输出，只经 Sealos 环境变量注入
- AUTH_MODE 为空/未知 → 拒绝访问，防止裸奔
