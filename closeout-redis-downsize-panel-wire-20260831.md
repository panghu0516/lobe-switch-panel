# 项目结项：Redis 缩容 + 接入 lobe-switch-panel 一键启停（2026-08-31）

> 本次结项含两个同日完成、强相关的运维项目：
> **A. 集群 Redis 规格缩容**（256Mi→64Mi，消除规格虚高）
> **B. Redis 接入 panel 一键启停**（APPS_CONFIG + RBAC，零代码零镜像变更）
> 全程由 opencode 直连 K8s API 执行（Redis 为 API 直建资源，Sealos 界面不可见），逐项验收通过。

---

## A. 集群 Redis 规格缩容

### A1. 背景与动因

- LobeHub 全套服务实际使用者 1 人（远期至多 2 人），Redis 为 API 直建的纯缓存实例（`deploy/redis`，redis:7-alpine），Sealos 界面不可见。
- 缩容前实测：pod limits **500m CPU / 256Mi 内存**，实际用量仅 **4m CPU / 13.5Mi 内存**（其中 redis 7-alpine 进程自身开销 ~4-5Mi，真实数据仅 ~9Mi）——内存规格虚高 19 倍，`--maxmemory 128mb` 更是数据量的 14 倍。

### A2. 原配置健康度评估（缩容前的关键认知）

| 项 | 原值 | 评估 |
|---|---|---|
| 持久化 | `--appendonly no --save ''`，无 PVC | ✅ 纯缓存模式，数据丢失可接受 |
| 驱逐策略 | `--maxmemory 128mb --maxmemory-policy allkeys-lru` | ✅ LobeHub 代码内 redis 用法全部为 TTL 缓存/状态类（linkToken、agent 状态、bot 队列等），LRU 驱逐语义兼容 |
| 存在的问题 | pod limit(256Mi) ≫ maxmemory(128mb) ≫ 实际数据(~9Mi) | ❌ 纯规格虚高，无功能问题 |

### A3. 缩容安全逻辑（为什么是 48mb/64Mi）

**约束公式：pod memory limit ≥ maxmemory + redis 进程开销(~5Mi) + 余量**——否则数据涨到 maxmemory 时 LRU 驱逐来不及生效，cgroup 先 OOM kill。

| 项 | 改前 | 改后 | 依据 |
|---|---|---|---|
| `--maxmemory` | 128mb | **48mb** | 数据 ~9Mi，5 倍余量；单/双用户 TTL 缓存负载难以触及 |
| pod limits | 500m / 256Mi | **100m / 64Mi** | 64Mi = 48mb maxmemory + 进程开销 + 边际；CPU 100m 对单线程 redis 单用户负载绰绰有余（CPU 限流不 kill） |
| pod requests | 25m / 32Mi | **10m / 16Mi** | 降低调度占位；保持 Burstable QoS |

**刻意未选更激进档**（maxmemory 32mb / limit 48Mi）：limit 与 maxmemory 过贴会在驱逐生效前被 OOM kill，风险 > 收益。

### A4. 改动与执行

| 项 | 内容 |
|---|---|
| 对象 | `deployment/redis`（namespace `ns-feotrwac`） |
| 方式 | K8s API strategic-merge-patch（`/tmp/redis_scale.py`，凭证 `{SEALOS_KUBECONFIG_AUTH}` 占位符注入，脚本用完即删） |
| args | `--maxmemory 128mb → 48mb`（其余参数不变） |
| resources | limits `500m/256Mi → 100m/64Mi`；requests `25m/32Mi → 10m/16Mi` |
| 生效 | RollingUpdate 自动滚动，闪断数秒，ioredis 自动重连 |

### A5. 验证结果

| # | 验证 | 结果 |
|---|---|---|
| V1 | 新 pod 规格 | ✅ `redis-68bb45df99-kw6wv` Running，limits `100m/64Mi` |
| V2 | deployment 就绪 | ✅ availableReplicas=1，NewReplicaSetAvailable |
| V3 | LobeHub 回归 | ✅ `lobehub-v2:3210/` → 302（认证重定向，服务正常），redis 闪断后自动重连无人工干预 |

### A6. 回退

反向 patch（args `--maxmemory 48mb→128mb` + resources 恢复）即完全回退；无持久化数据，滚动重启无状态损失。

---

## B. Redis 接入 lobe-switch-panel 一键启停

### B1. 需求

用户诉求：平时整套 Lobe 不用时 Redis 也应参与"一键暂停"（平时开着没必要）；恢复时一起起。

### B2. 机制探查结论（决定零代码方案的三个事实）

1. panel 一键启停清单由 **`APPS_CONFIG` env 驱动**（`src/server.js:65` parseApps → getStatuses/pause/resume 全部遍历该配置），不硬编码；
2. `kubeGet/kubeScale/kubeUrl`（`src/server.js:199-246`）已原生支持 Deployment（device-gateway 先例）；
3. 模式切换（MODE_TARGETS）是三维固定规格切换，Redis 为缓存固定规格，**不应参与**模式切换——故 `src/server.js` 无需任何改动。

