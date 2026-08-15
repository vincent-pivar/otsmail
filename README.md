<p align="center">
    <img src="doc/demo/logo.png" width="80px" />
    <h1 align="center">otsmail</h1>
    <p align="center">基于 Cloudflare 的自建邮箱服务 —— 安全加固与独立维护版</p>
    <p align="center">
        <img src="https://img.shields.io/badge/license-MIT-green" />
        <img src="https://img.shields.io/badge/platform-Cloudflare%20Workers-orange" />
    </p>
</p>

## 这是什么

otsmail 基于 [maillab/cloud-mail](https://github.com/maillab/cloud-mail)（MIT）开发，
只需一个域名就能在 Cloudflare Workers 上跑起自己的邮箱服务：收件走 Email Routing，
发件走 Resend / Cloudflare Email Service，数据存 D1 + KV + R2，没有服务器成本。

**为什么不直接用上游**：上游 `main` 分支长期停更（新功能全堆在 `dev` 未合并），
仓库历史被 force-push 重写过，且多个安全修复 PR 被关闭而未合并（#493 修 SQL 注入、
#501 安全加固）。本项目从上游 `dev` 分支切出独立维护，优先补齐安全问题，
再按社区 issue 呼声推进功能。

## 与上游的差异

### 安全加固（上游至今仍存在的问题）

| 问题 | 上游现状 | 本项目 |
|---|---|---|
| **SQL 注入**（CWE-89，未授权可达） | `/public/addUser` 把 User-Agent、IP、email 直接字符串拼进 `INSERT`，D1 的 `prepare()` 不转义 | 全部改为 `.bind()` 参数化 |
| **存储型 XSS**（未授权可达） | 邮件正文经 `shadowRoot.innerHTML` 直插，仅移除 `<script>`。Shadow DOM 不是安全边界 | 前端 DOMPurify 消毒 + 后端 `html-sanitize.js` 双层；拦 `onerror` / `javascript:` / `iframe` / `srcdoc` / `meta refresh` 等（26 项测试覆盖） |
| **CORS 全开** | `app.use('*', cors())` 等于 `Allow-Origin: *`，任意站点可带用户视角调 API | 默认仅同源，额外来源走 `allow_origin` 白名单 |
| **口令哈希过弱** | 单轮 SHA-256，GPU 每秒可算数十亿次 | PBKDF2-HMAC-SHA256（轮数可配，默认 210000）；旧哈希登录时自动升级，用户无感 |
| **随机口令可预测** | `Math.random()` 生成用户初始密码 | `crypto.getRandomValues()` + 拒绝采样去偏置 |
| **token 存储分散** | 7 处直接读写 `localStorage`，XSS 即失窃 | 收拢到 `utils/token-store.js` 单一入口，为后续切 httpOnly Cookie 留好改造点 |
| **jwt_secret 明文入库** | 写在 `wrangler.toml` 的 `[vars]`，进 git 也在 Dashboard 明文可见 | 改用 `wrangler secret put`，配置文件只留说明 |
| **内部错误原文外泄** | 非业务异常直接把 `err.message` 返回客户端 | 非 `BizError` 统一返回 `Internal error` |

### Bug 修复

- **注销过的邮箱无法重新注册**（上游 #433 / #426 / #494，三个重复 issue）：
  上游遇到 `is_del=1` 的历史记录直接抛「该邮箱已被注销」，地址被永久锁死。
  现在会清理软删残留后允许重新注册，注册 / 添加邮箱 / 管理员加用户三条路径已统一。

### 工程改进

- **测试能跑了**：上游 `vitest.config.js` 指向一个不存在的 `wrangler.jsonc`，
  `vitest run` 直接 ParseError。现改为 node 环境，38 项测试覆盖口令哈希与 HTML 消毒。
- **Worker 名改为 `otsmail`**，与上游及其分叉（都叫 `cloud-mail`）彻底脱钩，
  避免同名 `wrangler deploy` 覆盖生产 Worker 导致邮件中断。
- 清掉了上游配置里作者自己的 D1/KV ID 和写死的 `jwt_secret`。

## 快速开始

```bash
cd mail-worker
npx wrangler d1 create otsmail
npx wrangler kv namespace create otsmail-kv
npx wrangler r2 bucket create otsmail-r2
```

把输出的 ID 填进 `wrangler.toml` 的对应注释块，然后：

```bash
npx wrangler secret put jwt_secret     # 不要写进 wrangler.toml
npx wrangler deploy
# 浏览器打开（GET 请求）初始化表结构：
# https://<你的worker域名>/api/init/<jwt_secret>
```

最后在 Cloudflare Dashboard → Email → Email Routing 里把 catch-all 指向 `otsmail` Worker。

> ⚠️ **Workers 免费档必读**：免费档限制 10ms CPU/请求，而 PBKDF2 210000 轮约需 120ms，
> 登录会 CPU 超时。免费档请在 `[vars]` 里设 `pwd_iterations = 8000`（约 5ms，
> 仍远强于上游的单轮 SHA-256）。轮数写在哈希里，日后升级到付费档改配置即可，不影响老用户登录。

## 从旧的 cloud-mail 迁移

新旧两套可以完全并行、互不影响。详见 **[docs/MIGRATION.md](docs/MIGRATION.md)**，
里面有分阶段步骤、数据核对 SQL 和每一步的回滚方案。要点：

- 旧 Worker 和它的 D1/KV/R2 全程保留，只读不改
- 先用测试子域验证新系统，生产域名不动
- 旧库的 SHA-256 口令哈希被兼容，**老用户用原密码就能登录**
- 唯一不可逆的一步是最后切换 Email Routing 的 catch-all 指向

## 开发

```bash
cd mail-worker && pnpm install && pnpm test     # 单元测试
cd mail-vue   && pnpm install && pnpm run build # 构建前端（产物进 mail-worker/dist）
cd mail-worker && pnpm run check                # 部署前干跑校验
```

## 技术栈

Cloudflare Workers · Hono · Drizzle ORM · Vue 3 · Element Plus · D1 · KV · R2 · Resend

## 致谢与许可

本项目基于 [maillab/cloud-mail](https://github.com/maillab/cloud-mail)（MIT License，
Copyright (c) 2025 eoao）开发，感谢原作者的开源工作。

同类分叉 [AndrewYukon/cloud-mail-plus](https://github.com/AndrewYukon/cloud-mail-plus)
在 Cloudflare 原生发件、External API 等方向做了很好的探索，本项目后续会参考其实现。

MIT License，见 [LICENSE](LICENSE)。
