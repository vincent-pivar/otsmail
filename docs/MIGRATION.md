# otsmail 数据迁移指南（旧 cloud-mail → 新 otsmail）

> 前提：新旧两套**同时存在、互不影响**。旧 Worker（`cloud-mail`）连着旧 D1/KV/R2 继续收发邮件；
> 新 Worker（`otsmail`）用全新的 D1/KV/R2 先跑通。确认新的没问题后再迁数据、最后切域名。
>
> 全程只读旧资源，不删不改。任何一步失败都可以直接放弃新的、继续用旧的。

---

## 阶段 0：先弄清你现在有什么

```bash
cd mail-worker

# 列出账号下所有 Worker、D1、KV、R2，确认旧资源的准确名字和 ID
npx wrangler deployments list --name cloud-mail
npx wrangler d1 list
npx wrangler kv namespace list
npx wrangler r2 bucket list
```

把旧的三个资源名记下来（下文用 `<旧D1名>` / `<旧KV_ID>` / `<旧R2桶>` 指代）。

**⚠️ 不要**在旧 Worker 目录里跑 `wrangler deploy`，也不要把新项目的 Worker 名改回 `cloud-mail`——
同名部署会覆盖旧 Worker 的全部绑定和自定义域名路由，邮件立刻中断。
新项目 `wrangler.toml` 里的 `name = "otsmail"` 就是这道保险，别动它。

---

## 阶段 1：建新资源（互不冲突）

```bash
cd mail-worker

npx wrangler d1 create otsmail
npx wrangler kv namespace create otsmail-kv
npx wrangler r2 bucket create otsmail-r2
```

把输出的 `database_id` / KV `id` / 桶名填进 `wrangler.toml` 对应的注释块（去掉 `#`）。

再设置密钥与变量：

```bash
# jwt_secret 走 Secret，不写进 wrangler.toml
npx wrangler secret put jwt_secret --name otsmail
```

`wrangler.toml` 的 `[vars]` 里填：

```toml
domain = ["你的域名"]      # 先用一个测试子域，别用生产域名
admin  = "你的管理员邮箱"
# Workers 免费档必须设，否则登录会 CPU 超时（见文件内注释）
pwd_iterations = 8000
```

部署 + 初始化表结构：

```bash
npx wrangler deploy
# 用刚才设的 jwt_secret 访问（GET 请求）
# https://otsmail.<你的子域>.workers.dev/api/init/<jwt_secret>
```

---

## 阶段 2：收件路由（关键，决定邮件流向谁）

**这一步之前，新 Worker 收不到任何邮件，旧的照常工作。**

推荐先用一个**测试子域**验证新系统，完全不碰生产域名：

1. Cloudflare Dashboard → 你的域名 → Email → Email Routing
2. 给 `test.example.com` 这类子域单独开 Email Routing
3. Catch-all → Send to a Worker → 选 `otsmail`
4. 新项目 `wrangler.toml` 的 `domain` 里加上 `"test.example.com"`

这样 `任意前缀@test.example.com` 进新系统，`任意前缀@example.com` 仍进旧系统。
两套并行跑几天，确认新的收发、附件、推送都正常，再做阶段 3。

---

## 阶段 3：迁数据

### 3.1 D1（用户、邮箱、邮件、设置）

```bash
# 导出旧库（只读，不影响线上）
npx wrangler d1 export <旧D1名> --remote --output=./_old-d1.sql

# 看一眼行数量级，确认导出完整
grep -c "INSERT INTO" ./_old-d1.sql
```

**不要直接把整个 dump 灌进新库**，因为新库已经由 `/api/init` 建好了表结构，
两边 schema 可能有差异（新版多了 `sync_delete` 等列）。正确做法是**只导数据**：

```bash
# 只导数据、不导 schema
npx wrangler d1 export <旧D1名> --remote --no-schema --output=./_old-data.sql

# 导入新库
npx wrangler d1 execute otsmail --remote --file=./_old-data.sql
```

如果报列不匹配，就按表分批导，先导核心四张表：

```bash
npx wrangler d1 export <旧D1名> --remote --no-schema \
  --table user --table account --table email --table attachments \
  --output=./_core.sql
npx wrangler d1 execute otsmail --remote --file=./_core.sql
```

