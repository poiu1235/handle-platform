// R7 spike（PRD 附录决策记录）：验证「服务端 generate_link + verify 换出真实
// Supabase 会话」在当前 Supabase 版本下的真实行为——这是 D3 wechat-login
// （openid 免登）的方案前提，行为不符则启用备选方案（R7）。
// 用法：node scripts/spike-gotrue-session.mjs <已注册且已确认邮箱的测试账号>
// 凭证读 .dev.vars（本地，已 gitignore）；输出只含状态码与字段存在性，
// token 一律截断展示，不打印任何 secret / token 明文。
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const email = process.argv[2]
if (!email) {
  console.error('用法：node scripts/spike-gotrue-session.mjs <测试账号邮箱>')
  process.exit(1)
}

const varsPath = join(__dirname, '..', '.dev.vars')
if (!existsSync(varsPath)) {
  console.error('未找到 .dev.vars（需含 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY）')
  process.exit(1)
}
const vars = Object.fromEntries(
  readFileSync(varsPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      const k = l.slice(0, i).trim()
      let v = l.slice(i + 1).trim()
      if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1)
      return [k, v]
    }),
)
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY } = vars
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
  console.error('.dev.vars 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY')
  process.exit(1)
}

const cut = (s) => (typeof s === 'string' && s.length > 10 ? `${s.slice(0, 8)}…(len ${s.length})` : s)
const errText = (d) => d?.msg || d?.error_description || d?.message || d?.error || d?.error_code || '(无错误字段)'

async function main() {
// ① service_role 生成 magiclink 一次性凭证（不出网到用户邮箱）
const glRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  },
  body: JSON.stringify({ type: 'magiclink', email }),
})
const gl = await glRes.json().catch(() => ({}))
const tokenHash = gl.properties?.token_hash ?? gl.hashed_token
console.log(`① generate_link → ${glRes.status}`)
console.log(`   字段存在性：action_link=${cut(gl.action_link)} token_hash=${cut(tokenHash)}`)
if (!glRes.ok || !tokenHash) {
  console.error(`   错误详情：${errText(gl)}`)
  console.error('   结论：generate_link 未产出可用 token_hash——openid 免登需走 R7 备选方案')
  return 1
}

// ② 以 anon 客户端身份调 verify 换会话（模拟「服务端替用户完成一次 magic link 登录」）。
// 新旧版本 GoTrue 的请求形态有差异，两种都试，哪种能用记哪种。
const attempts = [
  ['{ type, token: token_hash }', { type: 'magiclink', token: tokenHash }],
  ['{ type, token_hash }', { type: 'magiclink', token_hash: tokenHash }],
]
for (const [label, body] of attempts) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  const ok = res.ok && data.access_token && data.refresh_token
  console.log(
    `② verify（${label}）→ ${res.status}${ok ? ' ✅ 返回真实会话' : ` error=${cut(errText(data))}`}`,
  )
  if (ok) {
    console.log(`   access_token=${cut(data.access_token)} refresh_token=${cut(data.refresh_token)} user=${data.user?.id}`)
    console.log('✅ 结论：generate_link + verify 可行，wechat-login 按 PRD D3 3.3.4 实现')
    return 0
  }
}
console.error('❌ 结论：两种 verify 形态都未换出会话——把上方状态码/错误记入 R7，openid 免登方案需调整')
return 1
}

process.exitCode = await main()
