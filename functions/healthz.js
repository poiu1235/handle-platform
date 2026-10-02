import { rateGuard } from './_lib/authGate.js'
import { json } from './_lib/supabase.js'

// GET /healthz —— 上游连通性自检。
//
// 为什么需要它：functions/ 下三十多处出网 fetch 一旦连不上，异常会被 workerd 换成
// `internal error; reference = …`（cause 丢失，实测站点级 catch 也读不到真因），
// 所以"是哪个上游挂了"这件事**不可能从错误里读出来**，只能由"我们主动连的是谁"来
// 定性。这个端点把定性变成一次请求：三个目标各探一遍，返回逐个的连通结果。
//
// 判据是**连通性不是业务**：拿到任何 HTTP 响应就算 ok（哪怕 400/404），因为我们要
// 区分的是"网络到不了"和"到了但答得不合期望"。status 原样回显，供人自己读。
//
// 不泄露：响应里只有目标名 + 连通性 + HTTP 状态 + 耗时，不含 URL、不含任何 key；
// 探测请求一律用假凭证（真 WX_SECRET / TURNSTILE_SECRET_KEY 不出网）。
// 频控复用 authGate 的同一个桶实现，避免这里变成三倍出网的放大器。
// 每次探测现取一个新信号：AbortSignal.timeout 的倒计时从**创建那一刻**起算，
// 提到模块顶层会变成"isolate 启动 5 秒后永久失效"，之后每个探针都被立刻 abort，
// 端点就退化成一排永远红的假判据。
const timeout = () => AbortSignal.timeout(5000)

const PROBES = [
  {
    name: 'supabase',
    // GoTrue 的 /health 是否需要 apikey 都无所谓：有响应即通
    run: (env) => fetch(`${env.SUPABASE_URL}/auth/v1/health`, { signal: timeout() }),
    needs: ['SUPABASE_URL'],
  },
  {
    name: 'turnstile',
    run: () =>
      fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        // 故意用假 secret：真 key 不该为了"探一下通不通"发出去
        body: new URLSearchParams({ secret: 'healthz-probe-not-a-secret', response: 'healthz-probe' }),
        signal: timeout(),
      }),
  },
  {
    name: 'wechat',
    run: () =>
      fetch(
        'https://api.weixin.qq.com/sns/jscode2session' +
          '?appid=healthz-probe&secret=healthz-probe&js_code=healthz-probe&grant_type=authorization_code',
        { signal: timeout() },
      ),
  },
]

async function probe(target, env) {
  const started = Date.now()
  const missing = (target.needs || []).find((k) => !env[k])
  if (missing) return { name: target.name, ok: false, status: null, ms: 0, note: `env ${missing} 未配置` }
  try {
    const res = await target.run(env)
    return { name: target.name, ok: true, status: res.status, ms: Date.now() - started }
  } catch {
    // 拿不到响应：DNS/TLS/连接被重置/超时都归这里，四者在 Worker 内部无法再细分
    return { name: target.name, ok: false, status: null, ms: Date.now() - started, note: '无响应' }
  }
}

export async function onRequestGet(context) {
  const { request, env } = context
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateGuard(`healthz:${ip}`, 6, 60_000)) return json({ error: '尝试过于频繁，请稍后再试' }, 429)

  const upstreams = await Promise.all(PROBES.map((t) => probe(t, env)))
  const allOk = upstreams.every((u) => u.ok)
  // 自检本身永远 200：探到不通也是这次请求的成功结果，用 5xx 反而让调用方分不清
  // "healthz 挂了"和"上游挂了"
  return json({ ok: allOk, checkedAt: new Date().toISOString(), upstreams })
}
