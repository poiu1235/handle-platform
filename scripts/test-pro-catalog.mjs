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

// ── 1. 配置本体（id 与价格必须与后台发布的道具逐字一致）────────────────────
const FIVE = ['monthly_mem_android', 'monthly_mem_apple', 'monthly_test', 'yearly_mem_android', 'yearly_mem_apple']
check('1.1 后台那五个道具都在表里', Object.keys(cat.CATALOG).sort(), FIVE)
check('1.2 期限＝月 30／年 365（D-6）；测试道具按后台文案是 1 天（D-10 原设计）', ['monthly_mem_android', 'yearly_mem_apple', 'monthly_test'].map((p) => cat.durationDaysFor(p)), [30, 365, 1])
check('1.2b 价格单位已确认：后台显示元、传输用分（0.01 元＝1 分）⇒ R-9 ⑰ 结案', cat.catalogEntry('monthly_test').goodsPrice, 1)
check('1.3 价格（分）与后台一致：333／388／4990／5990／1', ['monthly_mem_android', 'monthly_mem_apple', 'yearly_mem_android', 'yearly_mem_apple', 'monthly_test'].map((p) => cat.catalogEntry(p).goodsPrice), [333, 388, 4990, 5990, 1])
check('1.4 iOS 比安卓贵（差价 0.55／10.00 元，Apple 佣金那一侧）', [cat.catalogEntry('monthly_mem_apple').goodsPrice - cat.catalogEntry('monthly_mem_android').goodsPrice, cat.catalogEntry('yearly_mem_apple').goodsPrice - cat.catalogEntry('yearly_mem_android').goodsPrice], [55, 1000])
check('1.5 测试档 onSale=false（不进在售列表）', cat.catalogEntry('monthly_test').onSale, false)
check('1.6 正常档 onSale=true', FIVE.filter((p) => p !== 'monthly_test').every((p) => cat.catalogEntry(p).onSale), true)
check('1.7 未知 productId ⇒ null（下单侧据此拒，不许兜底成月卡）', [cat.catalogEntry('pro_month'), cat.durationDaysFor('nope')], [null, null])
check('1.8 价格都是正整数（单位＝分，6.3 实证）', Object.values(cat.CATALOG).every((e) => Number.isInteger(e.goodsPrice) && e.goodsPrice > 0), true)
check('1.9 档位与渠道都挂在行上（订单页要按档位说"月卡"，按渠道说价）', [cat.catalogEntry('yearly_mem_android').tier, cat.catalogEntry('yearly_mem_android').platform], ['yearly', 'android'])

// 1.10~ 选品：端上只能报"档位 + 渠道"，价格由服务端查表
check('1.10 月卡 + 安卓 ⇒ monthly_mem_android／333', (() => { const e = cat.productFor('monthly', 'android'); return [e.productId, e.goodsPrice] })(), ['monthly_mem_android', 333])
check('1.11 月卡 + iOS ⇒ monthly_mem_apple／388', (() => { const e = cat.productFor('monthly', 'ios'); return [e.productId, e.goodsPrice] })(), ['monthly_mem_apple', 388])
check('1.12 渠道缺失 ⇒ null（宁可拒单，也不"默认按安卓价"）', [cat.productFor('monthly', ''), cat.productFor('monthly', null), cat.productFor('monthly', 'unknown'), cat.productFor('monthly', 'devtools')], [null, null, null, null])
check('1.13 档位不存在 ⇒ null', cat.productFor('weekly', 'android'), null)
check('1.14 测试道具不分渠道（两端同一个 id）', [cat.productFor('monthly_test', 'android').productId, cat.productFor('monthly_test', 'ios').productId], ['monthly_test', 'monthly_test'])

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
check('2.9 发布态列表＝四个正常道具，🔴 绝不含测试档', ids({ PRO_TEST_OPENIDS: '' }, 'oA'), ['monthly_mem_android', 'monthly_mem_apple', 'yearly_mem_android', 'yearly_mem_apple'])
check('2.10 内测态名单内＝五个', ids({ PRO_TEST_OPENIDS: 'oA' }, 'oA'), FIVE)
check('2.11 内测态名单外＝空列表', ids({ PRO_TEST_OPENIDS: 'oA' }, 'oZ'), [])
check('2.12 列表项字段齐（档位/渠道/价格/期限/币种/isTest）', Object.keys(cat.sellableProducts({}, 'oA')[0]).sort(), ['currency', 'durationDays', 'goodsPrice', 'isTest', 'name', 'platform', 'productId', 'tier'])

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
// `memberCaps` 的判据要对着**正本**比，不能对着测试自己抄的一份数字比（那样改 CAPS 时判据会跟着改，
// 就成了自证）。同一份模块的另一处导出顺带拿过来用。
const { CAPS: catCaps } = await import(pathToFileURL(path.join(root, 'functions/_lib/proCoverage.js')).href)
const envOf = (over = {}) => ({ SUPABASE_URL: 'https://fake', SUPABASE_ANON_KEY: 'a', SUPABASE_SERVICE_ROLE_KEY: 'k', PRO_WALLS_ENABLED: 'false', PRO_PURCHASE_ENABLED: 'true', PRO_ENV: '0', PRO_TEST_OPENIDS: '', ...over })
const ctx = (env) => ({ env, data: { user: { id: 'u-1' } }, request: new Request('https://cf/api/pro/products') })
const bodyOf = async (res) => res.json()

