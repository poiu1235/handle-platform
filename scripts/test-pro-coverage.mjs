// 会员判定在 CF 侧的离线判据（跑**真源码** functions/_lib/proCoverage.js 与
// functions/api/pro/session.js，fetch 打桩）。
// 用法：npm run test:pro
//
// 为什么能这么跑：proCoverage.js 只用 fetch 与 serviceRoleFetch，没有 workerd 专有 API
// ⇒ Node 可以直接 import 它，把 fetch 换成假 Supabase。这条路子的价值在于：这台机器到
// *.supabase.co 的 TLS 被 SNI 重置（functions/_middleware.js:6-9 有实测记录），
// 真链路只能等你部署后测，但**判定与开关的形状不必等**。
//
// ⚠️ 它证明不了的事：PostgREST 对 `RETURNS record + OUT 参数` 到底回对象还是数组
//   （callProCoverage 里两种都吃，首接真单后要收紧成一种）；RLS/授权的实际形态；
//   以及七个写入口的墙（B2 才有）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
// ⚠️ Windows 上动态 import() 只吃 file:// URL，绝对路径会被当成协议（'d:'）直接抛
//   ERR_UNSUPPORTED_ESM_URL_SCHEME ⇒ 一律过 pathToFileURL。
const { getProView, getProWallState, capsForWire } = await import(
  pathToFileURL(path.join(root, 'functions/_lib/proCoverage.js')).href
)
const { onRequestGet } = await import(pathToFileURL(path.join(root, 'functions/api/pro/session.js')).href)

const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

// ── 假 Supabase：identity 与 rpc 两条路由，全部调用留痕 ────────────────────
let calls = []
let stub = { identityRows: [{ openid: 'oAbc' }], identityStatus: 200, rpcBody: { is_covered: true, valid_until: '2026-11-01T15:59:59Z', remaining_days: 28 }, rpcStatus: 200, rpcAsArray: false }
globalThis.fetch = async (url, options) => {
  const u = String(url)
  const body = options && options.body ? JSON.parse(options.body) : null
  calls.push({ url: u, method: options?.method, body, headers: options?.headers })
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('/rest/v1/rpc/pro_coverage')) {
    if (stub.rpcStatus !== 200) return mk({ message: 'rpc boom' }, stub.rpcStatus)
    const row = stub.rpcBody
    return mk(stub.rpcAsArray ? [row] : row)
  }
  if (u.includes('/rest/v1/user_identities')) {
    if (stub.identityStatus !== 200) return mk({ message: 'identity boom' }, stub.identityStatus)
    return mk(stub.identityRows)
  }
  throw new Error('未预期的出网目标：' + u)
}

const reset = () => {
  calls = []
  stub = { identityRows: [{ openid: 'oAbc' }], identityStatus: 200, rpcBody: { is_covered: true, valid_until: '2026-11-01T15:59:59Z', remaining_days: 28 }, rpcStatus: 200, rpcAsArray: false }
}
const env = (over = {}) => ({ SUPABASE_URL: 'https://fake', SUPABASE_SERVICE_ROLE_KEY: 'k', PRO_WALLS_ENABLED: 'true', PRO_PURCHASE_ENABLED: 'false', PRO_ENV: '0', ...over })
const uid = 'u-1'

// 1. 未绑微信（纯 Web 账号）⇒ 免费档，且**不发第二次请求**（省一次 rpc）
reset(); stub.identityRows = []
let v = await getProView(env(), uid)
check('1.1 未绑微信判为免费', [v.isCovered, v.proUntil, v.hasWechat], [false, null, false])
check('1.2 未绑微信不再调 rpc', calls.filter((c) => c.url.includes('rpc/pro_coverage')).length, 0)

// 2. 覆盖中 ⇒ 会员档 + 字段透传
reset(); v = await getProView(env(), uid)
check('2.1 会员态与余量透传', [v.isCovered, v.proUntil, v.remainingDays], [true, '2026-11-01T15:59:59Z', 28])
check('2.2 会员档上限', capsForWire(v.isCovered, true), { notes: 500, balances: 100, cards: 100 })

// 3. 服务端算出没覆盖 ⇒ 免费档
reset(); stub.rpcBody = { is_covered: false, valid_until: '2026-01-01T15:59:59Z', remaining_days: -300 }
v = await getProView(env(), uid)
check('3.1 过期后判免费', [v.isCovered, v.remainingDays], [false, -300])
check('3.2 免费档上限', capsForWire(false, true), { notes: 200, balances: 50, cards: 50 })

