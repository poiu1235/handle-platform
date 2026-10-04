// B3-1 的离线判据：商品配置（proCatalog.js）与在售列表（api/pro/products.js）。
// 用法：npm run test:catalog
//
// 跑的是真源码，fetch 打桩（同 test:pro 那条路子）。这台机器到 *.supabase.co 的 TLS 被 SNI 重置，
// 所以"真链路"要等部署后测；但**两道守卫的方向**（测试档恒需白名单、正常档看名单是否为空）
// 与"响应里不许有 openid"这两件事不需要网络就能判死。
//
// ⚠️ 它证明不了的：微信侧道具是否已发布（`goodsPrice` 是签名组成部分，道具没发布则下单必失败）、
//   以及 D-7 定价——下面那两个价格是**占位值**，本文件只判"有且只有一处来源"。

import path from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const results = []
const check = (name, got, want) => results.push({ name, ok: JSON.stringify(got) === JSON.stringify(want), got, want })

const cat = await import(pathToFileURL(path.join(root, 'functions/_lib/proCatalog.js')).href)

// ── 1. 配置本体 ─────────────────────────────────────────────────────────────
check('1.1 三档都在表里', Object.keys(cat.CATALOG).sort(), ['pro_month', 'pro_test_day', 'pro_year'])
check('1.2 期限＝30／365／1（D-6 已判维持 30/365）', ['pro_month', 'pro_year', 'pro_test_day'].map((p) => cat.durationDaysFor(p)), [30, 365, 1])
check('1.3 测试档 onSale=false（不进在售列表）', cat.catalogEntry('pro_test_day').onSale, false)
check('1.4 正常档 onSale=true', [cat.catalogEntry('pro_month').onSale, cat.catalogEntry('pro_year').onSale], [true, true])
check('1.5 未知 productId ⇒ null（下单侧据此拒，不许兜底成月卡）', [cat.catalogEntry('pro_week'), cat.durationDaysFor('nope')], [null, null])
check('1.6 价格单位＝分且是整数（6.3 实证 goodsPrice 单位）', Object.values(cat.CATALOG).every((e) => Number.isInteger(e.goodsPrice) && e.goodsPrice > 0), true)

// ── 2. 白名单解析与两道守卫的方向 ──────────────────────────────────────────
check('2.1 缺失＝空集合（不是"不限制"）', cat.testWhitelist({}), [])
check('2.2 逗号分隔 + 去空白 + 去空项', cat.testWhitelist({ PRO_TEST_OPENIDS: ' oA , ,oB, ' }), ['oA', 'oB'])
check('2.3 名单为空 ⇒ 测试档对谁都不给（fail-closed）', cat.testAllowed({ PRO_TEST_OPENIDS: '' }, 'oA'), false)
check('2.4 名单内 ⇒ 给', cat.testAllowed({ PRO_TEST_OPENIDS: 'oA,oB' }, 'oB'), true)
check('2.5 没绑微信（openid null）⇒ 不给', [cat.testAllowed({ PRO_TEST_OPENIDS: 'oA' }, null), cat.testAllowed({ PRO_TEST_OPENIDS: 'oA' }, '')], [false, false])
check('2.6 名单非空＝内测形态（正常档也收紧）', cat.purchaseWhitelistActive({ PRO_TEST_OPENIDS: 'oA' }), true)
check('2.7 名单为空＝发布形态（正常档全量）', cat.canBuyNormalTier({ PRO_TEST_OPENIDS: '' }, null), true)
check('2.8 内测形态下名单外的人买不到正常档', cat.canBuyNormalTier({ PRO_TEST_OPENIDS: 'oA' }, 'oZ'), false)

const ids = (env, openid) => cat.sellableProducts(env, openid).map((p) => p.productId).sort()
check('2.9 发布态列表＝两档正常，🔴 绝不含测试档', ids({ PRO_TEST_OPENIDS: '' }, 'oA'), ['pro_month', 'pro_year'])
check('2.10 内测态名单内＝三档', ids({ PRO_TEST_OPENIDS: 'oA' }, 'oA'), ['pro_month', 'pro_test_day', 'pro_year'])
check('2.11 内测态名单外＝空列表', ids({ PRO_TEST_OPENIDS: 'oA' }, 'oZ'), [])
check('2.12 列表项字段齐（价格/期限/币种/isTest）', Object.keys(cat.sellableProducts({}, 'oA')[0]).sort(), ['currency', 'durationDays', 'goodsPrice', 'isTest', 'name', 'productId'])

// ── 3. 端点：fetch 打桩（只有一条 identity 路由）───────────────────────────
let calls = []
let stub = { identityRows: [{ openid: 'oA' }], identityStatus: 200 }
globalThis.fetch = async (url) => {
  const u = String(url)
  calls.push(u)
  const mk = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
  if (u.includes('/rest/v1/user_identities')) {
    if (stub.identityStatus !== 200) return mk({ message: 'boom' }, stub.identityStatus)
    return mk(stub.identityRows)
  }
  throw new Error('未预期的出网目标：' + u)
}
const reset = () => {
  calls = []
  stub = { identityRows: [{ openid: 'oA' }], identityStatus: 200 }
}
const { onRequestGet } = await import(pathToFileURL(path.join(root, 'functions/api/pro/products.js')).href)
const envOf = (over = {}) => ({ SUPABASE_URL: 'https://fake', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'k', PRO_WALLS_ENABLED: 'false', PRO_PURCHASE_ENABLED: 'true', PRO_ENV: '0', PRO_TEST_OPENIDS: '', ...over })
const ctx = (env) => ({ env, data: { user: { id: 'u-1' } }, request: new Request('https://cf/api/pro/products') })
const bodyOf = async (res) => res.json()

