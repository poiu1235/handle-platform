import { json } from './_lib/supabase.js'

// 全局错误边界：把出网异常收进我们自己的响应形态。
//
// 触发场景（2026-10-02 本地实测）：这台机器到 *.supabase.co 在 TLS 握手阶段被按
// SNI 重置（DNS 正常出 Cloudflare IP，ClientHello 后 RST），functions/ 下三十多处
// 裸 `await fetch(...)` 任何一处都会抛未捕获异常，workerd 就吐
// `internal error; reference = …`（curl 看到 500 纯文本，浏览器看到整页堆栈卡片），
// 用户端零信息、真错误只落在终端。实测复现点：POST /auth/refresh → 500 internal error。
//
// 刻意**不在各个 fetch 处 catch 成"正常返回值"**。serviceRoleFetch 的调用点里有 5 处
// 只读 `.data` 不判 `.ok`：
//   login.js:55 / login.js:75      微信身份冲突检查的两个方向
//   identity-unbind.js:55          注销置位中的账号不可操作
//   identity-unbind.js:68          B25 的 30 天 churn 上限
//   delete-account.js:47           幂等读
// 一旦把异常吞成空结果，这五道门就从「抛异常顺带拦下」退化成「空集放行」。
// 保持抛出、由这里统一兜住 = 请求照样失败（fail-closed），只是形态回到设计里。
//
// 同理，verifyTurnstile 连不上 siteverify 也不 catch 成 false——那会把「服务端出网
// 故障」伪装成「你验证码没过」，让人反复重填一个本来就过了的验证码。
//
// 也别指望"在每处 fetch 包一层 try/catch 打印真错误"能多拿到什么：实测（本地对
// refresh.js 的 fetch 加 catch 后打印）站点级 catch 看到的同样是
// `Error: internal error; reference = …`、`err.cause` 为 undefined——workerd 在异常
// 进入任何用户代码之前就把它替换了。所以这里记 path + reference 已经是有信息量的
// 上限，真因（DNS / TLS / 连接被重置）只能从进程外探，例如
// `curl -v https://<project>.supabase.co/auth/v1/health`。
export async function onRequest(context) {
  try {
    return await context.next()
  } catch (err) {
    const path = new URL(context.request.url).pathname
    console.error(`[_middleware] 未捕获异常 ${path}:`, err?.name, err?.message)
    return json({ error: '服务暂时不可用，请稍后再试', code: 'upstream_unreachable' }, 503)
  }
}
