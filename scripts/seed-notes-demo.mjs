// 便利贴演示数据种子（2026-09-12 用户要求：50 灵感 + 50 备忘，覆盖各类分支）
// 覆盖矩阵：
//   灵感 50：长短（超短/短/中/多行/420+ 字）、时间跨度（今天→400 天前）、置顶 2、
//            今天密集 6 条（触发日历 >5 折叠）
//   备忘 50：有日期正常（今天到期/明天/还剩 2-7 各档）、无日期兜底（刚建→6 天前）、
//            已过期 1-7 天各档（含置顶过期→流转演示）、手动完成（今天/近几天/29 天/
//            过期后完成）、超期自动归档、置顶、多行、超短
// 运行：node scripts/seed-notes-demo.mjs [--reset]
//   --reset：先清空目标用户全部便利贴再插入；默认追加（重复运行会重复插入）
// 目标用户 = 最近登录的非测试账号（可 env SEED_USER_ID 覆盖）
// ⚠ 时间锚点全部用「本地正午 / now-分钟」，绝不用 now-N 天（跨午夜会漂移本地日）

import { readFileSync } from 'node:fs'
import { addDaysISO, todayISO } from '../shared/notesDomain.js'

const DAY = 86400000
const now = Date.now()
const today = todayISO(new Date(now))

// 本地正午的 ISO（±11 时区内永不跨日）——created 的本地日由此精确控制
function localNoonISO(daysAgo, minuteShift = 0) {
  const n = new Date(now)
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() - daysAgo, 12, minuteShift % 60)
  return d.toISOString()
}
const iso = (ms) => new Date(ms).toISOString()

const I = (content, o = {}) => ({ kind: 'idea', content, ...o })
const M = (content, o = {}) => ({ kind: 'memo', content, ...o })

