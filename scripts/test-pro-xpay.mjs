// 服务端 `/xpay/*` 那条通道与一次性探针的离线判据（跑真源码，fetch 打桩）。
// 用法：npm run test:xpay
//
// 这台机器到 api.weixin.qq.com 的 TLS 被 SNI 重置 ⇒ 真调用只能在部署后跑（探针就是为这个写的），
// 但**签名的形状、参数装配、守卫与错误码透传**全都能在本地判死——
// 尤其"探针没配口令时一次网都不出"这一条：它是诊断件唯一的自我约束。
//
// ⚠️ 它证明不了的：个人主体到底能不能调（＝R-9 ⑱，探针跑现网才有答案）、
//   status 枚举 0–10 各自的真值语义（文档抄来的，未与真单对过）、假单号会回哪个 errcode。

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
const probe = await import(pathToFileURL(path.join(root, 'functions/probe/xpay-query.js')).href)

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

// ── 5. 探针路由的守卫（诊断件唯一的自我约束）────────────────────────────────
// 路由本身不接 fetchImpl（Pages Functions 的调用签名是固定的），所以这里打桩 globalThis.fetch
// ——`fetchImpl = fetch` 是**默认参数**，在调用时才求值，桩因此生效。
globalThis.fetch = fetchStub
const req = (q) => new Request('https://cf/probe/xpay-query' + q)
calls = []
let pr = await probe.onRequestGet({ request: req('?key=abc'), env: { ...env }, context: {} })
check('5.1 没配 PROBE_TOKEN ⇒ 503 probe_disabled 且零出网', [pr.status, (await pr.json()).code, calls.length], [503, 'probe_disabled', 0])
pr = await probe.onRequestGet({ request: req('?key=wrong'), env: { ...env, PROBE_TOKEN: 'right' } })
check('5.2 口令不对 ⇒ 403 probe_unauthorized 且零出网', [pr.status, (await pr.json()).code, calls.length], [403, 'probe_unauthorized', 0])
pr = await probe.onRequestGet({ request: req(''), env: { ...env, PROBE_TOKEN: 'right' } })
check('5.3 不带 key ⇒ 同样 403（缺省不等于放行）', pr.status, 403)

calls = []
wxErr = { errcode: 0, errmsg: 'ok', order: { order_id: 'x', status: 4, paid_time: 1, paid_fee: 1 } }
pr = await probe.onRequestGet({ request: req('?key=right'), env: { ...env, PROBE_TOKEN: 'right' } })
let pb = await pr.json()
check('5.4 口令对 ⇒ 200，判读字段齐（含 meaning）', [pr.status, pb.verdict, pb.errcode, Array.isArray(pb.orderKeys), typeof pb.meaning], [200, 'callable', 0, true, 'string'])
check('5.5 🔴 回包里没有 access_token 与 AppKey 的值', [JSON.stringify(pb).includes('TOKEN-abc'), JSON.stringify(pb).includes('"k1"')], [false, false])
check('5.6 假单号与真单号同形（T+13位+8hex）⇒ 查不到才是"查无此单"，不是"格式错"', /^T\d{13}[0-9a-f]{8}$/.test(JSON.parse(pb.sent).order_id), true)

calls = []
wxErr = { errcode: 48001, errmsg: 'api unauthorized' }
pb = await (await probe.onRequestGet({ request: req('?key=right'), env: { ...env, PROBE_TOKEN: 'right' } })).json()
check('5.7 48001 原样透出（⑱ 的"不可用"那一支就是靠它判）', [pb.verdict, pb.errcode], ['see errcode', 48001])
check('5.7b meaning 归到"接口没权限"那一层，并指回 4.5 重判', pb.meaning.includes('重判 4.5'), true)

// 5.8–5.10 🔴 现网 2026-10-04 真回过的那一支：`268490001 openid错误`。
// 判据的重点不是"错了"，而是**错在哪一层**：能报 openid 错，说明 access_token 与 pay_sig 都过了
// ——这一条要是被读成"探针失败"，就等于白扔了一次已经证到"签名算法正确"的调用。
calls = []
wxErr = { errcode: 268490001, errmsg: 'openid错误 rid: 6ac25f67-10929f10-11872562' }
pb = await (await probe.onRequestGet({ request: req('?key=right'), env: { ...env, PROBE_TOKEN: 'right' } })).json()
check('5.8 268490001 原样透出（rid 留着，报给微信排障要用）', [pb.errcode, pb.errmsg.includes('rid:')], [268490001, true])
check('5.9 meaning 把它归到"签名与凭证已过"那一层，而不是笼统"失败"', pb.meaning.includes('access_token 都已通过'), true)
check('5.10 同一支里写明"主体权限仍未判死"（防下一轮过度解读）', pb.meaning.includes('仍未判死'), true)

// 5.11–5.13 🔴 第二跑（真 openid）：`268490002 数据不存在` ⇒ ⑱ 的答案。
// ⚠️ 顺手记一条与文档不符的事实：错误码表把 268490002 写成"请求参数字段错误"，
//    实测回的 errmsg 是"数据不存在"⇒ 这一码的语义按 errmsg 读，别按文档读（判据 5.13 钉的就是这句）。
calls = []
wxErr = { errcode: 268490002, errmsg: '数据不存在 rid: 6ac26837' }
pb = await (await probe.onRequestGet({ request: req('?key=right&openid=ob9w-real'), env: { ...env, PROBE_TOKEN: 'right' } })).json()
check('5.11 真 openid 不再报 268490001（openid 归属那一关过了）', pb.errcode, 268490002)
check('5.12 meaning 把它读成"查无此单"，并给出"接口对个人主体可用"的结论', [pb.meaning.includes('查无此单'), pb.meaning.includes('个人主体可用')], [true, true])
check('5.13 meaning 里明写"文档把这一码说成参数字段错，与实测不符"（防我按文档实现）', pb.meaning.includes('与实测不符'), true)
check('5.14 传进来的 openid 原样出现在 sent 里（探针可指定，不用改代码再部署）', JSON.parse(pb.sent).openid, 'ob9w-real')

// ── 6. 静态门：HMAC 只有一份、诊断件必须带守卫 ──────────────────────────────
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
check('6.3 诊断路由只有一个文件（本批的探针），且必须带 PROBE_TOKEN 守卫', [probeFiles.map(relf), probeFiles.every((f) => readFileSync(f, 'utf8').includes('PROBE_TOKEN'))], [['functions/probe/xpay-query.js'], true])
// 🔴 这条是给"以后"准备的：诊断件容易被忘。它红了说明树上多了第二个探针文件——先删掉再往下走。
check('6.4 functions/probe/ 下不许出现第二个文件（跑完就删，不留方便）', probeFiles.length, 1)
check('6.5 探针不在 /api/** 下（不受 Bearer 中间件影响，所以自身守卫就是唯一防线）', probeFiles.every((f) => !relf(f).includes('/api/')), true)

let fails = 0
for (const x of results) {
  if (!x.ok) {
    fails++
    console.log(`❌ ${x.name}\n   got : ${JSON.stringify(x.got)}\n   want: ${JSON.stringify(x.want)}`)
  }
}
console.log(`\n${results.length - fails}/${results.length} 格通过`)
process.exit(fails ? 1 : 0)
