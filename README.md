# 登录/注册/密码重置 重构说明

## 三个问题对应的解法

1. **重置 token 与登录 token 区分开**
   `functions/auth/verify-recovery.js` 校验 recovery 验证码后，**不**把 Supabase
   session 下发给浏览器（拿到手立刻在服务端 `logout` 掉），而是换发一张
   `functions/_lib/resetTicket.js` 签发的一次性票据：HS256、Cloudflare 私有
   secret、`purpose: 'password_reset'`、5 分钟过期。这张票据和 Supabase 登录 JWT
   是两套完全不同的签发/校验体系，`functions/api/_middleware.js` 只认 Supabase
   JWKS，结构上就无法把它当登录态用，不是靠一个字段的君子协定。
   `functions/auth/reset-password.js` 凭这张票据 + `SUPABASE_SERVICE_ROLE_KEY`
   直接改密码，全程不出现任何可复用的 Supabase access token。

2. **统一过 Cloudflare 中间层**
   前端不再直接引入 `@supabase/supabase-js`。所有认证动作走
   `functions/auth/*`（Worker 内部用 anon key / service_role 调 Supabase Auth
   REST API）；业务数据（如 `balances`）走 `functions/api/*`，由
   `functions/api/_middleware.js` 统一做「无 session → 401 / recovery → 403 /
   已登录 → 放行」，之后转发**用户自己的 access token**（不是 service_role）去
   请求 Supabase PostgREST——RLS 仍然是最后一道真正的数据所有权防线，Cloudflare
   这层是前置闸门，不是替代品，对应你画的分层图。

3. **登录页拆分**
   `/login` `/register` `/forgot-password` `/reset-password` 四个独立路由 +
   `AuthShell.jsx` 共享外壳组件。原来 6 态的大状态机拆成了 4 个页面，
   注册/找回密码内部各自还有一个"表单→验证码"的两步小状态（没必要为验证码这种
   不需要被直接链接访问的中间步骤单独开路由）。

## 需要配置的环境变量（Cloudflare Pages → Settings → Environment variables）

| 变量 | 用途 |
|---|---|
| `SUPABASE_URL` | 同现有配置 |
| `SUPABASE_ANON_KEY` | Worker 代理 signup/login/verify/recover/refresh 等公开认证操作 |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅 `reset-password.js` 用来直接改密码，**务必设为 Secret，不要出现在任何前端代码里** |
| `RESET_TICKET_SECRET` | 建议 `openssl rand -base64 32` 生成，设为 Secret |
| `TURNSTILE_SECRET_KEY` | **Secret**。Turnstile siteverify 服务端校验（认证闸门 Web 通道），模板见 `.dev.vars.example` |
| `WX_APPID` / `WX_SECRET` | **Secret**。小程序 appid/appsecret，认证闸门 mp 通道 code2session 验真用（D3 的 wechat 端点复用同一 helper） |

## 认证闸门（2026-09-13，D4 分通道人机验证）

`functions/_lib/authGate.js`：`register` / `resend-signup` / `login` / `forgot-password`
四个端点在触达 Supabase 前统一过闸，通道判定凭「能验证的凭证种类」而非客户端自报字段——

- 请求带 `wxLoginCode`（小程序通道）：现场 code2session 验真（`_lib/wxTicket.js`），
  换到 openid 即放行，失败不降级；
- 否则（Web 通道）：`captchaToken` 必填且 siteverify 通过（`_lib/turnstile.js`），
  400 文案与迁移前 Supabase 报错的翻译一字不差，Web 前端零改动。

附属实例级内存频控（同一 IP 60 秒 5 次，isolate 各自计数）。**前置约束**：本闸门生效的
前提是 Supabase Dashboard 的 Captcha 保护已关闭——Turnstile token 一次性，siteverify
消费后开着的 Supabase Captcha 会因重复消费再拒一次；若日后重开 Supabase Captcha，
必须先摘掉 Web 通道的 siteverify 分支。

## 待你接手的收尾工作

- **`Hello.jsx` / `BalanceImport.jsx`**：这两个文件目前还在直接用
  `supabase.from('balances')...` 打 Supabase REST（绕过了 Cloudflare 层）。
  需要把这些调用换成 `api.authorizedFetch('/api/balances', ...)`
  （`GET` 列表、`POST` 新增，改/删/清零走 `/api/balances/[id]`，PATCH/DELETE
  已经写好在 `functions/api/balances/[id].js`）。文件本身有 900 行且大部分是
  UI/手势逻辑，没有跟着这次一起改，需要你确认 `balances` 表结构后我再动。
- **`Hello.jsx` 里 `<Link to="/balance-import">`** 需要改成
  `/app/balance-import`，跟随本次路由改名。
- **`src/lib/supabaseClient.js`**：如果前端不再需要它（认证已全部走
  `apiClient.js`，业务数据也准备切到 `authorizedFetch`），可以删掉，
  同时把 `@supabase/supabase-js` 从前端依赖里移除，只保留在 Worker 端按需
  `fetch` 调 REST API（本次代码就是这么写的，没引入 supabase-js）。
- **`reset-password.js` 里的密码正则**：和 `src/lib/passwordRules.js`
  是两份独立维护的同一份规则，建议以后抽成一个前后端都能 import 的共享模块，
  避免改一边忘改另一边。
- Supabase Dashboard 的两个邮件模板（Confirm signup / Reset Password）沿用
  之前已经改成 `{{ .Token }}` 的配置，不需要再动。

## 追加改动（Hello.jsx / BalanceImport.jsx 已接入新架构）

- `Hello.jsx`、`BalanceImport.jsx` 已经不再 `import { supabase } from '../lib/supabaseClient'`，
  全部改用 `apiClient.authorizedFetch`：
  - 加载列表：`GET /api/balances?includeZero=true|false`
  - 新增/编辑单条：`POST /api/balances`（同名覆盖）/ `PATCH /api/balances/:id`
  - 清零/删除：`PATCH /api/balances/:id`（amount=0）/ `DELETE /api/balances/:id`
  - 批量粘贴导入：新增了 `POST /api/balances/import`（原来 `BalanceImport.jsx`
    用的是 `upsert(payload, {onConflict:'user_id,app_name'})` 批量语义，单条的
    `/api/balances` 端点不支持数组，所以单开了这个）
  - `/api/hello`：不再手动 `supabase.auth.getSession()` 取 token，交给
    `authorizedFetch` 统一处理
- `useAuth()` 里原来两个文件都调用的 `signOut()` 统一改成了 `logout()`，
  和 `AuthContext.jsx` 的方法名对齐
- `<Link to="/balance-import">` / `<Link to="/">返回管理端` 都改成了
  `/app/balance-import` / `/app`，跟随本次路由改名
- `src/lib/supabaseClient.js` 已删除，`package.json` 里的
  `@supabase/supabase-js` 依赖已移除——前端现在完全不直连 Supabase，
  Functions 端也没有用 supabase-js SDK，全部走裸 `fetch` 调 REST API