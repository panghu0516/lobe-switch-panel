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