// 4. PostgREST 单行返回形状不确定 ⇒ 数组形状与对象形状必须同结果
reset(); stub.rpcAsArray = true
v = await getProView(env(), uid)
check('4.1 数组形状与对象形状同结果', [v.isCovered, v.remainingDays], [true, 28])

// 5/6. 报错要抛，不伪装成免费档（伪装＝把故障读成"你没会员"）
reset(); stub.identityStatus = 500
check('5.1 identity 读失败要抛', await getProView(env(), uid).then(() => 'no-throw', (e) => e.code), 'pro_identity_lookup_failed')
reset(); stub.rpcStatus = 503
check('6.1 rpc 失败要抛', await getProView(env(), uid).then(() => 'no-throw', (e) => e.code), 'pro_coverage_rpc_failed')

// 7. 墙关着 ⇒ 一次数据库都不问；但判定本身照算（8.3 第 4 条：到期提示不随开关关闭）
reset()
let w = await getProWallState(env({ PRO_WALLS_ENABLED: 'false' }), uid)
check('7.1 墙关 ⇒ caps 为 null（没有墙，不是免费档新数值）', [w.wallsEnabled, w.caps], [false, null])
check('7.2 墙关 ⇒ 零数据库调用', calls.length, 0)
reset(); w = await getProWallState(env({ PRO_WALLS_ENABLED: 'not-a-bool' }), uid)
check('7.3 拼错的开关值一律算关（fail-closed）', w.wallsEnabled, false)
reset(); v = await getProView(env({ PRO_WALLS_ENABLED: 'false' }), uid)
check('7.4 墙关着仍下发到期时刻（会员的内测账号要知道自己几号没）', [v.isCovered, v.proUntil !== null], [true, true])

// 8. PRO_ENV 是字符串 ⇒ 发给 rpc 的必须是数字
reset(); await getProView(env({ PRO_ENV: '1' }), uid)
check('8.1 PRO_ENV="1" 转成数字 1', calls.find((c) => c.url.includes('rpc/pro_coverage')).body.p_env, 1)
reset(); await getProView(env({}), uid)
check('8.2 PRO_ENV 缺失退回 0（现网）', calls.find((c) => c.url.includes('rpc/pro_coverage')).body.p_env, 0)
check('8.3 p_provider 恒为 wechat_mp', calls.find((c) => c.url.includes('rpc/pro_coverage')).body.p_provider, 'wechat_mp')

// 9. 🔴 p_now 与下发的 serverNow 同源（端上偏移不能与库内判定用两个时刻）
reset(); v = await getProView(env(), uid)
check('9.1 rpc 的 p_now ＝ 响应的 serverNow', calls.find((c) => c.url.includes('rpc/pro_coverage')).body.p_now, v.serverNow)

// 10. 会话端点：正常路径的响应形状与"不含 openid"
reset()
const req = new Request('https://cf/api/pro/session', { headers: { Authorization: 'Bearer x' } })
let res = await onRequestGet({ env: env(), data: { user: { id: uid } }, request: req })
let payload = await res.json()
check('10.1 端点 200', res.status, 200)
check('10.2 契约字段齐', Object.keys(payload).sort(), ['caps', 'proUntil', 'remainingDays', 'serverNow', 'wallsEnabled'])
check('10.3 响应里不含 openid／user_id', ['openid', 'user_id', 'callback_raw'].some((k) => JSON.stringify(payload).includes(k)), false)

// 11. 请求里塞开关 ⇒ 无效（服务端只读自己的部署变量）。这条是 #54 判据①的端上可测面
//     ⚠️ GET 请求不能带 body（undici 直接抛），所以塞在**头与查询串**两处，效果一样。
res = await onRequestGet({
  env: env({ PRO_WALLS_ENABLED: 'true' }),
  data: { user: { id: uid } },
  request: new Request('https://cf/api/pro/session?PRO_WALLS_ENABLED=false&wallsEnabled=false', {
    method: 'GET',
    headers: { Authorization: 'Bearer x', 'X-Pro-Walls-Enabled': 'false', 'X-Walls-Enabled': 'false' },
  }),
})
payload = await res.json()
check('11.1 请求体/头里的开关被无视（仍按部署变量）', [payload.wallsEnabled, payload.caps], [true, { notes: 500, balances: 100, cards: 100 }])

