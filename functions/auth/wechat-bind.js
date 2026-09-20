import { json } from '../_lib/supabase.js'
import { code2session } from '../_lib/wxTicket.js'
import { verifyUserBearer, serviceRoleFetch } from '../_lib/userAuth.js'
import { isGuestUser } from '../_lib/guestUser.js'

// 微信身份绑定（PRD D3 3.3.4）：用户已邮箱登录后由客户端静默触发。
// 门禁 = 有效 Bearer 会话 + 一次性 wx.login code，二者缺一不可；
// openid 不作为网络凭证传输，code2session 与映射读写都在服务端。
export async function onRequestPost(context) {
  const { request, env } = context
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: '服务端未配置 SUPABASE_SERVICE_ROLE_KEY' }, 500)

  const user = await verifyUserBearer(request, env)
  if (!user) return json({ error: '登录状态无效或已过期，请重新登录' }, 401)

  const { code } = await request.json().catch(() => ({}))
  const wx = await code2session(code, env)
  if (!wx.ok) {
    return json({ error: `微信身份校验失败（errcode: ${wx.errcode}）`, code: 'wx_ticket_invalid' }, 400)
  }
  const { openid, unionid } = wx

  const table = '/rest/v1/user_identities'
  const base = `${table}?select=user_id,openid&provider=eq.wechat_mp`

  // 冲突 1（R8）：这个 openid 已绑在别的账号上——不能抢，V1 不做解绑 UI，
  // 服务端删行即解绑（运维接口，不在本端点提供）
  const byOpenid = await serviceRoleFetch(env, `${base}&openid=eq.${encodeURIComponent(openid)}`)
  const openidRow = byOpenid.data?.[0]
  if (openidRow && openidRow.user_id !== user.userId) {
    // D5 5.5 防御分支：映射指向访客（这个微信的门还开在自己空账号上）——
    // 独立结构化码，客户端维持「失败不打扰」纪律不弹错，绑定管理页据此显示
    // 「微信未绑定」并引导去走绑定流程（v1.5 评审 #7）
    const owner = await serviceRoleFetch(env, `/auth/v1/admin/users/${encodeURIComponent(openidRow.user_id)}`)
    if (isGuestUser(owner.data)) {
      return json({ error: '该微信当前为访客身份', code: 'openid_taken_guest' }, 409)
    }
    return json({ error: '该微信已绑定其他账号', code: 'openid_taken' }, 409)
  }

  // 冲突 2（R8）：当前账号已绑过其他 openid——按拍板口径返回结构化错误码，不自动换绑
  const byUser = await serviceRoleFetch(env, `${base}&user_id=eq.${encodeURIComponent(user.userId)}`)
  const userRow = byUser.data?.[0]
  if (userRow) {
    // 同一身份重复绑定 = 幂等成功（下次登录重试触发的正常路径）
    if (userRow.openid === openid) return json({ bound: true })
    return json({ error: '当前账号已绑定其他微信，如需换绑请联系服务端处理', code: 'already_bound' }, 409)
  }

  // 2.3：注销/清理置位期内的账号不接受新门钥匙（撤位只走 login / wechat-login
  // 两条「本人回归」通道，静默 bind 谁都不代表）
  const pdel = await serviceRoleFetch(
    env,
    `/rest/v1/pending_deletions?user_id=eq.${encodeURIComponent(user.userId)}&select=reason`,
  )
  if (pdel.data?.length) {
    return json({ error: '账号正在注销或清理流程中，暂不可操作', code: 'deletion_pending' }, 409)
  }

  const ins = await serviceRoleFetch(env, table, {
    method: 'POST',
    body: { user_id: user.userId, provider: 'wechat_mp', openid, unionid },
  })
  if (!ins.ok) {
    // 两个 select 与 insert 之间存在并发窗口，撞唯一约束按「已被并发绑定」处理：
    // 提示重试后走幂等/冲突分支，不泄露更多状态
    console.error('[wechat-bind] insert failed:', JSON.stringify(ins.data))
    return json({ error: '绑定失败，请稍后重试' }, 500)
  }
  return json({ bound: true })
}
