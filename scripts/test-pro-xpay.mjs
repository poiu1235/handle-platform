// 服务端 `/xpay/*` 那条通道的离线判据（跑真源码，fetch 打桩）。
// 用法：npm run test:xpay
//
// 这台机器到 api.weixin.qq.com 的 TLS 被 SNI 重置 ⇒ 真调用只能在部署后跑（当初为这个写过一把
// 一次性探针，R-9 ⑱ 结案后已于 2026-10-06 删除），但**签名的形状、参数装配与错误码透传**
// 全都能在本地判死。
//
// ⚠️ 它证明不了的：status 枚举 0–10 各自的真值语义（文档抄来的，未与真单对过）。
//   "个人主体到底能不能调"这一格已经由现网真单证过（query_order 与 notify_provide_goods 两次）。

import crypto from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const expectHmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')

const pay = await import(pathToFileURL(path.join(root, 'functions/_lib/proPaySign.js')).href)
const xp = await import(pathToFileURL(path.join(root, 'functions/_lib/proXpay.js')).href)

// ── 1. serverPaySig：与端上那一条同公式（uri + '&' + post_body）───────────────
const URI = '/xpay/query_order'
const BODY = '{"openid":"oA","env":0,"order_id":"T123"}'
check('1.1 pay_sig ＝ HMAC(AppKey, "uri&post_body")', await xp.serverPaySig({ appKey: 'k1', uri: URI, postBody: BODY }), expectHmac('k1', `${URI}&${BODY}`))
check('1.2 uri 带 query ⇒ 抛（文档原话"切记不可带参数"）', await xp.serverPaySig({ appKey: 'k1', uri: URI + '?access_token=x', postBody: BODY }).then(() => 'no-throw', (e) => e.message), 'pro_pay_sig_uri_must_have_no_query')
check('1.3 空 body ⇒ 抛', await xp.serverPaySig({ appKey: 'k1', uri: URI, postBody: '' }).then(() => 'no-throw', (e) => e.message), 'pro_pay_sig_no_post_body')
check('1.4 缺 AppKey ⇒ 抛并指名变量', await xp.serverPaySig({ appKey: '', uri: URI, postBody: BODY }).then(() => 'no-throw', (e) => e.message), 'pro_pay_config_missing:WX_PAY_APPKEY_PROD')
// 端上拉起与服务端调用的签名必须出自同一个实现：漂了的形态是"平台说签名错"，看不出哪边漂
const clientSig = await pay.buildPayPayload({ env: { WX_PAY_OFFER_ID: 'o', WX_PAY_APPKEY_PROD: 'k1' }, sessionKey: 'sk', product: { productId: 'p', goodsPrice: 1 }, outTradeNo: 'T123', attach: '' })
check('1.5 与端上 paySig 同一个 HMAC 实现（同 key 同串 ⇒ 同值）', await xp.serverPaySig({ appKey: 'k1', uri: 'requestVirtualPayment', postBody: clientSig.postBody }), clientSig.paySig)

// ── 2. access_token ────────────────────────────────────────────────────────
let calls = []
let tokenBody = { access_token: 'TOKEN-abc', expires_in: 7200 }
let wxErr = null
const fetchStub = async (url, options) => {
  calls.push({ url: String(url), options })
  const body = String(url).includes('/cgi-bin/token') ? tokenBody : wxErr
  return { ok: true, status: 200, json: async () => body }
}
const env = { WX_APPID: 'wx1', WX_SECRET: 'sec1', WX_PAY_APPKEY_PROD: 'k1' }

calls = []
let t = await xp.getMiniAccessToken(env, fetchStub)
check('2.1 取到 token', [t.ok, t.token, t.expiresIn], [true, 'TOKEN-abc', 7200])
check('2.2 grant_type 是 client_credential 且带 appid/secret', calls[0].url.includes('grant_type=client_credential') && calls[0].url.includes('appid=wx1'), true)
check('2.3 🔴 返回值与 URL 里都不含 pay_sig 之外的凭证串（token 只出现在返回值一次）', calls[0].url.includes('TOKEN'), false)