// ── 灵感 50（d = 创建于几天前，0 = 今天；今天密集 6 条触发折叠）──────────
const ideas = [
  I('做一个便利贴页面', { d: 0 }),
  I('给日志加上搜索', { d: 0 }),
  I('试试导出 Markdown', { d: 0 }),
  I('深夜模式？深蓝 hero 已经够了，等等再说', { d: 0 }),
  I('英文名想叫 Sticky，路由还是 /app/notes 不动', { d: 0, pinned: true }),
  I('给数据端加个「本周完成」小结？——等等，先看已完成域的使用率再说', { d: 0 }),
  I('给爸妈的手机装上远程协助', { d: 1 }),
  I('把周报模板自动化', { d: 1 }),
  I('学一下 CSS container queries', { d: 1 }),
  I('写一篇「为什么我不用待办清单」', { d: 1 }),
  I('把书架按读完时间重排', { d: 2 }),
  I('试试 Pomodoro 的两天版本', { d: 2 }),
  I('给便利贴加个白噪音', { d: 3 }),
  I('整理浏览器书签的三层分类', { d: 3 }),
  I('跑步配速表贴墙上', { d: 4 }),
  I('做一个「今天只做三件事」的小卡', { d: 4, pinned: true }),
  I('给记账 App 写个快捷指令', { d: 5 }),
  I('研究一下家庭 NAS 备份', { d: 5 }),
  I('把年度目标拆成季度检查点', { d: 6 }),
  I('灵感卡片和备忘卡片要视觉区分：白卡是想法、黄卡是要办的事', { d: 7 }),
  I('日历月视图参考飞书日程，一格一天条目往高处长，不做车道算法', { d: 7 }),
  I('长文截断四行合适吗？手机上可能两行就够，做 A/B', { d: 8 }),
  I('倒计时角标三档文案：还剩 N 天 / 明天到期 / 今天到期，负数不显示直接置灰', { d: 9 }),
  I('已过期域默认收起，但排序把快被自动归档的排最前', { d: 9 }),
  I('时间线越往下越只剩灵感——备忘最多 14 天就离场', { d: 10 }),
  I('图标库 lucide 和 iconfont 风格混着，要不要统一成一套', { d: 14 }),
  I('给 PRD 加决策日志页，D1–D16 的来龙去脉都记下来', { d: 14 }),
  I('RLS 是好东西，但 service key 直连时要小心别绕过去', { d: 14 }),
  I('周报可以从已完成域自动汇总，完成的事情自动拉清单', { d: 21 }),
  I('「上周灵感回顾」入口？——不做，违背不加压力的初衷，先记着', { d: 21 }),
  I('标签页拖动排序不加，顺序就是使用频率', { d: 21 }),
  I('颜色系统三色就够：黄备忘、白灵感、灰失效', { d: 30 }),
  I('砍掉推送是底线，倒计时角标就是提醒本身', { d: 30 }),
  I('触发器比应用层状态机可靠，时间自己会流动', { d: 30 }),
  I('过期 / 完成的来源标识两类就够：手动完成蓝标、超期归档灰标', { d: 45 }),
  I('置顶不豁免流转规则——与所有 todo 应用的本质区别', { d: 45 }),
  I('30 天清除不给回收站，归档的意义就是可以放心消失', { d: 60 }),
  I('列数随容器宽度走，不做拖拽调整列宽', { d: 60 }),
  I('只有天没有时刻，是刻意为之：「几点做」是日历的事', { d: 90 }),
  I('滑动操作不适配网格交互模型，记下来防止再想', { d: 90 }),
  I('日历条目点击跳回列表展开，比内嵌编辑轻', { d: 120 }),
  I('v3 验收清单：\n1. 四分区归属唯一\n2. 备忘 7+7 流转\n3. 已完成 30 天清除\n4. 全程无推送', { d: 150 }),
  I('产品三问：\n- 用户为什么打开？记一笔或看一眼\n- 用完为什么关掉？没有粘性设计\n- 什么让它不同于 todo？不安排、不催促、自动退场', { d: 180 }),
  I('极简模式设想：\n字体放大一档\n只留备忘不留灵感\n置顶区默认展开\n已完成直接隐藏', { d: 240 }),
  I('命名讨论结论：\n灵感 = idea，想到但没到要做事的程度\n备忘 = memo，怕忘的具体事务\n不叫任务不是任务，不叫待办不是待办', { d: 300 }),
  I('每周日晚五分钟翻一遍已过期域：哪些是真的忘了、哪些可以放它走 🌙', { d: 400 }),
  I(
    '把「做一个便利贴页面」这个想法展开，核心其实有三层：\n第一层是卡片——写什么显示什么，没有字段没有表单，正文就是一切；\n第二层是时间——备忘会流转、灵感会沉淀，时间自己推着东西走，用户不用动手整理；\n第三层是干净——没有红点、没有推送、没有「你有 N 条待办」的焦虑，打开是自己的节奏，关掉没有任何亏欠感。\n如果只能保住一层，保住第三层。',
    { d: 14 },
  ),
  I(
    '技术侧脑暴：状态为什么不落库？过期、归档、清除三个跃迁全都能从两个时间戳推出来——截止日和完成时刻。\n推论一：没有 cron、没有扫描任务、没有状态机写放大，数据库里只有 CRUD。\n推论二：多端永远一致，因为时间是同一份物理事实，各端各自演算不会漂移。\n推论三：测试面骤减，派生函数是纯函数，37 条断言就能锁死全部边界。\n唯一要写库的动作是手动完成，那也是唯一带「用户意志」的动作。',
    { d: 30 },
  ),
  I(
    '生活随想：这半年最舒服的习惯是「随手记、不整理」。以前收藏夹、待办、笔记分了五个 App，每个都在等我有空回头清理，结果谁也没等到。\n便利贴的反面是「永不过期的清单」——清单越长越不敢打开。\n现在好的状态是：怕忘的写下来，到期自然跳出来；灵感的写下来，哪天翻到会心一笑。\n工具应该像便签纸一样便宜，撕掉不心疼，贴上不仪式。',
    { d: 21 },
  ),
  I('把 e2e 清理条件抽成共享常量，前端清扫和后端清理共用一个口径', { d: 60 }),
]

