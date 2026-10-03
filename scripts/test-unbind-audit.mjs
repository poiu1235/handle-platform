// 解绑流水与 churn 计数的离线判据（跑真源码 functions/auth/identity-unbind.js）。
// 用法：npm run test:unbind
//
// 盯的是两件事（都属"错了不报错"的那类）：
//   1. 🔴 D-9a：人工解绑**不占**用户自己的 30 天额度 ⇒ 计数只数 `operator is null` 的行。
//      过滤加错方向（或加到没有这一列的 account_merges 上）都不会抛，只会静默算错。
//   2. S-7：流水要带被解绑的 openid，且**必须取自删行之前**那次 select——删完库里就没了。
//
// 认证不是桩：这里用 jose 现签一把真 RS256 JWT、并把 JWKS 从同一个 fetch 桩里发出去，
// 所以 verifyUserBearer 走的是真验签路径（issuer/audience 任写错一处就会 401，
// 那本身就是"端点没被测试夹具绕过"的证据）。

import { generateKeyPair, SignJWT, exportJWK } from 'jose'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const { onRequestPost } = await import(pathToFileURL(path.join(root, 'functions/auth/identity-unbind.js')).href)

const BASE = 'https://fake.supabase.co'
const USER = 'aaaaaaaa-1111-2222-3333-444444444444'
const OPENID = 'oUnbindAudit1234567890abcdef'
const KID = 'test-key-1'

const { privateKey, publicKey } = await generateKeyPair('RS256')
const pub = await exportJWK(publicKey)
Object.assign(pub, { kid: KID, alg: 'RS256', use: 'sig' })
const token = await new SignJWT({ sub: USER, email: 'user@example.com', role: 'authenticated', user_metadata: {} })
  .setProtectedHeader({ alg: 'RS256', kid: KID })
  .setIssuer(`${BASE}/auth/v1`)
  .setAudience('authenticated')
  .setExpirationTime('10m')
  .sign(privateKey)

// 反证用的坏 token：只有 audience 错，其余全对 ⇒ 401 才说明验签真的在跑
const badToken = await new SignJWT({ sub: USER, email: 'user@example.com', role: 'authenticated', user_metadata: {} })
  .setProtectedHeader({ alg: 'RS256', kid: KID })
  .setIssuer(`${BASE}/auth/v1`)
  .setAudience('anon')
  .setExpirationTime('10m')
  .sign(privateKey)

let calls = []
let sc
const scenario = (over = {}) => {
  calls = []
  sc = { identityRows: [{ id: 'i1', openid: OPENID }], unbindRows: [], mergeRows: [], pendingRows: [], guest: false, passwordOk: true, flowStatus: 200, ...over }
}
globalThis.fetch = async (url, options = {}) => {
  const u = String(url)
  const method = options.method || 'GET'
  calls.push({ u, method, body: options.body ? JSON.parse(options.body) : null })
  const mk = (data, status = 200) => ({ ok: status < 300, status, json: async () => data })
  if (u.includes('/.well-known/jwks.json')) return mk({ keys: [pub] })
  if (u.includes('/auth/v1/token')) return sc.passwordOk ? mk({ access_token: 'x', refresh_token: 'y' }) : mk({ error_description: 'bad pw' }, 400)
  if (u.endsWith('/sessions')) return mk([])
  if (u.includes('/auth/v1/admin/users/')) {
    return mk(sc.guest ? { email: 'g@guest.invalid', user_metadata: { account_type: 'guest' } } : { email: 'user@example.com', user_metadata: {} })
  }
  if (u.includes('/rest/v1/user_identities')) return method === 'DELETE' ? mk([]) : mk(sc.identityRows)
  if (u.includes('/rest/v1/pending_deletions')) return mk(sc.pendingRows)
  if (u.includes('/rest/v1/account_merges')) return mk(sc.mergeRows)
  if (u.includes('/rest/v1/identity_unbinds')) return method === 'POST' ? mk(sc.flowStatus === 200 ? [] : { message: 'flow boom' }, sc.flowStatus) : mk(sc.unbindRows)
  throw new Error('未预期的出网目标：' + u)
}

const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
let ipSeq = 0

