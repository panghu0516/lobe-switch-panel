# 项目交接：Lobe 一键开关控制面板 · TOTP 动态码方案（方案②）

> 交接日期：2026-08-06。TOTP 功能已实现并推送，新 AI 协助虎先生完成绑定、部署与验证。

## 0. 项目现状速览

- 代码仓库：`github.com/panghu0516/lobe-switch-panel`（master）
- 最新提交：`2339092`（TOTP 方案②）
- 命名空间：`ns-feotrwac`；容器端口：3000
- 白名单 GitHub：`panghu0516`
- 技术栈：Node.js + Express + speakeasy

## 1. 方案背景与决策

虎先生要求：陌生设备登录后退出，其他人刷新不得直接登上；自家设备不退出应免验证。

- GitHub OAuth 无"强制重输密码"机制（force_login/consent 参数 GitHub 不认，已实测无效）
- 最终采用方案②：面板内置 TOTP 动态码，与微软 Authenticator 绑定
- 逻辑：GitHub 授权通过后，若 TOTP 已启用，须再输当前动态码才放行操作

## 2. 已实现功能

| 端点 | 作用 |
|------|------|
| GET /totp/setup | 首次生成 secret，展示 otpauth URI / base32 密钥 |
| GET /totp/verify | 动态码输入页 |
| POST /totp/verify | 校验动态码，通过则 session.totpVerified=true 并跳首页 |
| 中间件 requireTotp | 串联到 /status、/pause、/resume |
| callback 后 | 若 TOTP 启用且未验证，跳 /totp/verify |
| 首页 / | 若 TOTP 启用且未验证，跳 /totp/verify |

### 关键逻辑
- TOTP_SECRET 为空 → 跳过 TOTP（兼容旧部署）
- TOTP_SECRET 有值 → 登录后必须输动态码
- speakeasy.totp.verify({secret, encoding:'base32', token, window:1})
- 必须配 body parser（express.json + express.urlencoded），否则 req.body 为空、验证恒失败（已修复）

## 3. 部署步骤

### 3.1 首次绑定
1. Sealos 重新构建镜像（认提交 2339092）+ 重新部署
2. 先不填 TOTP_SECRET，浏览器访问 https://<域名>/totp/setup
3. 页面显示 base32 密钥 → 虎先生用微软 Authenticator 扫码绑定
4. 密钥填入 Sealos 环境变量 TOTP_SECRET → 重新部署
5. 密钥只显示一次，填错需重生成

### 3.2 环境变量（新增）
```
TOTP_SECRET = <Authenticator 绑定生成的 base32 密钥>
```

### 3.3 验证流程
1. 访问面板 → GitHub 登录（输密码+2FA）→ 跳动态码页
2. 输 Authenticator 当前 6 位码 → 进入面板
3. 退出 → 重登 → 需再输动态码
4. 自家设备不退出 → session 有效期内直接进，免输

## 4. 已知坑与注意
1. body parser 必须配：否则动态码验证恒失败
2. 用 speakeasy 而非 otplib：otplib 新版是 ESM，CommonJS 报错
3. TOTP_SECRET 固定：绑定后不可随意改，改了需重新绑定
4. 服务器时间：TOTP 依赖时钟，window:1 容忍 1 步漂移
5. GitHub force_login 无效：别再加此参数
6. 沙箱易重置：开发时定期 push，代码以 git 为准
7. 退出页：/logout 清 cookie 跳 /logged-out，不再跳 GitHub

## 5. 测试清单（重新部署后验证）
- [ ] /totp/setup 显示密钥（未配置时）
- [ ] GitHub 登录后跳动态码页
- [ ] 错误动态码 → 401 拒绝
- [ ] 正确动态码 → 进入面板
- [ ] 退出后重登 → 需重新输动态码
- [ ] 自家设备不退出 → 免输直接进

## 6. 安全边界
- 白名单固定 panghu0516（GitHub OAuth）
- TOTP 动态码第二道验证（针对陌生设备）
- KUBE_SA_TOKEN 最小权限（仅 4 个应用 scale）
- 凭证 value 绝不读写输出，只经 Sealos 环境变量注入