calls = []
t = await xp.getMiniAccessToken({ WX_APPID: 'wx1' }, fetchStub)
check('2.4 缺 WX_SECRET ⇒ config_missing 且一次网都不出', [t.ok, t.errcode, calls.length], [false, 'config_missing', 0])

calls = []
tokenBody = { errcode: 40164, errmsg: 'ip not in whitelist' }
t = await xp.getMiniAccessToken(env, fetchStub)
check('2.5 真 errcode 原样透出（40164＝白名单，别伪装成"接口没权限"）', [t.ok, t.errcode, t.errmsg], [false, 40164, 'ip not in whitelist'])
tokenBody = { access_token: 'TOKEN-abc', expires_in: 7200 }

// ── 3. xpayServerPost ──────────────────────────────────────────────────────
calls = []
wxErr = { errcode: 0, errmsg: 'ok', order: { order_id: 'T123', status: 4, paid_time: 1790000000 } }
let r = await xp.xpayServerPost({ env, uri: URI, body: JSON.parse(BODY), accessToken: 'TOKEN-abc', fetchImpl: fetchStub })
check('3.1 errcode 0 ⇒ ok:true 且带 order', [r.ok, r.data.order.status], [true, 4])
check('3.2 出去的是 POST + 原样字符串 body', [r.sent, calls[0].options.method, calls[0].options.body], [BODY, 'POST', BODY])
check('3.3 query 里有 access_token 与 pay_sig，path 不带参数', [calls[0].url.startsWith('https://api.weixin.qq.com/xpay/query_order?access_token=TOKEN-abc&pay_sig='), calls[0].url.includes('/xpay/query_order?access_token')], [true, true])
check('3.4 pay_sig 就是 HMAC(uri&body)', calls[0].url.includes('pay_sig=' + expectHmac('k1', `${URI}&${BODY}`)), true)

calls = []
r = await xp.xpayServerPost({ env: { WX_APPID: 'wx1' }, uri: URI, body: { a: 1 }, accessToken: 'T', fetchImpl: fetchStub })
check('3.5 缺 AppKey ⇒ config_missing 且零出网（不拿空 key 去签）', [r.errcode, calls.length], ['config_missing', 0])
calls = []
r = await xp.xpayServerPost({ env, uri: URI, body: { a: 1 }, accessToken: '', fetchImpl: fetchStub })
check('3.6 没 token ⇒ no_access_token 且零出网', [r.errcode, calls.length], ['no_access_token', 0])
calls = []
wxErr = { errcode: 268490003, errmsg: '签名错误' }
r = await xp.xpayServerPost({ env, uri: URI, body: JSON.parse(BODY), accessToken: 'TOKEN-abc', fetchImpl: fetchStub })
check('3.7 268490003 原样透出且 ok:false（探针的判读全靠它）', [r.ok, r.errcode, r.sent], [false, 268490003, BODY])
wxErr = null
r = await xp.xpayServerPost({ env, uri: URI, body: { a: 1 }, accessToken: 'T', fetchImpl: fetchStub })
check('3.8 回包解析不出来 ⇒ unparseable，不抛', r.errcode, 'unparseable')
r = await xp.xpayServerPost({ env, uri: URI, body: { a: 1 }, accessToken: 'T', fetchImpl: async () => { throw new Error('boom') } })
check('3.9 出网抛错 ⇒ unreachable（永不抛到调用方）', r.errcode, 'unreachable')

