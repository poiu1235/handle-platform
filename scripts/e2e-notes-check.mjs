// 便利贴数据层端到端检查（2026-09-12）——service role 直连 Supabase PostgREST，
// 验证 supabase/notes.sql 的部署结果与三枚触发器，并用与 functions/api/notes.js
// 完全相同的 or= 清理过滤串做一次真实删除（评审 #1 服务端通道的语法实测）。
// ⚠ 走 service role（绕过 RLS），所有操作都带 MARK 前缀显式过滤 + 结束清理。
// 运行：node scripts/e2e-notes-check.mjs
//
// 前置：supabase/notes.sql 已在 SQL Editor 执行（未建表时本脚本会直接提示）。

import { readFileSync } from 'node:fs'

function parseDevVars() {
  const vars = {}
  for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !line.trim().startsWith('#')) vars[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return vars
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = parseDevVars()
const DAY_MS = 86400000
const nowMs = Date.now()
const utcToday = new Date(nowMs).toISOString().slice(0, 10)
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
const MARK = `NT-E2E-${nowMs}`

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`✓ ${name}`)
  else {
    failed += 1
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function req(method, path, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

// ── 0. 表是否存在 ──
const probe = await req('GET', 'notes?select=id&limit=1')
if (probe.status !== 200) {
  console.log(`✗ notes 表不可用（HTTP ${probe.status} ${probe.json?.code ?? ''}）`)
  console.log('  请先在 Supabase SQL Editor 整体执行 supabase/notes.sql，再重跑本脚本。')
  process.exit(1)
}
console.log('✓ notes 表已就绪')

const adminHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

// ── 0.2 残留自愈：此前中断的运行会留下夹具行与测试用户，先清干净再开跑 ──
const healed = await req('DELETE', 'notes?content=like.NT-E2E-*')
console.log(`✓ 残留自愈：清理历史夹具行 ${(healed.json ?? []).length} 条`)
for (let page = 1; page <= 5; page++) {
  const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=50`, {
    headers: adminHeaders,
  }).then((r) => r.json())
  for (const u of list?.users ?? []) {
    if ((u.email || '').startsWith('e2e-notes-')) {
      await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, { method: 'DELETE', headers: adminHeaders })
    }
  }
  if ((list?.users ?? []).length < 50) break
}

// ── 0.5 一次性测试用户（notes.user_id NOT NULL；service role 绕 RLS 但绕不过
//        非空约束——照 e2e-import 的 admin 建户模式，结束删除级联清数据）──
const email = `e2e-notes-${nowMs}@example.com`
const created = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ email, password: `E2e!${nowMs.toString(36)}Aa1!`, email_confirm: true }),
}).then((r) => r.json())
const userId = created?.id
check('admin 创建一次性测试用户', !!userId, JSON.stringify(created).slice(0, 160))
if (!userId) process.exit(1)

// ── 1. 造数据：2 条新鲜（应存活）+ 3 条僵尸（应被清理过滤串收走）──
// ⚠ PostgREST 批量插入要求所有对象键一致（PGRST102），空值显式补 null
const iso = (ms) => new Date(ms).toISOString()
const seed = [
  { user_id: userId, kind: 'idea', content: `${MARK}-idea`, due_date: null, finished_at: null, created_at: iso(nowMs) },
  { user_id: userId, kind: 'memo', content: `${MARK}-fresh-dated`, due_date: addDays(utcToday, 7), finished_at: null, created_at: iso(nowMs) },
  { user_id: userId, kind: 'memo', content: `${MARK}-fresh-nodate`, due_date: null, finished_at: null, created_at: iso(nowMs) },
  { user_id: userId, kind: 'memo', content: `${MARK}-stale-manual`, due_date: null, finished_at: iso(nowMs - 40 * DAY_MS), created_at: iso(nowMs - 41 * DAY_MS) },
  { user_id: userId, kind: 'memo', content: `${MARK}-stale-dated`, due_date: addDays(utcToday, -60), finished_at: null, created_at: iso(nowMs - 61 * DAY_MS) },
  { user_id: userId, kind: 'memo', content: `${MARK}-stale-nodate`, due_date: null, finished_at: null, created_at: iso(nowMs - 50 * DAY_MS) },
]
const seeded = await req('POST', 'notes', seed)
const seededRows = Array.isArray(seeded.json) ? seeded.json : []
check('批量插入 6 条夹具', seeded.status === 201 && seededRows.length === 6, JSON.stringify(seeded.json))
if (seededRows.length === 0) {
  console.log('插入全败，中止（无残留可清）。')
  process.exit(1)
}
const byContent = Object.fromEntries(seededRows.map((r) => [r.content, r]))

// ── 2. 触发器与 CHECK（绕过 CF 的直写兜底）──
const ideaId = byContent[`${MARK}-idea`]?.id
const freshId = byContent[`${MARK}-fresh-dated`]?.id

const kindLock = await req('PATCH', `notes?id=eq.${ideaId}`, { kind: 'memo' })
check('notes_kind_lock：灵感/备忘禁止互转', kindLock.status === 400, JSON.stringify(kindLock.json))

await req('PATCH', `notes?id=eq.${freshId}`, { finished_at: iso(nowMs) })
const finishClear = await req('PATCH', `notes?id=eq.${freshId}`, { finished_at: null })
check('notes_finish_lock：已完成不可恢复', finishClear.status === 400, JSON.stringify(finishClear.json))
const finishEdit = await req('PATCH', `notes?id=eq.${freshId}`, { content: `${MARK}-edited` })
check('notes_finish_lock：已完成条目冻结（只可删除）', finishEdit.status === 400, JSON.stringify(finishEdit.json))

const ideaWithDate = await req('POST', 'notes', { user_id: userId, kind: 'idea', content: `${MARK}-bad`, due_date: addDays(utcToday, 1) })
check('notes_idea_plain：灵感不可带日期', ideaWithDate.status === 400, JSON.stringify(ideaWithDate.json))

const tooLong = await req('POST', 'notes', { user_id: userId, kind: 'memo', content: '字'.repeat(501) })
check('CHECK：content 501 字拒绝', tooLong.status === 400, JSON.stringify(tooLong.json))

const before = byContent[`${MARK}-fresh-nodate`]
const touched = await req('PATCH', `notes?id=eq.${before.id}`, { content: `${MARK}-fresh-nodate-touched` })
check('moddatetime：updated_at 自动维护', touched.status === 200 && touched.json?.[0]?.updated_at > before.updated_at, JSON.stringify(touched.json?.[0]?.updated_at))

// ── 3. 清理过滤串实测（与 functions/api/notes.js sweepCleared 逐字一致；
//        ⚠ ?or= 的值是逻辑树本体，不带 or= 前缀）──
const clearTree =
  `(finished_at.lt.${iso(nowMs - 30 * DAY_MS)},` +
  `and(finished_at.is.null,due_date.lt.${addDays(utcToday, -38)}),` +
  `and(finished_at.is.null,due_date.is.null,created_at.lt.${addDays(utcToday, -45)}))`
const swept = await req('DELETE', `notes?or=${encodeURIComponent(clearTree)}`)
const sweptIds = new Set((swept.json ?? []).map((r) => r.id))
check(
  '服务端清理通道：3 条僵尸行收走、3 条新鲜行保留',
  swept.status === 200 &&
    sweptIds.size === 3 &&
    ['stale-manual', 'stale-dated', 'stale-nodate'].every((k) => sweptIds.has(byContent[`${MARK}-${k}`]?.id)) &&
    ['idea', 'fresh-dated', 'fresh-nodate'].every((k) => !sweptIds.has(byContent[`${MARK}-${k}`]?.id)),
  JSON.stringify(swept.json),
)

// ── 4. 幂等 + 结束清理（删用户级联清 notes；content 兜底清理防级联失效）──
const sweptAgain = await req('DELETE', `notes?or=${encodeURIComponent(clearTree)}`)
check('清理幂等：重复执行 0 行', sweptAgain.status === 200 && (sweptAgain.json ?? []).length === 0, JSON.stringify(sweptAgain.json))

const leftover = await req('GET', `notes?select=id&content=like.${MARK}*`)
if ((leftover.json ?? []).length > 0) {
  await req('DELETE', `notes?id=in.(${leftover.json.map((r) => r.id).join(',')})`)
}
const userGone = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
  method: 'DELETE',
  headers: adminHeaders,
})
check('结束清理：测试用户已删除（notes 级联）', userGone.status === 200 || userGone.status === 204, `HTTP ${userGone.status}`)
const remaining = await req('GET', 'notes?select=id&content=like.NT-E2E-*')
check('结束校验：库中无 NT-E2E 残留行', (remaining.json ?? []).length === 0, `剩 ${remaining.json?.length ?? 0} 条`)

console.log(failed === 0 ? '\n数据层全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
