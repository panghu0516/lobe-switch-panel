# Lobe 一键开关控制面板 · 配置操作手册

> 虎先生照做版。记录面板部署在 Sealos 上的全部操作：在哪个终端跑什么命令、需填的环境变量、测试流程。

## 0. 核心信息速览

| 项 | 值 |
|----|-----|
| 命名空间 | `ns-feotrwac` |
| 容器端口 | 3000 |
| 白名单 GitHub 用户名 | `panghu0516` |
| 纳管应用 | lobehub-v2(StatefulSet)、lobehub-paradedb(StatefulSet)、my-devbox(StatefulSet)、device-gateway(Deployment) |

## 1. 终端环境说明

- **Sealos 终端** = Sealos 控制台云终端（跑 kubectl 用）
- **Windows 终端** = 本地 PowerShell/CMD（本项目基本不用）
- 本项目 kubectl 操作全部在 **Sealos 终端** 执行

## 2. 命令清单（均在 Sealos 终端执行）

### 2.1 确认集群（防止连错）
```bash
kubectl config current-context
```
确认对准 `ns-feotrwac`。

### 2.2 获取 Kube API 地址
```bash
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'
```

### 2.3 应用 RBAC + 拿 token
```bash
kubectl apply -f rbac.yaml
kubectl create token lobe-switch-sa -n ns-feotrwac --duration=8760h
```

### 2.4 RBAC 权限预检（必须带资源名，否则恒返回 no）
```bash
kubectl get sa,role,rolebinding -n ns-feotrwac | grep lobe-switch
kubectl auth can-i patch statefulsets/scale lobehub-v2 --as=system:serviceaccount:ns-feotrwac:lobe-switch-sa -n ns-feotrwac
kubectl auth can-i get statefulsets lobehub-v2 --as=system:serviceaccount:ns-feotrwac:lobe-switch-sa -n ns-feotrwac
kubectl auth can-i patch deployments/scale device-gateway --as=system:serviceaccount:ns-feotrwac:lobe-switch-sa -n ns-feotrwac
kubectl auth can-i get deployments device-gateway --as=system:serviceaccount:ns-feotrwac:lobe-switch-sa -n ns-feotrwac
```
预期全部 yes。老版本 kubectl 报错时改用 `--subresource=scale` 语法。

## 3. 环境变量清单（Sealos 填）

### 第一批（现在填，8 个）
```
PORT = 3000
ALLOWED_GITHUB_LOGIN = panghu0516
SESSION_SECRET = <openssl rand -hex 32 生成>
KUBE_API_SERVER = https://kubernetes.default.svc.cluster.local:443
KUBE_SA_TOKEN = <阶段2拿到的token>
KUBE_NAMESPACE = ns-feotrwac
APPS_CONFIG = [{"name":"lobehub-v2","kind":"StatefulSet","replicas":1},{"name":"lobehub-paradedb","kind":"StatefulSet","replicas":1},{"name":"my-devbox","kind":"StatefulSet","replicas":1},{"name":"device-gateway","kind":"Deployment","replicas":1}]
STATE_FILE = /data/state.json
```

### 第二批（拿到域名后填，3 个）
```
GITHUB_CLIENT_ID = <GitHub OAuth App 的 Client ID>
GITHUB_CLIENT_SECRET = <GitHub OAuth App 的 Client Secret>
GITHUB_CALLBACK_URL = https://<面板域名>/auth/callback
```

## 4. Sealos 部署步骤

1. 应用管理 → 新建应用
2. 镜像：用 `panghu0516/lobe-switch-panel` 构建的镜像
3. 容器端口：3000
4. 填第一批环境变量（8 个）
5. 挂载 PVC 到 `/data`（保存暂停状态）
6. 部署 → 拿域名
7. 建 GitHub OAuth App（callback 填域名）→ 回 Sealos 补填 OAuth 3 个 → 重新部署
8. 测试

## 5. 测试流程

1. 浏览器访问域名 → GitHub 登录（白名单 panghu0516）
2. 看状态：4 个应用运行中/副本 1
3. 一键暂停 → Sealos 确认 replicas 全 0
4. 一键恢复 → 确认全回 1

## 6. 坑与注意

- 端口必须 3000（填 80 会导致探活失败）
- 不要用 Sealos"启动命令"传参，一切靠环境变量
- 每次暂停前确认无重要会话在跑（破坏性操作）
- KUBE_SA_TOKEN 和 GITHUB_CLIENT_SECRET 绝不进代码仓库/日志
- TLS：集群内访问 API server 需处理内部 CA，代码已自动适配（启动日志打印 `[kube] TLS: ...`）
- can-i 预检带 resourceNames 规则必须带资源名，否则恒返回 no
- `Warning: auto-generated secret-based tokens` 是无害提示
- 登录一次 7 天免登录属正常设计


## 新增功能说明（v2）

### 🎛 模式切换
- 页面"模式切换"卡片可一键切换三套配置（日常/并发Pro/开发Max）
- 每套配置调整 LobeHub + Devbox + ParadeDB 的 CPU/内存（requests=limits）
- ⚠️ ParadeDB 为数据库：切换会 patch 其 resources 并可能触发 StatefulSet 滚动重启；三套模式默认对 ParadeDB 保持一致（500m/1Gi），如需差异请页面"编辑模式数值"或环境变量 MODE_*_PARADEDB_* 调整，并评估数据库影响
- 切换前自动存档当前值，失败自动回滚，切换后轮询验证生效
- 三套模式的数值可在代码 DEFAULT_MODES 中调整，或通过页面 POST /modes 接口（当前页面未暴露编辑框，默认取代码值）

