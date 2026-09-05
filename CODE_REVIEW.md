# GoodJob CRM 代码审查报告

审查时间：2026-07-12
审查范围：backend/ + frontend/ 全量代码（不含 node_modules、数据库种子）
方法：人工阅读 + TypeScript 编译 + 静态分析匹配常见缺陷模式

## 一、严重 BUG（功能性 / 数据正确性）

### 1.1 工作台“周日历热度”统计完全错误 ❌【已修复】
- 文件：`backend/src/server.ts` 约 L5785（`/api/dashboard/summary`）
- 问题：
  ```ts
  const weekLoad = ["一","二",...,"日"].map((day, index) => ({
    day,
    count: pendingTodos.filter((_, todoIndex) => todoIndex % 7 === index).length
        + (index < Math.min(pendingTodos.length, 7) ? 1 : 0)
  }));
  ```
  `filter((_, todoIndex) => todoIndex % 7 === index)` 只是把待办按其在数组中的位置%7分桶，**与待办实际所属星期几没有任何关系**。
- 影响：前端“周日历热度”展示完全失真，业务员看到的工作量分布是随机分布，无法用于晨会安排。
- 修复：用现有 `todoDueDateKey(todo.dueAt)` 解析每个待办的真实日期，再映射到本周一到本周日的对应 weekday 上。

### 1.2 GET 请求有写副作用（违反 REST 幂等） ⚠️
- 文件：`server.ts` L1889-1891（`GET /api/todos`）、L5657-5658（`GET /api/dashboard/summary`）
- 问题：两个 GET 路由内部调用 `archiveExpiredTodos()` 直接修改 `store.todos`，并触发 `void store.persist()`。
- 影响：
  1. 多客户端并发刷新首页/todos 时，多个 persist 会被并发触发；
  2. MySQL 模式下 persist 是“DELETE 整个表 + INSERT 全表”这种大事务，并发时会出现连接抢占、数据库静默延迟、可能写入乱序；
  3. 不符合 REST 语义（GET 预期只读），难复现的副作用会让排查困难。
- 建议（未直接修改以免破坏现有原型）：
  - 把归档逻辑提取到独立的 `POST /api/todos/archive-due`（已存在）并加上定时任务（项目已有 `scheduleMidnightTodoArchive`）；
  - GET 路由内部仅做“查看时归档候选列表”，由前端显式确认后再 POST；
  - 如必须保留，至少在 `store.persist()` 上加互斥锁（mutex），否则 MySQL 并发写入会导致死锁或竞态。

### 1.3 MySQL 持久化采用“全表 wipe + 全表重写”策略 ❌【已修复时区部分】
- 文件：`backend/src/mysql-store.ts` 中 `persistAll()` + `replaceRows()`
- 问题：每次 `store.persist()`（每个 POST/PATCH 路由几乎都会触发）会：
  1. `DELETE FROM <table>` 清空所有业务表；
  2. 用 `INSERT ... VALUES (?, ?, ...)` 全量插入内存数组。
- 影响（按严重性）：
  - **写入放大严重**：单条客户小修改会让 30+ 张表、数千行数据全部重写，QPS 很快压垮数据库。
  - **mysql2 在 DATETIME 列上传入 Date 实例，会按 `local` 时区序列化为 'YYYY-MM-DD HH:MM:SS'。多机/容器默认时区不一致时，时间会偏移 8 小时**——这正是当前 `mysqlDate()` 返回 `Date` 实例的实现路径。
  - 事务回滚只回滚当前事务，但并发请求会成倍放大业务负载。
- 修复（已做时区部分）：将 `mysqlDate()` 改成返回 UTC 'YYYY-MM-DD HH:MM:SS' 字符串字面值，避免 mysql2 在 Date 对象上做时区转换。
- 建议（未执行）：
  - 改 `replaceRows` 用 `INSERT ... ON DUPLICATE KEY UPDATE`（MySQL upsert）按主键增量写入；
  - 删除单条记录时应走单行 `DELETE WHERE id=?`，而不是全表 wipe；
  - `mysql.createPool({ ..., timezone: 'Z', ... })` 与显式 UTC 字符串组合，彻底规避时区问题。

### 1.4 mysql-store 启动恢复逻辑过重 ⚠️
- 文件：`mysql-store.ts` L113-200
- 问题：用一连串 `if (!store.X.length) { store.X.push(...seed); await store.persist(); }` 为多张表回填种子数据。每次若某一张表为空，就触发 30+ 张表的 `DELETE+INSERT` 全表重写。在生产环境升级时若误判某表为空（如迁移后初始为空），会洗掉其它表数据。
- 修复（已做最关键点）：将 `ocr_jobs.owner_id/team_id` 列的 DEFAULT 从硬编码 `'u_sales_shirley'`/`'europe'` 改为 `''`，避免对新插入行硬塞特定用户。
- 建议：
  - 改为基于单表 upsert 的 seed 流程，避免每次 persist 全表清空；
  - 引入 schema 版本号表，记录种子版本，按需执行一次性迁移，而不是每次启动都判断 `!length`。

