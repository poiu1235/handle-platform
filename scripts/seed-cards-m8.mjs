// S2-M8 会员卡 AI 切片的验收 fixture（2026-09-27，PRD doc/miniprogram-ai-s2-card-prd.md 的 6.5 / V95）
//
// 为什么必须有这份东西：小程序尚未上线、没有真实用户，库里 cards 的每一行都是自测数据
// （PRD 1.3.5）。⇒ 读侧所有真机判据（V65/V66/V67/V68/V82/V85/V92）的数据来源只有这里。
// `CQ15` 已拍"fixture 集算验收前置" ⇒ 这张表不齐就不许进批次 A。
//
// 每行后面那句 `V××` 是它存在的唯一理由，删一行就有一格判据失去数据源。
//
// ── 与 seed-notes-demo.mjs 的三条刻意不同（不是随手写的，每条都有理由）────────────
// 1. **SEED_USER_ID 必填、没有自动兜底**。便利贴那份会在没传时挑"最近登录的非测试账号"，
//    而会员侧这些卡名要被评测夹具逐字引用（doc/miniprogram-ai-s2-eval-cases-card.json），
//    落错账号 = 夹具与数据不同源，且会污染产品自用那份真实手感的数据。
// 2. **写入走 upsert（on_conflict=user_id,name），所以重复运行幂等**，不需要 --reset。
//    便利贴那份是纯 INSERT，重复跑会长第二份；卡有唯一键，正好用同一个键合并。
//    ⚠ 载荷每行都带齐全部业务列 ⇒ merge-duplicates 只 SET 携带列，等价于整行覆盖，
//      第二次运行会把第一次改出来的状态（比如被结算推进过的日期）**拉回原值**——
//      这正是 V65 要能反复跑的 prerequisite。
// 3. **--purge 按卡名删，不按 user_id 删**。演示账号上可能还留着产品自己手工记的卡，
//    删整账号会连那些一起清掉（同名覆盖是全局约定，卡名即唯一键，见 cards-db.md 第 10 节）。
//
// ── 一行造不出来的东西（结构性，不是偷懒）──────────────────────────────────
// PRD 6.5 原表第 7 行要求一张 `renewIncomplete` 的残缺续费卡（auto_renew=true 但缺扣款日
// 或缺两个周期表示）。它**在任何路径下都插不进去**：`supabase/cards.sql:155-160` 的
// `cards_renew_complete` 是**裸建表体内联**的 CHECK（`create table public.cards`，:108，
// 无 if-not-exists、无后置 ADD CONSTRAINT），CHECK 连 service_role 都不绕。
// ⇒ 那一支改由**离线独占**验证（scripts/skill-checks/card-query.cjs 直接喂行对象给派生函数），
//   真机记档不排——理由不是"现网无消费者"，而是"库里不可能有"。这两句话不同，见 PRD 1.3.5 第 2 条。
//
// 运行（两种写法都行；PowerShell 不认 `VAR=x node …` 那种前缀语法，所以 --user 是首选）：
//   node scripts/seed-cards-m8.mjs --user=<演示账号 uuid>
//   PowerShell:  $env:SEED_USER_ID='<uuid>'; node scripts/seed-cards-m8.mjs
//   bash / Git-Bash:  SEED_USER_ID=<uuid> node scripts/seed-cards-m8.mjs
// 其它：--dry（只跑本地 CHECK 模拟）· --probe（**只读**：数一下该账号现有行数）· --purge（按卡名删）
//   ⚠ 与便利贴同一纪律：--purge 需要产品文字确认后再跑，且**别把 service key 打进日志**。
//
// 网络前提（2026-09-27 实测过一次的坑）：本脚本要直连 `*.supabase.co`。这台机器当时到该域名
// **TLS 被重置**（node: fetch failed / ECONNRESET；curl: (35) Connection was reset），而
// `api.github.com` 与 `pack.handle.host` 都通 ⇒ 不是 key、不是 SQL、不是脚本的问题。
// 三条出路，按优先级：
//   ① **走 Dashboard**：`supabase/cards-m8-fixture.sql` 整体执行（与本草作行定义一致，改一处改两处）；
//   ② 有本地代理时：`$env:HTTPS_PROXY='http://127.0.0.1:<port>'; node --use-env-proxy scripts/seed-cards-m8.mjs --user=…`
//      （Node 24 才有 `--use-env-proxy`；不设 env 时 fetch 完全不看代理）；
//   ③ 换一台能直连的机器跑。**不要**为此在 CF 层开一个"代跑 seed"的端点——那等于为工具需求放宽生产面。