reset()
let res = await onRequestGet(ctx(envOf()))
let body = await bodyOf(res)
check('3.1 购买开着 ⇒ 200 + purchaseEnabled:true', [res.status, body.purchaseEnabled], [200, true])
check('3.2 发布态两档', body.products.map((p) => p.productId).sort(), ['pro_month', 'pro_year'])
check('3.3 🔴 响应里不含 openid／user_id', ['openid', 'user_id', 'oA'].some((k) => JSON.stringify(body).includes(k)), false)

reset(); stub.identityRows = []
body = await bodyOf(await onRequestGet(ctx(envOf())))
check('3.4 纯 Web 账号（没绑微信）⇒ 正常档照给、测试档不给', body.products.map((p) => p.productId).sort(), ['pro_month', 'pro_year'])

reset()
body = await bodyOf(await onRequestGet(ctx(envOf({ PRO_PURCHASE_ENABLED: 'false' }))))
check('3.5 购买入口关着 ⇒ 空列表 + purchaseEnabled:false', [body.purchaseEnabled, body.products.length], [false, 0])
check('3.6 关着时一次数据库都不问（开关只读 env，不必查身份）', calls.length, 0)

reset()
body = await bodyOf(await onRequestGet(ctx(envOf({ PRO_TEST_OPENIDS: 'oA' }))))
check('3.7 内测态名单内 ⇒ 三档（含测试道具）', body.products.map((p) => p.productId).sort(), ['pro_month', 'pro_test_day', 'pro_year'])

reset(); stub.identityStatus = 500
res = await onRequestGet(ctx(envOf({ PRO_TEST_OPENIDS: 'oA' })))
body = await bodyOf(res)
check('3.8 identity 读失败 ⇒ 200 + 空列表（收紧方向，不 5xx、不猜名单）', [res.status, body.products.length], [200, 0])

reset()
const sneaky = { env: envOf({ PRO_TEST_OPENIDS: 'oA' }), data: { user: { id: 'u-1' } }, request: new Request('https://cf/api/pro/products?PRO_TEST_OPENIDS=oZ&purchase=true') }
body = await bodyOf(await onRequestGet(sneaky))
check('3.9 请求里塞开关/白名单 ⇒ 无效（只认部署变量：名单 oA + 身份 oA ⇒ 三档照给）', body.products.map((p) => p.productId).sort(), ['pro_month', 'pro_test_day', 'pro_year'])

// ── 4. 静态门 ───────────────────────────────────────────────────────────────
const jsFiles = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.js')) jsFiles.push(p)
  }
}
walk(path.join(root, 'functions'))
const read = (p) => readFileSync(p, 'utf8')

// 4.1 档位数字（期限/价格）只能出现在 proCatalog.js 里——别处再写一份就是第二个来源（3.3 门槛②）
const tierSites = jsFiles
  .filter((p) => !p.endsWith('proCatalog.js'))
  .filter((p) => /durationDays\s*[:=]\s*\d|goodsPrice\s*[:=]\s*\d/.test(read(p)))
  .map((p) => path.relative(root, p).split(path.sep).join('/'))
check('4.1 期限/价格数字只在 proCatalog 一处', tierSites, [])
// 4.2 白名单变量只被 proCatalog 读（别处判名单＝第二个守卫实现）
const wlSites = jsFiles
  .filter((p) => !p.endsWith('proCatalog.js'))
  .filter((p) => /PRO_TEST_OPENIDS/.test(read(p)))
  .map((p) => path.relative(root, p).split(path.sep).join('/'))
check('4.2 PRO_TEST_OPENIDS 只在 proCatalog 被读', wlSites, [])
// 4.3 测试档守卫不许被"列表里有没有"替代：下单侧将来必须自己调 testAllowed/canBuyNormalTier
const guardSites = jsFiles.filter((p) => /testAllowed|canBuyNormalTier/.test(read(p))).map((p) => path.basename(p))
check('4.4 守卫函数的消费者＝proCatalog 自身 + proCatalog（products 只经 sellableProducts）', guardSites, ['proCatalog.js'])
// 4.5 端点不许把 openid 写进响应：proCoverage 导出的 getAccountOpenid 只允许被服务端模块用
const openidSites = jsFiles.filter((p) => /getAccountOpenid/.test(read(p))).map((p) => path.basename(p)).sort()
check('4.5 getAccountOpenid 的消费者清单（新增消费者要一起看 4.6 的"不下发 openid"）', openidSites, ['proCoverage.js', 'products.js'])

let fails = 0
for (const r of results) {
  if (!r.ok) fails++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        期望 ${JSON.stringify(r.want)}\n        现值 ${JSON.stringify(r.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