### 1.5 OCR 表 `ocr_jobs` 列 DEFAULT 硬编码到种子用户 ❌【已修复】
- 文件：`mysql-store.ts` L约1672-1673
- 问题：
  ```ts
  await ensureColumn(pool, "ocr_jobs", "owner_id", "VARCHAR(64) NOT NULL DEFAULT 'u_sales_shirley'");
  await ensureColumn(pool, "ocr_jobs", "team_id", "VARCHAR(64) NOT NULL DEFAULT 'europe'");
  ```
- 影响：在生产环境部署时若某行因 NOT NULL 缺省被插入，会被强行附上种子用户 ID——这是数据语义错误。
- 修复：DEFAULT 改为 `''`（应用层始终显式写入 owner_id/team_id）。

## 二、安全相关

### 2.1 `outbound-security.ts` 已正确防护 SSRF
- 文件：`outbound-security.ts`
- 评价：实现了 IPv4/IPv6 私网/环回/链接本地地址段过滤 + 重定向重校验，是这套原型里最完整的安全模块，无需修改。

### 2.2 Twilio webhook 验签逻辑
- 文件：`server.ts` L1829-1884、`whatsapp-service.ts` `validateWebhook`
- 评价：当 Twilio 未初始化时 `authToken=''`，`validateWebhook` 返回 false，所有 webhook 一律 403——可以接受。但**没有显式拒绝缺失 `X-Twilio-Signature` 头的情况**，应额外判断空字符串走 false 分支（实际已用 `if (!signature || ...)` 判断，问题不大）。
- 建议：在 server.ts 顶部增加 `initialize()` 失败的显式日志/告警，避免运维侧难排查 webhook 永远 403 的原因。

### 2.3 Helmet 关闭了 CSP
- 文件：`server.ts` L50-53
- 问题：`contentSecurityPolicy: false` + `crossOriginEmbedderPolicy: false`，对 XSS/iframe 注入无防护。
- 建议：原型阶段可接受，但若前端 `index.html` 引入第三方脚本，建议显式配置 CSP `default-src 'self'; script-src 'self' 'unsafe-inline'`，并逐步收敛。

### 2.4 `app.set("trust proxy", 1)` 硬编码 ⚠️
- 文件：`server.ts` L37
- 问题：开发环境无明显反向代理时设置 `trust proxy=1`，导致 `express-rate-limit` 取到的 client IP 全部是上游代理 IP，针对性限流失效；多用户共用同一代理 IP 时会被合并限流。
- 建议：基于 `NODE_ENV==='production' ? Number(process.env.TRUST_PROXY_HOPS || 1) : 0`。

### 2.5 `any` 类型与 peree 风险 ❌【已修复】
- 文件：`whatsapp-service.ts`、`server.ts`、`self-test.ts`
- 问题：
  - `whatsapp-service.ts` 用 `Record<string, any>`、`math.random().toString(36).substr(2,9)`（`substr` 已弃用，整个 repo 其他地方都用 `slice`，这里不一致）；
  - `server.ts` L1696 `catch (error: any)`、L6602 `let data: any`；
  - `server.ts` L1484 `(b as any).lastMessageAt` 把 sort 元素 cast 为 any。
- 修复：把上述 `any` 改为 `unknown` + 类型 narrowing；`substr` → `slice`；sort helper 显式类型化。

## 三、前端 BUG / 体验

### 3.1 持久登录只依赖 localStorage，不调 `/api/auth/me` 校验 ❌【已修复】
- 文件：`frontend/src/main.tsx`（`App()` 初始化）
- 问题：登录后把 user 存入 localStorage；刷新时只读 localStorage 直接渲染 `Layout`，不调用后端校验会话是否仍有效。
- 影响：
  1. 账户被管理员停用、密码被重置后（`authVersion` + 1 导致服务端会话失效），前端依然进入业务页，所有 API 返回 401，但前端不会跳回登录；
  2. cookie 过期（默认 8h）后同理；
  3. 多端登录被踢出时前端无感知。
- 修复：`App` 初始化时先 `await /api/auth/me`，成功才进入 Layout；401 则清空 localStorage 回登录页。后端已经有 `GET /api/auth/me` 端点。

