// B3-2 签名侧的离线判据：functions/_lib/proPaySign.js（跑真源码）。
// 用法：npm run test:pay
//
// 这台机器到 *.supabase.co / api.weixin.qq.com 的 TLS 被 SNI 重置 ⇒ 真链路只能部署后测，
// 但**签名的形状**不必等网络：HMAC 用 node:crypto 独立算一遍当交叉验证（不是自证），
// "端上重排键序就会失效"、"session_key 一个字符都不许外流"这两件事都能在本地判死。
//
// ⚠️ 它证明不了的：微信是否接受这个 post_body 形状、道具是否已在后台发布（goodsPrice 参与签名，
//   道具没发布则下单必失败）、以及 R-9 那批未证字段。

import crypto from 'node:crypto'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })
const has = (s, sub) => String(s).includes(sub)

const m = await import(pathToFileURL(path.join(root, 'functions/_lib/proPaySign.js')).href)

const product = { productId: 'pro_month', goodsPrice: 100 }
const env = { WX_PAY_OFFER_ID: 'offer123', WX_PAY_APPKEY_PROD: 'appkey-abc' }
const SESSION_KEY = 'sk-demo-0123456789abcdef'

// ── 1. 单号形状（官方：8–32 位、不以下划线开头、不可复用）──────────────────
const otn = m.makeOutTradeNo()
check('1.1 形如 T+13位毫秒+8位hex', /^T\d{13}[0-9a-f]{8}$/.test(otn), true)
check('1.2 长度落在 8–32', otn.length >= 8 && otn.length <= 32, true)
check('1.3 首字符不是下划线', otn.startsWith('_'), false)
check('1.4 同毫秒也不撞号（随机段真在动）', m.makeOutTradeNo() !== m.makeOutTradeNo(), true)

// ── 2. payload 组装与两个签名 ──────────────────────────────────────────────
const p = await m.buildPayPayload({ env, sessionKey: SESSION_KEY, product, outTradeNo: otn, attach: 'u-1' })
check('2.1 post_body 键序固定（它就是签名输入）', Object.keys(JSON.parse(p.postBody)).join(','), 'offerId,buyQuantity,env,currencyType,productId,goodsPrice,outTradeNo,attach')
check('2.2 env 固定 0、buyQuantity 固定 1（D-10／3.1）', [JSON.parse(p.postBody).env, JSON.parse(p.postBody).buyQuantity], [0, 1])
check('2.3 金额取服务端表（入参 product 决定，端上无处传价）', JSON.parse(p.postBody).goodsPrice, 100)
check('2.4 两个签名都是 64 位 hex', [/^[0-9a-f]{64}$/.test(p.paySig), /^[0-9a-f]{64}$/.test(p.signature)], [true, true])

// ── 3. 🔴 交叉验证：用 node:crypto 独立算一遍期望值（不是拿实现自证）────────
const expectHmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex')
check('3.1 paySig ＝ HMAC(AppKey, "requestVirtualPayment&"+post_body)', p.paySig, expectHmac('appkey-abc', `requestVirtualPayment&${p.postBody}`))
check('3.2 signature ＝ HMAC(session_key, post_body)', p.signature, expectHmac(SESSION_KEY, p.postBody))
check('3.3 两个签名不同源（一个用 AppKey、一个用 session_key）', p.paySig === p.signature, false)

// ── 4. 逐字节一致这条纪律的实际后果 ────────────────────────────────────────
const reordered = JSON.stringify({ attach: 'u-1', offerId: 'offer123', buyQuantity: 1, env: 0, currencyType: 'CNY', productId: 'pro_month', goodsPrice: 100, outTradeNo: otn })
const p2 = await m.buildPayPayload({ env, sessionKey: SESSION_KEY, product, outTradeNo: otn, attach: 'u-1' })
check('4.1 同内容换键序 ⇒ 签名必然失效（所以端上只能原样传字符串）', expectHmac('appkey-abc', `requestVirtualPayment&${reordered}`) === p2.paySig, false)
check('4.2 端上多一个空格也失效', expectHmac('appkey-abc', `requestVirtualPayment&${p.postBody} `) === p2.paySig, false)

// ── 5. 配置缺失与脏输入：只能抛，不许静默签出个废名 ─────────────────────────
const throws = async (fn) => {
  try {
    await fn()
    return 'no-throw'
  } catch (e) {
    return String(e.message)
  }
}
check('5.1 缺 offerId ⇒ 抛并指名缺哪个变量', await throws(() => m.buildPayPayload({ env: { WX_PAY_APPKEY_PROD: 'k' }, sessionKey: SESSION_KEY, product, outTradeNo: otn })), 'pro_pay_config_missing:WX_PAY_OFFER_ID')
check('5.2 缺 AppKey ⇒ 抛（这把是 secret，最容易漏配）', await throws(() => m.buildPayPayload({ env: { WX_PAY_OFFER_ID: 'o' }, sessionKey: SESSION_KEY, product, outTradeNo: otn })), 'pro_pay_config_missing:WX_PAY_APPKEY_PROD')
check('5.3 没有 session_key ⇒ 抛，不退回"签个空的"', await throws(() => m.buildPayPayload({ env, sessionKey: '', product, outTradeNo: otn })), 'pro_pay_no_session_key')
check('5.4 金额不是正整数 ⇒ 抛（占位价写错也要当场响）', await throws(() => m.buildPayPayload({ env, sessionKey: SESSION_KEY, product: { productId: 'x', goodsPrice: 0 }, outTradeNo: otn })), 'pro_pay_bad_product')