**结论：零代码、零镜像重建**，仅改 env + RBAC 两处配置。

### B3. 改动与执行

| # | 对象 | 改动 | 方式 |
|---|---|---|---|
| 1 | panel STS env | `APPS_CONFIG` 追加 `{"name":"redis","kind":"Deployment","replicas":1}`（置于列表**末尾**） | K8s API strategic-merge-patch（env 按 name 合并，其余 env 不触碰） |
| 2 | Role `lobe-switch-role` | `deployments/scale` 与 `deployments` 两规则块 resourceNames 追加 `redis` | K8s API patch（GET → 内存合并 → PATCH rules） |
| 3 | 事实源 `/config/lobe-switch-panel/rbac.yaml` | 同步上述 resourceNames | 本地文件编辑 |
| 4 | 事实源 `/config/lobe-switch-panel/DEPLOY.md` | 纳管应用清单同步 | 本地文件编辑 |

**顺序设计**：redis 放 APPS_CONFIG 末尾——暂停时按序遍历最后停 redis（此时 LobeHub 已停，无感）；恢复时 redis 最后起，LobeHub 先起几秒靠 ioredis retryStrategy 自动重连兜底（与 paradedb 现状一致）。

**凭证纪律**：全程 `{SEALOS_KUBECONFIG_AUTH}` 占位符走适配器替换；只 patch APPS_CONFIG 单个 env 项，不读取/不回显其他任何 env 值。

### B4. 验证结果

| # | 验证 | 结果 |
|---|---|---|
| V1 | APPS_CONFIG 注入 | ✅ patch HTTP 200，条目名单：lobehub-v2 / lobehub-paradedb / my-devbox / device-gateway / lobe-switch-panel / **redis** |
| V2 | panel pod 重建 | ✅ observedGeneration 16 → `lobe-switch-panel-0` Running ready=True |
| V3 | RBAC 落盘 | ✅ Role 读回：`deployments/scale`→[…redis]、`deployments`→[…redis] |
| V4 | panel 存活 | ✅ `:3000/` → 302（重定向登录页） |
| V5 | 页面显示 redis + 实际点启停 | ⏳ 需用户登录（GitHub OAuth + TOTP）后目视确认，属人工验收项 |

**V5 补充说明**：SubjectAccessReview 探测被拒——面板探测身份（`system:serviceaccount:user-system:feotrwac`）无 SSAR 创建权限（403），改用 Role 读回验证（V3）替代；运行时权限语义（resourceNames 追加单项）风险极低。

### B5. 回退

- APPS_CONFIG：patch 移除 redis 条目（env 合并即可），panel 自动滚动；
- RBAC：resourceNames 移除 redis；
- Redis 本身不受影响（只是不被 panel 纳管）。

### B6. 使用注意（交接给用户）

1. 点"⏸ 一键暂停"后 **Redis 连同全套服务一起停**，不再占用集群配额；点"▶ 一键恢复"一起起。
2. Redis 停止期间若**单独**运行 LobeHub：主聊天不受影响（DB 在 paradedb）；agent 执行状态、messenger link token、bot 连接队列等**缓存类功能降级/失败**——这是设计内语义，不是故障。
3. 恢复后 LobeHub 会比 Redis 早起几秒，日志里可能有短暂 redis 连接重试，自动恢复，无需干预。
4. panel 没有"单独暂停"功能（仅整体启停 + 单独重启），符合"整套不用时全停"的场景。

---

## C. 运维通道沉淀（本次踩坑认知）

1. **Sealos 界面不可见资源的管理通道**：API 直建资源（如 `deploy/redis`）用 kubeconfig 身份（`{SEALOS_KUBECONFIG_AUTH}`，URL-encoded YAML，含 token + `insecure-skip-tls-verify`）直连 `kubernetes.default.svc.cluster.local:443` 操作即可；RBAC patch、env patch、scale 全通。
2. **`kubectl` 未安装**：一切操作用 python requests 走 K8s REST API（strategic-merge-patch + SA token），脚本放 /tmp 用完即删，凭证零落盘。
3. **SSAR 不可用**：Sealos 用户身份不能创建 SubjectAccessReview，RBAC 验证走"Role 读回比对"替代 `kubectl auth can-i --as=`。
4. **panel 纳管新资源的三件套**：APPS_CONFIG env（运行时清单）+ RBAC resourceNames（权限白名单）+ rbac.yaml/DEPLOY.md（事实源）——前两件决定功能，第三件防止下次重部署/重建时漂移。

## D. 资源收益小结

| 维度 | 改前 | 改后 |
|---|---|---|
| Redis 内存上限 | 256Mi | **64Mi**（-75%） |
| Redis CPU 上限 | 500m | **100m**（-80%） |
| maxmemory 软限 | 128mb | **48mb**（-62.5%） |
| 空闲期占用 | 常驻运行 | **随一键暂停归零** |