### 3.2 `const token = ""` 永远为空 ⚠️
- 文件：`frontend/src/main.tsx` 多处
- 评价：因 cookie 自动携带，渲染不受影响；但调用 `api(path, token)` 时第二个参数没有任何作用，可读性差。
- 建议：把 `api()` 第二个参数移除，或从 localStorage/cookie 重读 csrf token，统一走 cookie+csrf 的逻辑。

### 3.3 部分 view 是写死占位
- 文件：`main.tsx`（`Knowledge`、`Exam`、`Reports` 等）
- 评价：组件返回硬编码字符串而非真实接口。这是原型阶段的设计选择，不属于 bug。
- 建议：后续接入 `/api/knowledge/assets`、`/api/exams/:id/detail`、`/api/reports/executive` 时统一替换。

## 四、代码结构优化建议

### 4.1 `server.ts` 单文件 6950 行
- 现状：所有路由、辅助函数、业务校验、AI 调用、邮件发送、website 抓取都挤在 `server.ts` 中，难以维护、Code Review 困难、单元测试基本无法做到。
- 建议拆分（按域）：
  ```
  backend/src/
    server.ts            // 仅保留 app 创建 + 中间件 + listen
    routes/
      auth.ts            // login/logout/me/profile
      accounts.ts
      customers.ts
      leads.ts
      deals.ts
      todos.ts
      whatsapp.ts        // 包括 web-scan / twilio
      exams.ts
      reminders.ts
      commission.ts
      trade-documents.ts
      prospect-list.ts
      lead-finder.ts
      ai-config.ts
      dashboard.ts
    services/
      ai.ts              // getAiConfig / callAiModel / readAiJson
      outbound-mail.ts
      archive.ts         // archiveExpiredTodos
      ocr.ts
    store/
      index.ts           // getStore()
      memory.ts
      mysql.ts
    middleware/
      auth.ts
      error.ts
  ```
- 收益：当前 `dashboard/summary` 路由块单条就 230 行，拆出后可独立测试、PR 评审更聚焦。

### 4.2 持久化层抽象不够
- 现状：业务路由直接操作 `store.todos.unshift(...)`、`store.todos = store.todos.filter(...)` 等内存 manipulate + `await store.persist()`。
- 问题：一旦改用真实数据库/ORM，每个路由都要改造；MySQL 全表 wipe 性能差。
- 建议：抽出 `store.todos.add/update/remove/find` 等仓储接口，业务路由不再直接 mutate 数组，便于切换到基于 SQL 的增量持久化。

### 4.3 命名/路径不统一
- 同一概念两种路径：
  - `/api/tools/ocr/jobs/:id/recognize` vs `/api/prospect-list/...`
  - `/api/leads/:id/activities` vs `/api/customers/:id/activities` 接口结构不一致
- 建议：统一 `prefix` 资源（`/api/ocr/jobs/:id/...`、`/api/prospects/:id/...`）。

### 4.4 单元测试基本缺失
- 现状：只有 `self-test.ts`（黑盒端到端）+ `playwright` e2e。`server.ts` 中 7000 行的业务逻辑没有路由级单元测试。
- 建议：抽出业务函数后的路由可以采用 `supertest` + 内置 express app 写单元测试。

### 4.5 ID 生成只用 `Date.now()`
- 现状：所有 ID 都用 `id: \`t_${Date.now()}\``，未加随机后缀。存在并发毫秒级冲突风险。
- 建议：统一改为 `id: \`t_${Date.now()}_${randomBytes(4).toString('base64url')}\``，封装为 `uid(prefix)` helper。

## 五、本次已修复清单
- [x] 1.1 dashboard「周日历热度」按真实 weekday 归类
- [x] 1.3 mysqlDate 时区敏感（改为 UTC 'YYYY-MM-DD HH:MM:SS' 字符串）
- [x] 1.5 ocr_jobs owner_id/team_id DEFAULT 不再硬编码种子用户
- [x] 2.5 whatsapp-service.ts `substr → slice`、`any → unknown`
- [x] 2.5 server.ts `catch (error: any)` → `unknown`、`let data: any` → `unknown`、sort 中 `as any` 类型化
- [x] 3.1 前端启动时校验 `/api/auth/me`
- [x] whatsapp-service.ts `validateWebhook` 类型与方法补强（Record<string, unknown>）

## 六、建议优先级
- P0（先用 bug 修）：1.1、1.5、2.5、3.1 — 已做
- P1（生产前必修）：1.3（持久化 upsert）、1.2（GET 副作用）、1.4（seed 流程）、2.4（trust proxy 可控）
- P2（架构债）：4.1（拆模块）、4.2（仓储抽象）、4.5（ID helper）
- P3（增强）：2.3（CSP 显式）、4.3（路径统一）、4.4（单元测试）