// 12. 端点侧的 fail-closed：rpc 挂了也回 200 + 免费档，并留一条可定位日志
reset(); stub.rpcStatus = 500
const logs = []
const realErr = console.error
console.error = (...a) => logs.push(a.join(' '))
res = await onRequestGet({ env: env(), data: { user: { id: uid } }, request: req })
console.error = realErr
payload = await res.json()
check('12.1 查询失败仍回 200（不把故障翻译成"你没会员"的弹窗）', res.status, 200)
check('12.2 失败时按免费档渲染', [payload.proUntil, payload.wallsEnabled, payload.caps], [null, false, null])
check('12.3 留了一条日志', logs.length >= 1, true)

// 13. 无 user（中间件正常会先拦）⇒ 401，不去出网
reset()
res = await onRequestGet({ env: env(), data: {}, request: req })
check('13.1 没有会话身份直接 401', res.status, 401)
check('13.2 且零出网', calls.length, 0)

// ── 静态判据 ───────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// 🔴 先剥注释再扫，且剥的时候要看字符串状态：本文件第一版直接对全文跑正则，结果
//   S5 命中了 proCoverage.js **自己的注释**（"不要在 JS 里再排 effective_at + duration_days"）
//   ⇒ 一条禁止某事的注释，会把禁止它的判据染红。反过来更危险：naive 地按 '//' 切断会
//   把 `'https://x'` 这种串里的双斜杠当注释起点，把后面的真代码吃掉 ⇒ 假绿。
//   所以这里带引号状态机，且只认成对的行注释/块注释。
function stripComments(src) {
  let out = ''
  let i = 0
  let str = null // "'" | '"' | '`'
  while (i < src.length) {
    const c = src[i]
    if (str) {
      out += c
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
      if (c === str) str = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; i++; continue }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; out += ' '; continue }
    out += c
    i++
  }
  return out
}

const fnFiles = walk(path.join(root, 'functions'))
const codeOf = new Map(fnFiles.map((f) => [f, stripComments(readFileSync(f, 'utf8'))]))
const rel = (f) => path.relative(root, f).replace(/\\/g, '/')
const hits = (re) => fnFiles.filter((f) => re.test(codeOf.get(f))).map(rel)

const rpcSites = hits(/rpc\/pro_coverage/)
check('S1 rpc/pro_coverage 全仓唯一调用点', rpcSites, ['functions/_lib/proCoverage.js'])
const tzSites = hits(/Asia\/Shanghai|at time zone/i)
check('S2 时区归一不活在 JS 里（含 `at time zone`，0 命中）', tzSites, [])
const flagSites = hits(/PRO_WALLS_ENABLED|PRO_PURCHASE_ENABLED/)
check('S3 开关标识符只在判定模块里出现', flagSites, ['functions/_lib/proCoverage.js'])
const reqFlagSites = hits(/headers\.get\(\s*['"]x-pro|searchParams\.get\(\s*['"](PRO_|wallsEnabled)/i)
check('S4 没有任何端点从请求头/查询串读会员开关', reqFlagSites, [])
// 🔴 S5 的着力点＝**算术形状**，不是列名同现：B3 的入账模块会合法地同时写 effective_at 与
//   duration_days（那是插进 pro_ledger 的两个列），拿"两词同现"当判据会在三个月后
//   变成一条要么被删、要么被加白名单的噪音。真正不该出现在 JS 里的是折叠算法本身。
const foldShape = hits(/prev_last_day|day_start|end_excl/)
check('S5a JS 里没有折叠算法的形状（prev_last_day/day_start/end_excl）', foldShape, [])
const sortSites = fnFiles.filter((f) => {
  const code = codeOf.get(f)
  return /effective_at/.test(code) && /\.sort\s*\(/.test(code)
}).map(rel)
check('S5b JS 里没有"按 effective_at 排序"的第二处实现', sortSites, [])

// ⚠️ 待补判据（B2 落地时一起加，现在加会立刻有争议）：
//   · 档位数值（CAPS）在 functions/ 里只有一处来源——今天的 notes.js 还从
//     shared/notesConfig.js 拿 NOTES_CAP，那正是 B2 要换掉的东西
//   · 七个写入口全部经过墙：入口清单与调用点计数

// ── 输出 ───────────────────────────────────────────────────────────────────
let fails = 0
for (const r of results) {
  if (!r.ok) fails++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        期望 ${JSON.stringify(r.want)}\n        现值 ${JSON.stringify(r.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
