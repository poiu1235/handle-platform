# 台账 · Handle Platform（登录 + hello 基础设施）

Supabase Auth（邮箱密码）+ Resend（邮件发送）+ Cloudflare Pages Functions（JWT 验签）跑通的最小骨架。

## 目录结构

```
src/
  lib/
    supabaseClient.js   # supabase-js 单例
    AuthContext.jsx      # 全局登录态 Context
  pages/
    Login.jsx            # 登录 / 注册
    AuthCallback.jsx      # 承接确认邮件里的跳转链接
    Hello.jsx             # 受保护主页，调用 /api/hello
  App.jsx                 # 路由 + 路由守卫
functions/
  api/hello.js            # Pages Function：JWKS 本地验签 JWT
```

## 必须在 Supabase Dashboard 里完成的配置（我这边没法代做）

1. **切到非对称签名密钥（关键！）**
   项目默认可能还在用旧的对称密钥（HS256），这种情况下 JWKS 端点不会返回任何 key，Worker 验签会一直失败。
   去 `Project Settings -> API -> JWT Keys`，按官方引导 rotate 到 asymmetric signing key（RSA 或 EC）。这一步做完，`/auth/v1/.well-known/jwks.json` 才会有内容。

2. **Site URL / Redirect URLs**
   `Authentication -> URL Configuration`，把 Site URL 和 Redirect URLs 加上你的正式域名和本地开发地址，例如：
   - `https://你的域名`
   - `https://你的域名/auth/callback`
   - `http://localhost:5173/auth/callback`（本地开发用）

3. **确认邮件发送**
   `Project Settings -> Auth -> SMTP Settings` 里应该已经配好 Resend 作为 Custom SMTP（你之前已完成）。

## 本地开发

```bash
npm install
cp .env.example .env.local        # 填入 VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY
cp .dev.vars.example .dev.vars    # 填入 SUPABASE_URL

npm run dev                       # 只跑前端（/api/hello 不可用）
# 或者用 wrangler 同时跑前端 + functions：
# npx wrangler pages dev -- npm run dev
```

## 部署到 Cloudflare Pages

1. 把这个项目推到 GitHub，在 Cloudflare Dashboard 里新建 Pages 项目并连接仓库。
2. Build 设置：Build command `npm run build`，Build output directory `dist`。
3. 在 Pages 项目的 `Settings -> Environment variables` 里配置：
   - `VITE_SUPABASE_URL`（前端构建时读取）
   - `VITE_SUPABASE_ANON_KEY`
   - `SUPABASE_URL`（`functions/api/hello.js` 运行时读取）
4. 部署完成后，把 Pages 分配的域名（或你绑定的自定义域名）加进 Supabase 的 Redirect URLs 里。

## 验证流程是否跑通

1. 打开 `/login`，注册一个新账号 → 检查邮箱是否收到确认邮件（Resend 发送）。
2. 点击邮件里的链接 → 应该落地到 `/auth/callback`，几秒内自动跳转到 `/`。
3. `/` 页面应显示"你好，xxx@xxx"，下面状态行显示 `/api/hello` 返回的内容 —— 如果显示"接口调用失败"，先检查 Supabase 是否已切换到 asymmetric signing key。
4. 点右上角"退出登录"，应该跳回 `/login`。