// ── 备忘 50 ──────────────────────────────────────────────────────────
// due = 相对今天（0 = 今天到期，负 = 已过期）；c = 创建于几天前（0 = 今天）；
// f = 完成于几天前；fH = 完成于几小时前
const memos = [
  // 有日期 · 正常（19：今天 4 / 明天 3 / +2 3 / +3 2 / +4 2 / +5 2 / +6 1 / +7 2）
  M('下午取快递，菜鸟驿站 C12', { due: 0, c: 0 }),
  M('下午三点给王星打电话确认聚餐菜单', { due: 0, c: 0 }),
  M('健身房续费优惠最后一天，要不要续再定一次', { due: 0, c: 1 }),
  M('这个月预算还剩 800，大额支出先停一停', { due: 0, c: 2, pinned: true }),
  M('周日和王星聚餐\n老友王星突然来广州，定在体育东的粤菜馆碰头', { due: 1, c: 1 }),
  M('还书到图书馆', { due: 1, c: 2 }),
  M('给海伦回复合作邮件', { due: 1, c: 0 }),
  M('还给同事充电宝', { due: 2, c: 1 }),
  M('买机票比价：中秋回家', { due: 2, c: 2 }),
  M('准备周一晨会要点：\n- 上周便利贴上线数据\n- 两个待定需求\n- 排期风险', { due: 2, c: 1 }),
  M('周三前回复房东', { due: 3, c: 1, pinned: true }),
  M('给团队订周一的下午茶', { due: 3, c: 2 }),
  M('预约周五洗牙', { due: 4, c: 2 }),
  M('交供暖费', { due: 4, c: 3 }),
  M('缴物业费', { due: 5, c: 1 }),
  M('提交报销单', { due: 5, c: 4 }),
  M('给妈妈订生日蛋糕', { due: 6, c: 2 }),
  M('车险报价单再核实一下', { due: 7, c: 3 }),
  M('季度 OKR 初稿', { due: 7, c: 2 }),
  // 无日期 · 正常（10：今天 3 / 2-6 天前各档，兜底 = 创建日 + 7）
  M('冰箱鸡蛋没了，买鸡蛋', { c: 0 }),
  M('下载票根 PDF 存档', { c: 0 }),
  M('把阳台的绿萝浇水', { c: 0 }),
  M('核对新医保缴费基数', { c: 2 }),
  M('回复物业关于停车位', { c: 2 }),
  M('把冬天衣服送洗', { c: 3 }),
  M('查一下上次体检报告放哪了', { c: 4 }),
  M('把会议纪要发给小周', { c: 4 }),
  M('给电脑清灰', { c: 5 }),
  M('给打印机换墨', { c: 6 }),
  // 已过期（9：-1 ×2 / -2 / -3 ×2 / -4 / -5 / -6 / -7；置顶 1 条验证流转）
  M('给自行车打气', { due: -1, c: 3 }),
  M('续费视频会员', { due: -1, c: 4 }),
  M('判断健身房年卡要不要续', { due: -2, c: 5 }),
  M('给房东转下季度房租', { due: -3, c: 5, pinned: true }),
  M('交水电费', { due: -3, c: 7 }),
  M('取修改好的眼镜', { due: -4, c: 6 }),
  M('预约驾照体检', { due: -5, c: 8 }),
  M('买生日礼物给小林', { due: -6, c: 8 }),
  M('回访客户老陈', { due: -7, c: 10 }),
  // 手动完成（8：今天 2 / 近几天 3 / 29 天 / 过期后完成 2）
  M('交水费', { fM: 30, c: 1 }),
  M('确认周一开会时间', { fM: 300, c: 2 }),
  M('买牙膏', { f: 1, c: 3 }),
  M('给团队订咖啡豆', { f: 2, c: 4 }),
  M('修阳台晾衣架', { f: 3, c: 6 }),
  M('预约体检', { f: 29, c: 32 }),
  M('取蜡像馆门票', { due: -5, f: 2, c: 8 }),
  M('填个税专项扣除', { due: -8, f: 1, c: 12 }),
  // 超期自动归档（2）
  M('更新简历', { due: -15, c: 18 }),
  M('洗空调滤网', { due: -9, c: 12 }),
  // 多行补充（无日期）
  M('周末采购清单：\n排骨、鸡蛋、青菜\n洗衣液、垃圾袋\n给猫带的冻干', { c: 1 }),
  M('搬家前要做的：\n1. 找打包箱\n2. 转宽带\n3. 押金单拍照', { c: 2 }),
]

const all = [...ideas, ...memos]
if (all.length !== 100) {
  console.log(`✗ 条目数应为 100，实际 ${all.length}`)
  process.exit(1)
}