import { readFileSync } from 'node:fs'

const DAY = 86400000

// 本地日历日（与端上 cardsDomain.todayISO() 同判据；不用 toISOString().slice(0,10)，
// 那个是 UTC 日，UTC+8 的晚上会差一天——三套"今天"时钟的坑，cards-db.md 9.2）
function localToday() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}
// created_at 用本地正午，避免"记于今天"在跨午夜时漂一天（便利贴 seed 同一处理）
function noonISO(daysAgo) {
  const n = new Date()
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12, 0).toISOString()
}

const today = localToday()

// C(name, patch) 给全默认值：非续费、无次数、不静默、未指定图标
const C = (name, patch = {}) => ({
  name,
  start_date: addDays(today, -30),
  end_date: addDays(today, 60),
  total_sessions: null,
  remaining_sessions: null,
  auto_renew: false,
  billing_cycle: null,
  period_days: null,
  next_billing_date: null,
  muted: 'none',
  icon_key: null,
  created_at: noonISO(30),
  ...patch,
})

const rows = [
  // 6.5 #1 · 最普通的"7 天内到期"命中行
  C('腾讯视频', { start_date: addDays(today, -300), end_date: addDays(today, 5), created_at: noonISO(300) }),

  // 6.5 #2 · 边界：到期日 = 今天（端上判据是 today > end_date 才算过期 ⇒ 今天仍可用）
  C('Keep健身', { start_date: addDays(today, -29), end_date: today, created_at: noonISO(29) }),

  // 6.5 #3 · 在 15 天端上提醒窗口内、但落在本切片 7 天窗口外 ⇒ 钉 V67「不收窄 vs 收窄」的差异格
  C('哔哩哔哩大会员', { end_date: addDays(today, 12) }),

  // 6.5 #4 · 已过期 ⇒ 钉 V82（includeExpired 那一轮那个开关必须亮着）+ CD5 情形 C
  C('中石化加油卡', { start_date: addDays(today, -93), end_date: addDays(today, -3), created_at: noonISO(93) }),

  // 6.5 #5 · 🔴 续费中且**扣款日 = 今天** ⇒ V65 的主判据（v3.3 边界 <= ⇒ 一次读取即推进一周期）
  //    end_date 与扣款日同值 = 用户裁定 2026-09-02 的「DDL ≡ 扣款日」现状形态
  C('京东PLUS会员', {
    start_date: addDays(today, -27),
    end_date: today,
    auto_renew: true,
    billing_cycle: 'month',
    next_billing_date: today,
    total_sessions: null,
    created_at: noonISO(27),
  }),

  // 6.5 #6 · 固定天数表示（period_days 而非 billing_cycle）⇒ 钉 CD4 第 6 项"两种周期表示都要转述"
  C('山姆会员店', {
    start_date: addDays(today, -18),
    end_date: addDays(today, 12),
    auto_renew: true,
    period_days: 30,
    next_billing_date: addDays(today, 12),
    created_at: noonISO(18),
  }),

  // 6.5 #8 · 次数三态之一：有剩有配额 ⇒ 「剩 3 次（共 8 次）」
  C('海底捞次卡', { remaining_sessions: 3, total_sessions: 8, end_date: addDays(today, 40) }),

  // 6.5 #9 · 次数三态之二：0 = 已用完（且未续费 ⇒ 端上沉底）⇒ 钉 V68「0 不说成没记次数」
  C('洗车卡', { remaining_sessions: 0, total_sessions: null, end_date: addDays(today, 20) }),

  // 6.5 #10 · 🔴 次数三态之三（最易被实现混掉、也是真实库里最常见的一态）：两键都空 = 能力未开启
  //           ⇒ 清单里**整段不出现**次数那一段，绝不许说成"0 次"
  C('全家便利卡', { end_date: addDays(today, 9) }),

  // 6.5 #11 · 本周期静默 + 已过扣款日 ⇒ V85：一次读取会结算推进，触发器 cards_muted_reset
  //           把 cycle 解成 none。**这是既有设计不是缺陷**，但要说清"查询顺带解了静默"
  C('爱奇艺黄金会员', {
    start_date: addDays(today, -90),
    end_date: addDays(today, -3),
    auto_renew: true,
    billing_cycle: 'month',
    next_billing_date: addDays(today, -3),
    muted: 'cycle',
    created_at: noonISO(90),
  }),

  // 6.5 #12a · 名称含**内部空格** ⇒ 钉 CQ11 匹配口径「trim 首尾、不折内部空白」：
  //            搜「汉堡王中国」应当 0 命中，搜「汉堡王」才命中
  C('汉堡王 中国', { end_date: addDays(today, 25) }),

  // 6.5 #12b · 中英混排 + 大写 ⇒ 用户说「qq音乐」应当命中（折大小写），说「QQ音乐」也命中
  C('QQ音乐会员', { end_date: addDays(today, 7), icon_key: '__none__' }),
]

