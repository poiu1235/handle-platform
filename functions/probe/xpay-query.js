// 🔴🔴 **一次性诊断路由，跑完就删**（PRD v3 R-9 ⑱；先例＝B1 那回为 R-9 ⑯ 加的取证日志，
// 结案即连同日志一起删掉——诊断件留在树上就是攻击面）。
//
// 它只回答一个问题：**个人主体的小程序，到底能不能调 `/xpay/query_order`？**
// 文档那一族的产品介绍把可用主体写成「企业、个体户」，而接口页自己写着
// 「本接口暂未明确可调用账号类型……请以实际调用情况为准」⇒ 只能真调一次才知道。
//
// 为什么值得花这一次调用：4.5 入账第 1 条把"发货"押在查单结果上（推送只是触发器）。
// 如果这个接口对我们根本不可用，那条规则就没有实现路径，要回来重判入账依据——
// 这件事比字段形状大得多，不该等到 B3-3 写到一半才发现。
//
// 判读：见下面 `MEANINGS` 那张表（2026-10-04 现网跑过第一次之后补的：当时回 `268490001 openid错误`，
// 我原先的注释里没有这一支，很容易把"签名与凭证都过了"这条重要信息读成"失败了"）。
// 🔴 回包请整包贴回对话（含 `rid`），别只说"失败了"——错误码出自哪一层，决定了下一步是改签名、
//   改配置还是重判 4.5。
//
// 守卫：只有一个——`?key=` 必须等于 secret `PROBE_TOKEN`。没配这个 secret ⇒ 本路由直接 503，
// 也就是"默认关着"（fail-closed，与 `wxTicket.js` 那条"配置缺失只能是拒绝"同一族）。
// 🔴 它不在 `/api/**` 下，所以不受 Bearer 中间件影响；也正因如此，**它自己就是唯一防线**，
// 用完必须删文件重新部署，不许"先留着以后方便"。
import { json } from '../_lib/supabase.js'
import { xpayQueryOrder } from '../_lib/proXpay.js'

// 与真单号**同形**（`T` + 13 位数字 + 8 位 hex ＝ 22 位，见 `proPaySign.makeOutTradeNo`），
// 但那个毫秒时刻是 2023-11-14、随机段全 f ⇒ 不可能是我们发出去过的单。
// 为什么要同形：只有"格式合法的单号查不到"才等于"查无此单"那一档；随手写个 `PROBE-XXX`
// 会先撞 `268490002 请求参数字段错误`，于是这一趟探针什么也没判出来（还看起来像判到了）。
const FAKE_ORDER_ID = 'T1700000000000ffffffff'

// 判读表（2026-10-04 现网第一次跑之后加的——那一趟回的是 `268490001 openid错误`，
// 而我原来的注释里没有这一支，差点把"签名与凭证都过了"这条重要信息读丢）。
// 🔴 关键是分清**错误出自哪一层**：网关层（token／权限）→ 签名层 → 业务参数层 → 业务规则层。
//   越往里走，证明的东西越多：能报"openid 错"就说明前两关都过了。
const MEANINGS = {
  0: '接口可用，签名与凭证都对（order 为 null 也属正常：假单号查不到东西）',
  268490001: '🟢 **签名与 access_token 都已通过**，错在最外层的业务参数（openid）⇒ 接口对我们这个 appid 有路由；但"个人主体是否被允许"仍未判死（openid 校验可能在权限校验之前）⇒ 用**真 openid** 再打一次',
  268490002: '🟢 同上（参数字段错）⇒ 签名/凭证已过，是字段名或取值不对：把 sent 贴回来对文档',
  268490003: '🔴 签名错 ⇒ 算法或 uri 形状不对（sent 就是我们签出去的那个串，逐字对一下）',
  268490015: '频率限制 ⇒ 别连打，隔一会儿再试',
  48001: '🔴 api unauthorized ⇒ 个人主体调不了这个接口，回来重判 4.5 的入账依据',
  48002: '🔴 同上（接口权限类）',
  40001: 'access_token 无效（token_ 前缀那一支）⇒ 检查刚取到的 token 是否被别的调用顶掉了',
  42001: 'access_token 过期 ⇒ 重新取一次',
}
function meaningOf(errcode) {
  if (MEANINGS[errcode]) return MEANINGS[errcode]
  if (typeof errcode === 'string' && errcode.startsWith('token_')) {
    return '🔴 没打到接口：access_token 那一步就失败了（40164＝去后台加 CF 出口 IP 白名单；40013/40125＝WX_APPID/WX_SECRET 配错）——这一支**不能**读成"接口没权限"'
  }
  return '未列出的错误码 ⇒ 原样贴回 errmsg（含 rid）由人判，别猜'
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function onRequestGet(context) {
  const { request, env } = context
  const expected = env.PROBE_TOKEN
  if (!expected) return json({ error: '探针未启用（缺 PROBE_TOKEN secret）', code: 'probe_disabled' }, 503)

  const key = new URL(request.url).searchParams.get('key') || ''
  if (!timingSafeEqual(String(expected), key)) return json({ error: '探针口令不对', code: 'probe_unauthorized' }, 403)

  const params = new URL(request.url).searchParams
  const orderId = params.get('order_id') || FAKE_ORDER_ID
  const envFlag = params.get('env') === '1' ? 1 : 0
  let openid = params.get('openid') || ''
  if (!openid) {
    // query_order 的 body 里 openid 是必填（文档标"是"）⇒ 没给就用库里第一条 wechat_mp identity，
    // 只为把接口打出去；它不影响"能不能调"这个判据（权限判定看的是 appid，不是这个 openid）。
    // 这支假 openid 与真号同为 28 字符，理由与上面假单号一样：别让格式错冒充权限错。
    openid = 'oPROBE0000000000000000000000'
  }

  const r = await xpayQueryOrder({ env, openid, orderId, envFlag })
  const order = r.data && r.data.order ? r.data.order : null
  console.error(
    '[probe/xpay] query_order',
    JSON.stringify({
      errcode: r.errcode,
      errmsg: r.errmsg,
      status: r.status,
      sent: r.sent,
      orderKeys: order ? Object.keys(order) : null,
      orderStatus: order ? order.status : null,
    })
  )
  // 🔴 回包只给判据要的东西：不返回 access_token、不返回我们配的 appid/secret，
  //   `sent` 是我们自己发出去的串（含假单号），回显它是为了排"签名错"，不含凭证。
  return json({
    verdict: r.errcode === 0 ? 'callable' : 'see errcode',
    errcode: r.errcode,
    errmsg: r.errmsg,
    httpStatus: r.status,
    meaning: meaningOf(r.errcode),
    sent: r.sent,
    orderKeys: order ? Object.keys(order) : null,
    orderSample: order,
  })
}