### 📊 资源展示
- GET /resources：返回 LobeHub + Devbox 的当前 CPU/内存配置 + 对应 PVC 容量

### 💾 数据库备份（内化）
- 面板自调度（node-cron，北京时间 Asia/Shanghai），不再依赖独立 CronJob 的调度
- 页面可配置：启用/停用、执行时间（每行一个 "HH:MM"，北京时间）
- 到点面板创建一次性 Job（复用 BACKUP_CRONJOB 的镜像和 env，凭证不落地面板存储）
- 备份资源配额：100m CPU / 128Mi 内存（复用原 CronJob 硬约束）
- 页面可"立即备份"并查看最近备份 Job 状态

### 🔐 新增/变更环境变量
- BACKUP_CRONJOB: 模板 CronJob 名（默认 pg17-backup-1-2）
- BACKUP_NAMESPACE: 备份 CronJob 所在命名空间（默认同 KUBE_NAMESPACE）
- TZ: 容器时区需设为 Asia/Shanghai 以保证备份调度按北京时间（Sealos 环境变量填 TZ=Asia/Shanghai）

### 🛠 模式数值环境变量（v2.1 新增，可选）
三个模式的具体数值可用环境变量覆盖默认值，格式：`MODE_<KEY>_<TARGET>_<FIELD>`
- KEY: DAILY / PRO / DEVELOP
- TARGET: LOBEHUB / DEVBOX
- FIELD: CPU / MEM
- 示例：`MODE_DEVELOP_DEVBOX_MEM=3Gi`、`MODE_DAILY_LOBE_CPU=300m`
- 优先级：页面保存的配置(state.json) > 环境变量(默认值) > 内置默认值
- 页面"⚙️ 编辑模式数值"可直接改三套数值并保存；"↩️ 恢复默认"回到环境变量/内置默认

### 🕐 备份调度环境变量（v2.1 新增，可选）
- BACKUP_TIMES: 逗号分隔的执行时间（北京时间），如 `02:30,04:30`
- BACKUP_ENABLED: true/false，是否启用定时备份
- 仅在 state.json 缺失/重置时作为默认值；页面保存后以页面为准
- ⚠️ state.json 默认存 `/data/state.json`，若 Sealos 未给面板挂持久卷，容器重启会丢页面配置（环境变量仍兜底默认值）

### ⚠️ RBAC 需更新
新增模式切换/资源/备份功能需要重新应用新的 rbac.yaml（主资源 patch + PVC 读取 + batch Job 权限）。
务必先 `kubectl apply -f rbac.yaml` 再部署新代码。

## 新增功能说明（v3 · 模型服务商代理）

### 🪄 是什么
- 面板 3000 端口新增 `/v1/*` 路由：`/v1/embeddings`（embedding 拆批代理）+ `/v1/chat/completions`（透传）
- 解决 LobeHub 知识库向量化时「单请求超 20 条 embedding 报 400」问题：自动把请求拆成 ≤20 条/批并发发给上游（DashScope 兼容格式），再按原序合并返回
- 无需新增端口/环境变量，Sealos 部署配置不变；代码在 `src/embedding-proxy.js`

### 🔌 LobeHub 侧配置
1. 服务商添加 OpenAI 兼容服务商
2. BaseURL 填：`http://lobe-switch-panel-<你的Service名>.ns-<ns>:3000/v1`（注意带 `/v1`）
3. API Key 填：上游 DashScope key 或用 switch-panel `?type=dashscope` 模板
4. 模型服务商改用 text-embedding-3-small（自动映射 qwen3.7-text-embedding）

### 🛡 防滥用（可选）
- 环境变量 `EMBEDDING_PROXY_TOKEN` 设置后，请求必须带 `X-Proxy-Token: <值>` 头，否则 401
- LobeHub 服务商设置里无法自定义头时，可搭配`?type=dashscope&token=<值>`查询参数

### 🧪 回归测试
```bash
node test-proxy.js   # mock 上游，验证 1/49/100 条拆批合并 + chat 透传 + 非法输入
```

## 环境变量转义约定（# 号陷阱）

**Sealos env 中值一旦含 `#` 字符就会被截断**（连 `\#` 也会被截）。因此所有变量填写侧 **100% 不允许出现裸 `#`**：

| 想要的值 | Sealos 里填 | 运行时还原 |
|---|---|---|
| `p@ss#word` | `p@ss%23word` | `p@ss#word` |
| `AK#KEY` | `AK%23KEY` | `AK#KEY` |
| 值本身要字面 `%23` | `%2523` | `%23` |

- 涉及变量：`PG_URI` / `S3_URI` / `S3_BUCK` / `S3_NAME` / `KUBE_SA_TOKEN` / `SESSION_SECRET` / `TOTP_SECRET` / `GITHUB_CLIENT_SECRET` / `BACKUP_PULL_SECRET` / `EMBEDDING_PROXY_TOKEN`
- 实现：`src/server.js` 与 `src/embedding-proxy.js` 的 `unescapeEnvVal()`，单次正则替换不递归
- 旧 `\#` 写法作废（还原函数已改为 `%23` 语义），重部署时请把已填的 `\#` 改成 `%23`

## 日志持久化（/data/logs）

容器内 `/data` 是挂载的 PVC，全部服务日志落盘于此，容器重启不丢；超过 20MB 自动轮转压缩为 `.old.gz`：

| 服务 | 日志路径 |
|---|---|
| cloudflared 隧道 | `/data/logs/cloudflared.log` |
| auth-proxy 门卫 | `/data/logs/auth-proxy.log` |
| 主面板 server.js | `/data/logs/server.log`（同时保留容器 stdout） |

可用 `LOG_DIR` 环境变量覆盖日志目录（默认 `/data/logs`）。