// ── 展开为行：created 锚点 = 「今天」用 now-分钟，「N 天前」用本地正午 ──
const rows = all.map((it, i) => {
  const { pinned = false, kind, content } = it
  const jitter = ((i * 7) % 44) + 2 // 2–45 分钟
  let created
  if (kind === 'idea') {
    created = it.d === 0 ? iso(now - jitter * 60000) : localNoonISO(it.d, jitter)
  } else {
    created = it.c === 0 ? iso(now - jitter * 60000) : localNoonISO(it.c, jitter)
  }
  const row = { kind, content, due_date: null, finished_at: null, pinned, created_at: created }
  if (kind === 'memo' && it.due !== undefined) {
    row.due_date = addDaysISO(today, it.due)
    // 过期备忘的 created 必须早于 due
    if (it.due < 0 && Date.parse(row.created_at) > Date.parse(`${row.due_date}T00:00:00Z`)) {
      row.created_at = new Date(Date.parse(`${row.due_date}T00:00:00Z`) - 2 * DAY).toISOString()
    }
  }
  if (it.f !== undefined) row.finished_at = iso(now - it.f * DAY)
  if (it.fM !== undefined) row.finished_at = iso(now - it.fM * 60000)
  return row
})

// ── 写库 ─────────────────────────────────────────────────────────────
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
const reset = process.argv.includes('--reset')

const list = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=50`, { headers: admin }).then((r) => r.json())
const isTest = (e) => /^(e2e-|nt-|rpc-|cards-test)/.test(e || '') || (e || '').endsWith('@handle.local')
const candidates = (list.users ?? [])
  .filter((u) => !isTest(u.email))
  .sort((a, b) => Date.parse(b.last_sign_in_at ?? 0) - Date.parse(a.last_sign_in_at ?? 0))
const user = process.env.SEED_USER_ID ? { id: process.env.SEED_USER_ID } : candidates[0]
if (!user) {
  console.log('✗ 找不到目标用户（非测试账号）')
  process.exit(1)
}
console.log(`目标用户：${user.id}`)

const cnt = await fetch(`${SUPABASE_URL}/rest/v1/notes?select=id&user_id=eq.${user.id}`, {
  method: 'HEAD',
  headers: { ...admin, Prefer: 'count=exact' },
})
const existing = Number((cnt.headers.get('content-range') || '*/0').split('/')[1])
if (existing > 0 && !reset) {
  console.log(`✗ 该用户已有 ${existing} 条便利贴。直接追加会重复；确认清空重插请加 --reset`)
  process.exit(1)
}
if (reset) {
  await fetch(`${SUPABASE_URL}/rest/v1/notes?user_id=eq.${user.id}`, { method: 'DELETE', headers: admin })
  console.log('--reset：原数据已清空')
}

const payload = rows.map((r) => ({
  user_id: user.id,
  kind: r.kind,
  content: r.content,
  due_date: r.due_date,
  finished_at: r.finished_at,
  pinned: r.pinned,
  created_at: r.created_at,
}))
for (let i = 0; i < payload.length; i += 25) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/notes`, {
    method: 'POST',
    headers: { ...admin, Prefer: 'return=representation' },
    body: JSON.stringify(payload.slice(i, i + 25)),
  })
  const body = await res.json().catch(() => null)
  if (res.status !== 201 || !Array.isArray(body)) {
    console.log(`✗ 第 ${i} 批插入失败：${res.status} ${JSON.stringify(body).slice(0, 300)}`)
    process.exit(1)
  }
}

// ── 分布摘要 ─────────────────────────────────────────────────────────
const buckets = { '正常·有日期': 0, '正常·无日期': 0, 已过期: 0, 手动完成: 0, 过期后手动完成: 0, 自动归档: 0 }
let pinnedCount = 0
let ideaCount = 0
let memoCount = 0
for (const r of payload) {
  if (r.pinned) pinnedCount += 1
  if (r.kind === 'idea') {
    ideaCount += 1
    continue
  }
  memoCount += 1
  if (r.finished_at) {
    if (r.due_date && r.due_date < today) buckets['过期后手动完成'] += 1
    else buckets['手动完成'] += 1
  } else if (r.due_date && r.due_date < today) buckets.已过期 += 1
  else if (r.due_date) buckets['正常·有日期'] += 1
  else buckets['正常·无日期'] += 1
}
const autoArchived = payload.filter(
  (r) => r.kind === 'memo' && !r.finished_at && r.due_date && r.due_date <= addDaysISO(today, -8),
).length
buckets.已过期 -= autoArchived
buckets.自动归档 = autoArchived

console.log(`灵感 ${ideaCount} 条 / 备忘 ${memoCount} 条，共 ${payload.length} 条；置顶 ${pinnedCount} 条`)
console.log('备忘分支：', JSON.stringify(buckets))
console.log('完成。刷新页面即可查看（今天 = ' + today + '，本地日历）。')