// ── 结构自检：把 DB 的四条 CHECK 先在本地过一遍，别让整批 INSERT 因为一行报错 ──
const seen = new Set()
for (const r of rows) {
  if (seen.has(r.name)) throw new Error(`fixture 内部重名：${r.name}（唯一键 user_id,name 会互相覆盖）`)
  seen.add(r.name)
  if (r.name !== r.name.trim()) throw new Error(`${r.name}：带首尾空白，撞 cards_name_trimmed`)
  if (r.end_date < r.start_date) throw new Error(`${r.name}：end_date < start_date，撞 cards_end_after_start`)
  if (r.auto_renew && (!r.next_billing_date || (r.period_days == null && r.billing_cycle == null)))
    throw new Error(`${r.name}：auto_renew=true 但扣款日/周期残缺，撞 cards_renew_complete`)
  if (r.period_days != null && r.billing_cycle != null) throw new Error(`${r.name}：两种周期表示同时非空`)
  if (r.total_sessions != null && r.remaining_sessions == null) throw new Error(`${r.name}：撞 cards_count_pair`)
  if (!['none', 'cycle', 'forever'].includes(r.muted)) throw new Error(`${r.name}：muted 枚举无效`)
}

// ── 写库 ─────────────────────────────────────────────────────────────
// --dry：只跑上面那圈 CHECK 模拟 + 打印计划，**不读凭据、不发任何请求**。
// 存在的理由：这份脚本的价值全在"12 行真的能落进库"，而本地改完行定义后不必拿
// 生产库去试错（撞 CHECK 是整批失败，不是跳过那一行）。
if (process.argv.includes('--dry')) {
  console.log(`DRY RUN · 今天（本地日历）= ${today} · ${rows.length} 行全部通过本地 CHECK 模拟`)
  for (const r of rows) {
    const ddl = r.end_date < today ? `${r.end_date} 已过期` : r.end_date
    const renew = r.auto_renew ? `续费 · ${r.billing_cycle || `${r.period_days}天`} · 扣款 ${r.next_billing_date}` : '不续费'
    const sess = r.remaining_sessions == null ? '无次数能力' : `剩 ${r.remaining_sessions}${r.total_sessions != null ? ` / 共 ${r.total_sessions}` : ''}`
    console.log(`  ${r.name.padEnd(14)} DDL ${ddl.padEnd(18)} ${renew.padEnd(34)} ${sess}${r.muted !== 'none' ? ` · ${r.muted}` : ''}`)
  }
  process.exit(0)
}

