// GET /api/pro/products —— 在售列表（PRD v3 3.1／8.2 #11／§十一·丙 D-10）。
//
// 它是**展示面**，不是判据：下单端点必须自己再查一次 `proCatalog` 与两道守卫，
// 不许因为"这个 productId 出现在列表里"就放行（列表可被缓存、守卫不可）。
//
// 🔴 两条守卫都在这里落地，方向相反、别互相替代：
//   · 测试档（`pro_test_day`）——**恒需 openid 在白名单内**；名单为空＝对任何人都不可见（fail-closed）。
//     少了这条，"几分钱买一年"就是公开入口（§十一·丙 明写这条不能省）。
//   · 正常档——白名单**非空**＝内测形态，正常档也只对名单内可见（8.3 那句"正常两档不在对外列表"）；
//     名单为空＝发布形态，全量可见。
//
// ⚠️ 响应体**不含 openid**（4.6）：守卫用的是服务端自己查出来的那一条，端上没有需要它的场景。
import { json } from '../../_lib/supabase.js'
import { readProFlags, getAccountOpenid } from '../../_lib/proCoverage.js'
import { sellableProducts } from '../../_lib/proCatalog.js'

export async function onRequestGet(context) {
  const { env, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401)

  const flags = readProFlags(env)
  // 购买入口关着 ⇒ 列表就是空的（端上此时也不该画入口；两侧各判一次是刻意的双保险，
  // 不一致的方向永远是"更严的那侧赢"，见 8.3 第 2 条）
  if (!flags.purchase) return json({ purchaseEnabled: false, products: [] })

  let openid = null
  try {
    openid = await getAccountOpenid(env, userId)
  } catch (err) {
    // 读不到 identity ⇒ 按"谁都不给"处理。这里 fail-closed 的方向是**收紧**，
    // 与展示路径（session 那条按免费档）相反：多给一个可买的档位比少给一个更贵。
    console.error('[pro/products] openid lookup failed:', (err && err.code) || (err && err.message) || 'unknown')
    return json({ purchaseEnabled: true, products: [] })
  }

  return json({ purchaseEnabled: true, products: sellableProducts(env, openid) })
}