// ── 6. code2session 通道：session_key 只在这条线上出现，且不外流 ────────────
let lastFetchUrl = ''
let stubBody = { openid: 'oK', session_key: SESSION_KEY, unionid: 'uK' }
let logged = []
const realErr = console.error
console.error = (...a) => logged.push(a.map(String).join(' '))
globalThis.fetch = async (url) => {
  lastFetchUrl = String(url)
  return { ok: true, status: 200, json: async () => stubBody }
}
const envWx = { WX_APPID: 'wx1', WX_SECRET: 'sec1' }
let r = await m.code2sessionKey('code-1', envWx)
check('6.1 换取成功 ⇒ openid + sessionKey 都在（前置②与签名一次调用搞定）', [r.ok, r.openid, r.sessionKey], [true, 'oK', SESSION_KEY])
check('6.2 请求带 grant_type 且 code 已 URL 编码', has(lastFetchUrl, 'grant_type=authorization_code') && has(lastFetchUrl, 'js_code=code-1'), true)
check('6.3 🔴 成功路径一行日志都不打（session_key 无处可漏）', logged.length, 0)

logged = []
r = await m.code2sessionKey('code-1', { WX_APPID: 'wx1' })
check('6.4 缺 WX_SECRET ⇒ config_missing（与"code 无效"分开，别把服务端故障说成用户的错）', [r.ok, r.errcode], [false, 'config_missing'])
check('6.4b 缺配置时一次请求都不发', logged.length, 0)

stubBody = { errcode: 40029, errmsg: 'invalid code' }
logged = []
r = await m.code2sessionKey('bad', envWx)
check('6.5 真 errcode ⇒ ok:false 并原样透出（40029＝code 无效或已被用）', [r.ok, r.errcode], [false, 40029])
check('6.6 🔴 失败日志里没有 session_key 的任何一段', logged.join('|').includes(SESSION_KEY.slice(0, 8)), false)

stubBody = { openid: 'oK' }
r = await m.code2sessionKey('c', envWx)
check('6.7 响应缺 session_key ⇒ 不算成功（宁可拒单也不签废名）', [r.ok, r.errcode], [false, 'unparseable'])
stubBody = { session_key: SESSION_KEY }
check('6.8 响应缺 openid ⇒ 同样不算成功', (await m.code2sessionKey('c', envWx)).ok, false)
stubBody = null
check('6.9 响应体解析不出来 ⇒ unparseable，不抛到外面', (await m.code2sessionKey('c', envWx)).errcode, 'unparseable')
console.error = realErr

// ── 7. 给端上的东西里不许有凭证 ────────────────────────────────────────────
const client = m.toClientPayParams(p)
const clientText = JSON.stringify(client)
check('7.1 mode 固定 short_series_goods', client.mode, 'short_series_goods')
check('7.2 只回 mode/signData/paySig/signature 四样', Object.keys(client).sort(), ['mode', 'paySig', 'signData', 'signature'])
check('7.3 🔴 响应里没有 session_key／openid', [has(clientText, SESSION_KEY), has(clientText, 'session_key'), has(clientText, 'oK')], [false, false, false])
check('7.4 attach 原样带回（下单时的 user_id 留痕）', JSON.parse(p.postBody).attach, 'u-1')

// ── 8. 静态门：U-7 ⓐ 的"不落库、不缓存"要能被机器看住 ──────────────────────
const src = readFileSync(path.join(root, 'functions/_lib/proPaySign.js'), 'utf8')
const cacheShapes = ['new Map', 'new Set', 'globalThis.', 'let cache', 'const cache', 'sessionKeyStore']
check('8.1 文件里没有任何缓存结构（session_key 只能活在一次调用里）', cacheShapes.filter((s) => src.includes(s)), [])
check('8.2 session_key 只从 data.session_key 来、只进 hmac 调用', (src.match(/session_key/g) || []).length > 0 && !/console\.[a-z]+\([^)]*sessionKey/.test(src), true)
const wxt = readFileSync(path.join(root, 'functions/_lib/wxTicket.js'), 'utf8')
check('8.3 既有 code2session 仍不返回 session_key（新通道没顺手放宽它）', /return \{ ok: true, openid: data\.openid, unionid:.*session_key/.test(wxt), false)

let fails = 0
for (const x of results) {
  if (!x.ok) fails++
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : `\n        期望 ${JSON.stringify(x.want)}\n        现值 ${JSON.stringify(x.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