function parseDevVars() {
  const vars = {}
  for (const line of readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !line.trim().startsWith('#')) vars[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return vars
}
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = parseDevVars()
const admin = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
}

// --user=<uuid> 与 env SEED_USER_ID 二选一。做成 flag 而不只靠 env 的理由很实际：
// PowerShell 里 `SEED_USER_ID=… node …` 会被当成命令名而报错（Windows 终端是第一现场）。
const argUser = (process.argv.find((a) => a.startsWith('--user=')) || '').slice(7).trim()
const userId = argUser || process.env.SEED_USER_ID
if (!userId) {
  console.log('✗ 必须显式指定目标账号（这些卡名会被评测夹具逐字引用，落错账号 = 夹具与数据不同源）')
  console.log('  node scripts/seed-cards-m8.mjs --user=<演示账号 uuid>')
  console.log('  （PowerShell 也可：$env:SEED_USER_ID=\'<uuid>\'; node scripts/seed-cards-m8.mjs）')
  process.exit(1)
}
if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(userId)) {
  // 形状不对就别去库里试：PostgREST 对一个非法 uuid 的返回是 400/空集，读起来像"账号没数据"
  console.log(`✗ user_id 不像 uuid：${userId.slice(0, 40)}`)
  process.exit(1)
}

const names = rows.map((r) => r.name)
const namesQuery = names.map(encodeURIComponent).join(',')

// --probe：**只读**。先看这个账号现在有几行、12 个 fixture 名里已经在库的是哪几个。
// 存在的理由是网络报错的那次实测：ECONNRESET 发生在请求已发出之后 ⇒ **写没写成不知道**。
// 这时候正确动作不是重跑写入，是先数一眼（重跑虽然因 upsert 而安全，但"安全"是推理，
// 数出来是事实）。也是换账号前先确认目标没数错的最便宜办法。
if (process.argv.includes('--probe')) {
  const probe = async (url, opts) => {
    try {
      return await fetch(url, opts)
    } catch (err) {
      console.log(`✗ 连不上 ${new URL(SUPABASE_URL).host}：${err.message}（cause: ${err.cause?.code || err.cause?.message || '?'}）`)
      console.log('  ⇒ 这是本机到 Supabase 的网络路径问题，不是 key 也不是脚本。改用 supabase/cards-m8-fixture.sql')
      console.log('    在 Dashboard 里整体执行（行定义与本脚本一致），或按本文件头注②走代理。')
      process.exit(1)
    }
  }
  const cnt = await probe(`${SUPABASE_URL}/rest/v1/cards?select=id&user_id=eq.${userId}`, {
    method: 'HEAD',
    headers: { ...admin, Prefer: 'count=exact' },
  })
  const total = Number((cnt.headers.get('content-range') || '*/?').split('/')[1])
  const exist = await probe(
    `${SUPABASE_URL}/rest/v1/cards?select=name&user_id=eq.${userId}&name=in.(${namesQuery})&order=name.asc`,
    { headers: admin },
  )
  const existBody = await exist.json().catch(() => [])
  const got = Array.isArray(existBody) ? existBody.map((r) => r.name) : []
  console.log(`host=${new URL(SUPABASE_URL).host}  该账号 cards 行数=${Number.isFinite(total) ? total : '?'}`)
  console.log(`fixture 已在库 ${got.length}/12：${got.join('、') || '（一个都没有）'}`)
  console.log(`缺：${names.filter((n) => !got.includes(n)).join('、') || '（齐了）'}`)
  if (!cnt.ok || !exist.ok) console.log(`⚠ 有请求非 2xx：count=${cnt.status} list=${exist.status}（401/404 请核对 key 与项目 URL）`)
  process.exit(0)
}