reset()
let res = await onRequestGet(ctx(envOf()))
let body = await bodyOf(res)
check('3.1 购买开着 ⇒ 200 + purchaseEnabled:true', [res.status, body.purchaseEnabled], [200, true])
check('3.2 发布态四个正常道具', body.products.map((p) => p.productId).sort(), ['monthly_mem_android', 'monthly_mem_apple', 'yearly_mem_android', 'yearly_mem_apple'])
check('3.3 🔴 响应里不含 openid／user_id', ['openid', 'user_id', 'oA'].some((k) => JSON.stringify(body).includes(k)), false)

reset(); stub.identityRows = []
body = await bodyOf(await onRequestGet(ctx(envOf())))
check('3.4 纯 Web 账号（没绑微信）⇒ 正常档照给、测试档不给', body.products.map((p) => p.productId).sort(), ['monthly_mem_android', 'monthly_mem_apple', 'yearly_mem_android', 'yearly_mem_apple'])

reset()
body = await bodyOf(await onRequestGet(ctx(envOf({ PRO_PURCHASE_ENABLED: 'false' }))))
check('3.5 购买入口关着 ⇒ 空列表 + purchaseEnabled:false', [body.purchaseEnabled, body.products.length], [false, 0])
check('3.6 关着时一次数据库都不问（开关只读 env，不必查身份）', calls.length, 0)
// 3.6b–3.6d 新增的 `memberCaps`：购买页那句"开通之后三档各是多少"的**唯一**数字来源。
// 🔴 关着也要给（端上拿不到列表时至少不会画出一句编的），且它必须等于 CAPS.member 本身——
// 端上不许写死这些数（判据在 mp 侧 check:pro 13.3），所以这条链断了就是"购买页开始说谎"。
check('3.6b memberCaps 就是 CAPS.member 那一份（不是第二处常量）', body.memberCaps, catCaps.member)
check('3.6c 关态也给 memberCaps（列表是空的但数字仍然只有一个来源）', [body.products.length, !!body.memberCaps], [0, true])
reset()
body = await bodyOf(await onRequestGet(ctx(envOf())))
check('3.6d 开态同样给，且三项齐（缺一端上就整条不画）', [Object.keys(body.memberCaps).sort(), body.memberCaps.notes > body.memberCaps.balances], [['balances', 'cards', 'notes'], true])

reset()
body = await bodyOf(await onRequestGet(ctx(envOf({ PRO_TEST_OPENIDS: 'oA' }))))
check('3.7 内测态名单内 ⇒ 五个（含测试道具）', body.products.map((p) => p.productId).sort(), FIVE)

reset(); stub.identityStatus = 500
res = await onRequestGet(ctx(envOf({ PRO_TEST_OPENIDS: 'oA' })))
body = await bodyOf(res)
check('3.8 identity 读失败 ⇒ 200 + 空列表（收紧方向，不 5xx、不猜名单）', [res.status, body.products.length], [200, 0])

reset()
const sneaky = { env: envOf({ PRO_TEST_OPENIDS: 'oA' }), data: { user: { id: 'u-1' } }, request: new Request('https://cf/api/pro/products?PRO_TEST_OPENIDS=oZ&purchase=true') }
body = await bodyOf(await onRequestGet(sneaky))
check('3.9 请求里塞开关/白名单 ⇒ 无效（只认部署变量：名单 oA + 身份 oA ⇒ 五个照给）', body.products.map((p) => p.productId).sort(), FIVE)

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
// ✅ B3-2 就是这条"将来"：orders.js 自己调两道守卫，没有把"它出现在 products 列表里"当放行依据
//   ⇒ 这一格从"只 proCatalog 消费"变成"proCatalog + orders"是**预期中的消费者出现**，不是守卫被绕过。
// 路由目录化（Pages Functions 里 `orders.js` 与 `orders/index.js` 争同一路径）之后 `basename` 会
// 变成 `index.js`，看不出是哪条路由 ⇒ 显式取名：目录式路由记成 `<目录名>.js`，与扁平文件同名。
// 🔴 这样写还有一个好处：下一次谁再把路由搬回家，名字跟着变，判据不会"悄悄改绿"。
const routeName = (p) => {
  const relPath = path.relative(path.join(root, 'functions'), p).split(path.sep).join('/')
  return relPath.endsWith('/index.js') ? `${relPath.slice(0, -'/index.js'.length).split('/').pop()}.js` : path.basename(p)
}
const guardSites = jsFiles
  .filter((p) => /testAllowed|canBuyNormalTier/.test(read(p)))
  .map(routeName)
  .sort()
check('4.4 守卫函数的消费者＝proCatalog 自身 + 下单端点（列表不算判据）', guardSites, ['orders.js', 'proCatalog.js'])
// 4.5 端点不许把 openid 写进响应：proCoverage 导出的 getAccountOpenid 只允许被服务端模块用
// ⚠️ B3-3 起多出第四个消费者 `orders/[no].js`（确认态轮询按 openid 判归属）。这不是回归，
//   正是这格该有的用法——**新来一个读 openid 的地方，就得有人证明它不往外发 openid**：
//   那一格写好了，＝ `test:credit` 8.3（响应体里搜不到 openid／user_id／note）＋ 8.2（白名单字段不加不减）。
const openidSites = jsFiles.filter((p) => /getAccountOpenid/.test(read(p))).map(routeName).sort()
check('4.5 getAccountOpenid 的消费者清单（新增消费者要一起看 4.6 的"不下发 openid"）', openidSites, ['[no].js', 'orders.js', 'proCoverage.js', 'products.js'])

let fails = 0
for (const r of results) {
  if (!r.ok) fails++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        期望 ${JSON.stringify(r.want)}\n        现值 ${JSON.stringify(r.got)}`}`)
}
console.log(`\n共 ${results.length} 格，FAIL ${fails} 格`)
process.exit(fails === 0 ? 0 : 1)
