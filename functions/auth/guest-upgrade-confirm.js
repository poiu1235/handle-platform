import { json } from '../_lib/supabase.js'
import { verifyUserBearer, serviceRoleFetch } from '../_lib/userAuth.js'
import { verifyUpgradeTicket } from '../_lib/upgradeTicket.js'
import { rateGuard } from '../_lib/authGate.js'

// D5 5.2-③：合并确认。Bearer = 目标邮箱会话（5.3 不对称原则：接收数据的一方
// 必须刚完成密码验证或邮箱 OTP——「把数据给出去」的访客侧凭 ticket 弱证明即可），
// body = { ticket }。目标 token 不走请求体，避免进日志/中间层缓存。
//
// 账号强校验（存在 / 邮箱已确认 / 非访客 / 非自我合并 / B3 already_bound /
// 访客行锁串行化）全部下放在 merge_guest RPC 的 3.0 段——数据库侧最后防线，
// 端点不重复实现第二套判定（单一事实源）。
const RPC_ERRORS = {
  not_guest: { status: 410, code: 'guest_gone', msg: '微信数据已被合并或清理，请重新打开小程序后再试' },
  bad_target: { status: 400, code: 'bad_target', msg: '目标账号状态异常，请重新登录后再操作' },
  already_bound: {
    status: 409,
    code: 'already_bound',
    msg: '该邮箱已绑定另一个微信号，请使用原微信号免登，或在原账号的绑定管理里先解绑',
  },
  deletion_pending: { status: 409, code: 'deletion_pending', msg: '账号正在注销或清理流程中，暂不可操作' },
  no_identity: { status: 409, code: 'merge_conflict', msg: '合并发生了并发冲突，请重新打开小程序后再试' },
}

export async function onRequestPost(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const target = await verifyUserBearer(request, env)
  if (!target) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown'
  if (rateGuard(`upgrade-confirm:${ip}`)) return json({ error: '尝试过于频繁，请稍后再试' }, 429)

  const { ticket } = await request.json().catch(() => ({}))
  if (!ticket) {
    return json({ error: '绑定流程已失效，请重新发起', code: 'ticket_missing' }, 400)
  }
  let payload
  try {
    payload = await verifyUpgradeTicket(env, ticket)
  } catch {
    // 签名不对 / 过期 / purpose 不符——都只说明「这张票不可用」，不区分原因
    return json({ error: '绑定流程已失效，请重新发起', code: 'ticket_invalid' }, 401)
  }
  if (payload.sub === target.userId) {
    return json({ error: '不能合并到自己', code: 'bad_target' }, 400)
  }

  const rpc = await serviceRoleFetch(env, '/rest/v1/rpc/merge_guest', {
    method: 'POST',
    body: { p_guest: payload.sub, p_target: target.userId, p_provider: payload.provider || 'wechat_mp' },
  })
  if (!rpc.ok) {
    // plpgsql raise exception（P0001）的 message 即我们约定的错误词
    const mapped = RPC_ERRORS[rpc.data?.message]
    if (mapped) return json({ error: mapped.msg, code: mapped.code }, mapped.status)
    console.error('[guest-upgrade-confirm] rpc failed:', JSON.stringify(rpc.data))
    return json({ error: '合并失败，请稍后重试' }, 502)
  }

  // 客户端拿到 ok 后把自己手里（未落 store 的）目标会话 applySession 覆盖；
  // 服务端不回传任何会话——目标会话从头到尾只存在于客户端本地
  return json({
    ok: true,
    mergedRows: rpc.data?.movedRows ?? null,
    overwritten: Array.isArray(rpc.data?.overwritten) ? rpc.data.overwritten.length : 0,
  })
}
