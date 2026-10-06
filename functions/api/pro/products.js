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
//
// 🔴 `emptyReason`（E-24 判丙 的落地，2026-10-06）：端上要在"空列表"那一屏给一句说法，
//   而**它自己判不出是哪一种空**——四种原因只有服务端知道。与 E-33 的 `refundDeny` 同一条形状：
//   🟩 **只回码，句子留在端上**（名单内容、openid 都不外发）。
//   · `purchaseClosed` 入口关着（8.3 第 2 条：两侧各判一次，更严的一侧赢）
//   · `noWechatBinding` 这个账号当前没绑微信 ⇒ 用户的动作是去绑定，不是"等开放"
//   · `readFailed` identity 读失败（fail-closed 收紧成"谁都不给"）⇒ 动作是稍后再试
//   · `notOpenToYou` 内测形态（名单非空）且你不在这份名单里 ⇒ 唯一可以说"内测只对名单内开放"的一种
//   · null 有档位，或判不出原因 ⇒ 端上退回通用那一句，🔴 不许猜成"未对你开放"
import { json } from '../../_lib/supabase.js'
import { readProFlags, getAccountOpenid, memberCapsForWire } from '../../_lib/proCoverage.js'
import { sellableView } from '../../_lib/proCatalog.js'

export async function onRequestGet(context) {
  const { env, data } = context
  const userId = data && data.user ? data.user.id : null
  if (!userId) return json({ error: '未登录' }, 401)

  const flags = readProFlags(env)
  // 购买入口关着 ⇒ 列表就是空的（端上此时也不该画入口；两侧各判一次是刻意的双保险，
  // 不一致的方向永远是"更严的那侧赢"，见 8.3 第 2 条）
  //
  // 🔴 `memberCaps` 是**购买页要说的话**（"开通之后三档各是多少"），不是这个人的当前上限：
  //   会话那份 `caps` 按人算（免费档就是 200/50/50，墙关着时干脆是 null），拿它写这句就会
  //   在关态/免费态下印出一句错话。数字正本仍然只有 `proCoverage.CAPS` 这一处（3.3 门槛②／
  //   验收 #43）⇒ 端上不许出现 500/100 这种字面量，静态门 13.3 在扫这件事。
  if (!flags.purchase) return json({ purchaseEnabled: false, products: [], memberCaps: memberCapsForWire(), emptyReason: 'purchaseClosed' })

  let openid = null
  try {
    openid = await getAccountOpenid(env, userId)
  } catch (err) {
    // 读不到 identity ⇒ 按"谁都不给"处理。这里 fail-closed 的方向是**收紧**，
    // 与展示路径（session 那条按免费档）相反：多给一个可买的档位比少给一个更贵。
    console.error('[pro/products] openid lookup failed:', (err && err.code) || (err && err.message) || 'unknown')
    return json({ purchaseEnabled: true, products: [], memberCaps: memberCapsForWire(), emptyReason: 'readFailed' })
  }
  // ⚠️ 没绑微信**不等于**没有档位：发布态下正常档照给（3.4 的既有形状，下单侧才由前置①/② 拒）。
  //   🔴 所以这里不提前 return——提前返回会把"照给"变成"空列表"，那是一次没人要的行为改动
  //   （`test:catalog` 3.4/3.15 正是盯着这一处的两格）。原因位由 `sellableView` 一并给出。
  const { products, emptyReason: blocked } = sellableView(env, openid)
  return json({ purchaseEnabled: true, products, memberCaps: memberCapsForWire(), emptyReason: blocked })
}
