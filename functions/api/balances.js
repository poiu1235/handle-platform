import { json } from '../_lib/supabase.js'

// 转发的是用户自己的 access token（在 _middleware.js 里已验签、排除过 recovery），
// 不是 service_role——balances 表原有的 RLS（user_id 归属校验）继续生效，
// Cloudflare 这层只加"没登录/恢复态直接拒绝"的前置闸门。

function restHeaders(env, accessToken, extra = {}) {
  return {
    'Content-Type': 'application/json',
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    ...extra,
  }
}

export async function onRequestGet(context) {
  const { env, data } = context

  // 一次返回全量（含 amount=0）——0 余额筛选改为纯前端本地过滤（2026-09-02：
  // 对齐会员模式，进站即全量快照，开关不再触发第二次请求）；旧的 includeZero
  // 查询参数随之废弃（传了也忽略）
  const query = 'select=id,app_name,amount,updated_at,icon_key&order=updated_at.desc'

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?${query}`, {
    headers: restHeaders(env, data.accessToken),
  })
  const body = await res.json().catch(() => [])
  return json(body, res.status)
}

// 新增单条：跟前端 modal 上"重名会直接覆盖"的提示保持一致，用 on_conflict 做 upsert，
// 而不是单纯 insert——同名覆盖旧记录，不同名新增一条
export async function onRequestPost(context) {
  const { env, data, request } = context
  const payload = await request.json().catch(() => ({}))

  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/balances?on_conflict=user_id,app_name`, {
    method: 'POST',
    headers: restHeaders(env, data.accessToken, {
      Prefer: 'resolution=merge-duplicates,return=representation',
    }),
    // user_id 由服务端从校验过的 token 里取，不信任前端传来的任何 user_id 字段
    body: JSON.stringify({
      app_name: payload.app_name,
      amount: payload.amount,
      updated_at: payload.updated_at,
      // 可选字段：前端没选图标时传 null/undefined，统一落成 null（= 未配置）
      icon_key: payload.icon_key || null,
      user_id: data.user.id,
    }),
  })
  const body = await res.json().catch(() => ({}))
  return json(body, res.status)
}