async function run(body = { provider: 'wechat_mp', password: 'Pw-1234' }, withToken = true, tok = token) {
  const env = { SUPABASE_URL: BASE, SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon' }
  const request = new Request(`${BASE}/auth/identity-unbind`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': `10.0.0.${++ipSeq}`, // 每个用例换 IP：rateGuard 是模块级 Map，同 IP 连打五次会自己撞 429
      ...(withToken ? { Authorization: `Bearer ${tok}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const res = await onRequestPost({ request, env, waitUntil: () => {} })
  return { status: res.status, data: await res.json().catch(() => null) }
}

const urlOf = (frag, method = 'GET') => calls.find((c) => c.u.includes(frag) && c.method === method)?.u || ''
const order = (frag) => calls.findIndex((c) => c.u.includes(frag))

// ── 1. 正常解绑：流水带 openid、不写 operator、顺序正确、计数过滤只加在该加的一侧 ──
scenario()
let r = await run()
check('1.1 解绑成功', [r.status, r.data?.unbound], [200, true])
const flow = calls.find((c) => c.u.includes('/rest/v1/identity_unbinds') && c.method === 'POST')
check('1.2 流水记下了被解绑的 openid', flow?.body?.openid, OPENID)
check('1.3 自助流水**不写 operator**（写了就会被自己的过滤排除）', Object.prototype.hasOwnProperty.call(flow?.body || {}, 'operator'), false)
check('1.4 计数只数 operator is null 的行', urlOf('identity_unbinds?select=id').includes('operator=is.null'), true)
check('1.5 account_merges 侧不加这个过滤（它没这一列，加了是 400）', urlOf('account_merges').includes('operator'), false)
// 🔴 顺序判据：openid 必须在 DELETE 之前就被读到，否则流水里那一列永远是 null。
//    （原来这一格我写成了 `a < b || a < 999` 这种恒真式——判据自己假绿比没判据更坏。）
const iSelect = calls.findIndex((c) => c.method === 'GET' && c.u.includes('user_identities'))
const iDelete = calls.findIndex((c) => c.method === 'DELETE' && c.u.includes('user_identities'))
check('1.6 openid 取自删行之前的那次 select', iSelect > -1 && iDelete > iSelect, true)
check('1.7 select 里点名了 openid', urlOf('user_identities?select').includes('select=id,openid'), true)
check('1.8 流水写在 DELETE 之后', order('identity_unbinds', 'POST') > order('user_identities', 'DELETE'), true)

// ── 2. 额度：三条自助流水就到上限；同样三条若是人工补记的则不该拦 ──
scenario({ unbindRows: [{ id: 1 }, { id: 2 }, { id: 3 }] })
r = await run()
check('2.1 自助解绑满 3 次 ⇒ 429', [r.status, r.data?.code], [429, 'rate_limited'])
check('2.2 且没有发出 DELETE', calls.some((c) => c.method === 'DELETE' && c.u.includes('user_identities')), false)
scenario({ unbindRows: [] })
r = await run()
check('2.3 人工流水已被服务端过滤掉 ⇒ 不占额度、放行', [r.status, r.data?.unbound], [200, true])

// ── 3. 回归：原有六道门一道都不能松（顺序即防呆） ─────────────────────────
scenario({ identityRows: [] })
r = await run()
check('3.1 无绑定 ⇒ 404 not_bound', [r.status, r.data?.code], [404, 'not_bound'])
scenario({ guest: true })
r = await run()
check('3.2 访客 ⇒ 400 guest_account', [r.status, r.data?.code], [400, 'guest_account'])
scenario({ pendingRows: [{ reason: 'queued' }] })
r = await run()
check('3.3 注销置位 ⇒ 409 deletion_pending', [r.status, r.data?.code], [409, 'deletion_pending'])
scenario({ passwordOk: false })
r = await run()
// 🔴 不能写成"有没有 POST"——密码 proof 本身就是一次 POST /auth/v1/token，那样必红。
//    要判的是两个**改状态**的动作：删绑定行、写解绑流水。
const mutates = calls.some((c) => (c.method === 'DELETE' && c.u.includes('user_identities'))
  || (c.method === 'POST' && c.u.includes('identity_unbinds')))
check('3.4 密码错 ⇒ 403 且不删行、不写流水', [r.status, r.data?.code, mutates], [403, 'proof_failed', false])
scenario()
r = await run({ provider: 'alipay', password: 'Pw-1234' })
check('3.5 provider 白名单 ⇒ 400 bad_provider', [r.status, r.data?.code], [400, 'bad_provider'])
scenario()
r = await run({}, false)
check('3.6 无 Bearer ⇒ 401（真验签路径，不是夹具绕过）', r.status, 401)
scenario()
r = await run({}, true, badToken)
check('3.7 audience 错的 token ⇒ 401（证明验签真在跑，不是夹具绕过）', r.status, 401)

// ── 4. 流水漏写：不翻转主语义，但必须留下可 grep 的 token ──────────────────
scenario({ flowStatus: 500 })
const logs = []
const realErr = console.error
console.error = (...a) => logs.push(a.join(' '))
r = await run()
console.error = realErr
check('4.1 流水写失败仍回 200（门已拆是主语义）', [r.status, r.data?.unbound], [200, true])
check('4.2 但记了一条可 grep 的 error', logs.some((l) => l.includes('pro-unbind-flow-write-failed')), true)

// ── 输出 ───────────────────────────────────────────────────────────────────
let fails = 0
for (const x of results) {
  if (!x.ok) fails++
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n        期望 ${JSON.stringify(x.want)}\n        现值 ${JSON.stringify(x.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