// ── 4. xpayQueryOrder 的参数装配 ───────────────────────────────────────────
calls = []
wxErr = { errcode: 0, order: { status: 2 } }
r = await xp.xpayQueryOrder({ env, openid: 'oA', orderId: 'T123', fetchImpl: fetchStub })
check('4.1 两次 HTTP：先 token 后接口', calls.map((c) => (c.url.includes('/cgi-bin/token') ? 'token' : 'api')), ['token', 'api'])
check('4.2 body ＝ openid + env(默认0) + order_id', JSON.parse(r.sent), { openid: 'oA', env: 0, order_id: 'T123' })
check('4.3 没给 openid ⇒ 不打出去（文档必填）', (await xp.xpayQueryOrder({ env, orderId: 'T1', fetchImpl: fetchStub })).errcode, 'no_openid')
check('4.4 两个单号都不给 ⇒ 不打出去（"二选一"未证，不赌）', (await xp.xpayQueryOrder({ env, openid: 'oA', fetchImpl: fetchStub })).errcode, 'no_order_id')
r = await xp.xpayQueryOrder({ env, openid: 'oA', wxOrderId: 'wx9', envFlag: 1, fetchImpl: fetchStub })
check('4.5 也支持按 wx_order_id 查；env 是接口的 0/1（不是库里的 env_type 1/2）', JSON.parse(r.sent), { openid: 'oA', env: 1, wx_order_id: 'wx9' })
r = await xp.xpayQueryOrder({ env, openid: 'oA', orderId: 'T1', fetchImpl: async (u) => { if (String(u).includes('/cgi-bin/token')) return { ok: true, status: 200, json: async () => ({ errcode: 40125, errmsg: 'invalid appsecret' }) }; return { ok: true, status: 200, json: async () => ({}) } } })
check('4.6 token 那一步失败 ⇒ 不再打接口，错误码带 token_ 前缀（两支分得开）', [r.errcode, r.sent], ['token_40125', null])

// ── 6. 静态门：HMAC 只有一份、诊断件不许留在树上 ────────────────────────────
const fnDir = path.join(root, 'functions')
const walk = (d, out = []) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.js')) out.push(p)
  }
  return out
}
const files = walk(fnDir)
const relf = (f) => path.relative(root, f).split(path.sep).join('/')
const hmacSites = files.filter((f) => /crypto\.subtle\.sign/.test(readFileSync(f, 'utf8'))).map(relf)
check('6.1 HMAC 实现只有一处（端上与服务端共用）', hmacSites, ['functions/_lib/proPaySign.js'])
const tokenSites = files.filter((f) => /cgi-bin\/token/.test(readFileSync(f, 'utf8'))).map(relf)
check('6.2 access_token 的取法只在 proXpay.js', tokenSites, ['functions/_lib/proXpay.js'])
const probeFiles = files.filter((f) => relf(f).startsWith('functions/probe/'))
// 🔴 这三条的形状是**反着**的：探针（R-9 ⑱ 那次一次性诊断路由）已于 2026-10-06 删除，
//   留着的那道门就从"诊断件"变成"公网可达、只有一把口令的入站路由"。所以这里断的是
//   **禁止的形态**，不是"某个文件存在"——后者在删掉之后会变成一条无牙的判据（它自己红了才发现）。
check('6.3 functions/probe/ 整个目录不许存在（跑完就删，不许"先留着以后方便"）', probeFiles.map(relf), [])
check('6.4 functions/ 下不许再出现 PROBE_TOKEN 这个凭证名（删文件不删口令＝留一把只有口令、没有消费者的门）', files.filter((f) => /PROBE_TOKEN/.test(readFileSync(f, 'utf8'))).map(relf), [])
const inboundDirs = readdirSync(fnDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('_') && e.name !== 'api')
  .map((e) => e.name)
  .sort()
// `api` 那一支由 `_middleware.js` 要用户 Bearer；剩下这三个是**故意**免 Bearer 的，各自的门不同：
// `auth`＝本来就是登录入口、`push`＝平台验签、`admin`＝`PRO_ADMIN_TOKEN`。
// 多出一个名字＝新开了第四道"没有用户凭证也能打进来"的门 ⇒ 这条红了先回来补鉴权口径，别改名让它过。
check('6.5 免 Bearer 的入站目录只有 admin／auth／push 这三个（各自的门都已逐条判过）', inboundDirs, ['admin', 'auth', 'push'])

let fails = 0
for (const x of results) {
  if (!x.ok) {
    fails++
    console.log(`❌ ${x.name}\n   got : ${JSON.stringify(x.got)}\n   want: ${JSON.stringify(x.want)}`)
  }
}
console.log(`\n${results.length - fails}/${results.length} 格通过`)
process.exit(fails ? 1 : 0)