if (process.argv.includes('--purge')) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/cards?user_id=eq.${userId}&name=in.(${namesQuery})`,
    { method: 'DELETE', headers: { ...admin, Prefer: 'return=representation' } },
  )
  const body = await res.json().catch(() => [])
  console.log(`--purge：删掉 ${Array.isArray(body) ? body.length : '?'} 行 fixture（按卡名删，未碰该账号其他卡）`)
  if (!res.ok) process.exit(1)
  process.exit(0)
}

console.log(`目标用户：${userId}`)
console.log(`今天（本地日历）：${today}，共 ${rows.length} 行 fixture`)

const payload = rows.map((r) => ({ user_id: userId, ...r }))
// 🔴 传输层失败**不等于没写进去**：ECONNRESET 可能发生在请求已发出、响应未回来之间。
// 所以这一支的措辞是"结果未知"，并且明确给出"先 --probe 数一眼、别盲目改参数重试"。
// 本脚本恰好是**可安全重跑**的那一类（upsert 到唯一键 user_id,name ⇒ 不会多出重复行），
// 但这句话要说清楚是"因为 upsert 才安全"，不是"重试总是安全"——同一个纪律在
// commitBalance 那边就不成立（那里是"不确定就别自动重试"）。
let res
try {
  res = await fetch(`${SUPABASE_URL}/rest/v1/cards?on_conflict=user_id,name`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(payload),
  })
} catch (err) {
  console.log(`✗ 请求没能正常完成：${err.message}（cause: ${err.cause?.code || err.cause?.message || '?'}）`)
  console.log('  ⇒ **结果未知**：可能一行都没写，也可能 12 行都已落库。别改参数重试，先跑只读探针数一眼：')
  console.log(`     node scripts/seed-cards-m8.mjs --user=${userId} --probe`)
  console.log(`     （本脚本是 upsert 到 (user_id,name)，确认缺行后重跑不会多出重复行。）`)
  console.log('  ⇒ 若本机到 Supabase 一直不通，改用 supabase/cards-m8-fixture.sql 在 Dashboard 执行（同一份行定义）。')
  process.exit(1)
}
const written = await res.json().catch(() => null)
if ((res.status !== 201 && res.status !== 200) || !Array.isArray(written)) {
  console.log(`✗ 写入失败：${res.status} ${JSON.stringify(written).slice(0, 400)}`)
  console.log('  ⚠ 读回的实际约束形态若与本文假设不符（比如线上 cards_name_trimmed 是含全角空格那版），')
  console.log('    先跑 supabase/cards-schema-check.sql 对一次，再改这份脚本，不要绕过 CHECK。')
  process.exit(1)
}

// ── 摘要：把每行的派生态就地算一遍，方便肉眼核对（与 skill 侧 cardQuery 无关，只是脚本自证）──
const bucket = { 未过期: 0, 已过期: 0, 续费中: 0, 有次数能力: 0, 次数已用完: 0, 静默中: 0, 窗口7天内: 0 }
for (const r of rows) {
  const expired = today > r.end_date
  bucket[expired ? '已过期' : '未过期'] += 1
  if (r.auto_renew) bucket.续费中 += 1
  if (r.remaining_sessions != null) bucket.有次数能力 += 1
  if (r.remaining_sessions === 0) bucket.次数已用完 += 1
  if (r.muted !== 'none') bucket.静默中 += 1
  if (!expired && Math.round((Date.parse(r.end_date) - Date.parse(today)) / DAY) <= 6) bucket.窗口7天内 += 1
}
console.log(`写入 ${written.length} 行；分布：${JSON.stringify(bucket)}`)
console.log('完成。下一步：小程序会员标签刷新一次 ⇒ 那 12 行就是 V65/V66/V67/V68/V82/V85/V92 的数据面。')
console.log('⚠ 第一次 GET /api/cards 会把「京东PLUS会员」与「爱奇艺黄金会员」各推进一周期（这是结算，')
console.log('   正是 V65/V85 要看的事）；要复原就重跑本脚本——upsert 会把日期拉回原值。')