`setting` 表建议**不要迁**，在新后台重新配一遍——里面存着 Resend token、
Telegram token 等，重配一遍顺便轮换掉更安全。

导完核对行数：

```bash
npx wrangler d1 execute otsmail --remote --command \
  "SELECT 'user' t, COUNT(*) c FROM user UNION ALL SELECT 'account', COUNT(*) FROM account UNION ALL SELECT 'email', COUNT(*) FROM email UNION ALL SELECT 'attachments', COUNT(*) FROM attachments;"
```

和旧库同一条 SQL 的结果比对，数字一致才算成功。

**口令**：旧库的哈希是单轮 SHA-256，新代码认这个格式，所以**老用户可以直接用原密码登录**，
登录成功后会自动升级成 PBKDF2（`crypto-utils.js` 里的 rehash 逻辑）。不需要让用户改密码。

### 3.2 R2（邮件附件）

`wrangler r2 object` 只能单个对象操作，附件多了不现实。两条路：

**A. 不迁（推荐先这样）**
新旧共用一个 R2 桶：把新项目 `wrangler.toml` 的 `bucket_name` 直接填 `<旧R2桶>`。
附件是按 key 读取的（`attachments/<id>`），共用桶不会冲突，旧附件立刻可读。
风险：新系统的「永久删除」会删掉旧系统也在引用的对象——但既然最终要下线旧的，可以接受。

**B. 真要复制**
用 rclone 配 S3 兼容端点（R2 提供 S3 API），需要在 Dashboard 建 R2 API Token：

```bash
rclone copy r2old:<旧R2桶> r2new:otsmail-r2 --progress
```

### 3.3 KV（缓存 + 会话）

**不用迁。** KV 里只有会话 token（`AUTH_INFO:*`）、公共 API token、图表缓存。
不迁的唯一后果是所有人需要重新登录一次，这在迁移时反而是好事。

---

## 阶段 4：切换生产域名

确认新系统跑通、数据核对无误后：

1. 新项目 `wrangler.toml` 的 `domain` 加上生产域名 `example.com`
2. `npx wrangler deploy`
3. Dashboard → Email Routing（生产域名）→ Catch-all → 改指向 `otsmail`
4. Dashboard → Workers → `otsmail` → Settings → Domains & Routes → 加自定义域名
   （旧的 `cloud-mail` 上的同名自定义域名要先删，一个域名只能绑一个 Worker）

**这一步是切换的唯一不可逆点**，之前所有步骤都可回退。
建议在邮件低峰期做，切完立刻发一封测试邮件验证。

---

## 阶段 5：观察期与下线

- 旧 Worker + 旧 D1/KV/R2 **至少保留 2 周**，什么都别删。
- 期间如果发现问题，把 Email Routing 的 catch-all 指回 `cloud-mail` 即可回滚
  （新系统这段时间收到的邮件需要手动补，所以观察期越早发现问题越好）。
- 2 周无异常后再考虑删旧资源，删之前先 `d1 export` 存一份到本地。

---

## 回滚清单（出问题时照这个做）

| 出问题的阶段 | 回滚动作 |
|---|---|
| 阶段 1-3 | 什么都不用做，旧系统一直在跑。删掉新建的 D1/KV/R2 即可 |
| 阶段 4 刚切完 | Email Routing catch-all 指回 `cloud-mail`；自定义域名重新绑回旧 Worker |
| 阶段 4 后发现数据问题 | 旧库是完整的，用 `_old-d1.sql` 本地对账；旧 Worker 随时可接回 |

---

## 常见坑

- **`/api/init/<secret>` 是 GET 不是 POST**，浏览器直接访问即可。
- **`wrangler d1 execute --file` 单文件有大小限制**，dump 太大时按表拆分导入。
- **Email Routing 的子域和主域是独立的**，互不影响，这正是并行验证的基础。
- **一个自定义域名只能绑一个 Worker**，切换时必须先解绑旧的。
- **Turnstile 未配 site_key 时登录页会报 "Verification module failed to load"**，
  新库初始化后如果遇到，清空 setting 表的 site_key/secret_key：
  ```bash
  npx wrangler d1 execute otsmail --remote --command "UPDATE setting SET site_key='', secret_key='';"
  ```
- **PWA Service Worker 缓存**：重新部署后浏览器可能还在用旧版本，
  DevTools → Application → Service Workers → Unregister，再硬刷新。
