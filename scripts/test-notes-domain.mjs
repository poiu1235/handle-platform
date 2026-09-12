// 便利贴派生函数断言（shared/notesDomain.js · PRD 8.6 联调必测清单的纯函数子集）。
// 运行：npm run test:notes。断言风格对照 test-cards-domain.mjs（手工计数 + ✓/✗）；
// 用例内联本文件——notes 没有 SQL RPC（状态全派生），无需 JS/SQL 双侧夹具。
// 夹具的 created_at 统一取 12:00Z：本地日 = 9月12日 对 UTC−11…UTC+11 全时区成立，
// 保证「创建日 + 7」的派生断言与本机时区无关。

import {
  addDaysISO,
  contentError,
  countdownOf,
  deadlineOf,
  deriveState,
  diffDays,
  dueDateError,
  expiredDays,
  isCleared,
  isISODate,
  sortForExpired,
  sortForIdeaFilter,
  sortForMemoFilter,
  zoneOf,
} from '../shared/notesDomain.js'

let failed = 0
function check(name, actual, expect) {
  const ok = JSON.stringify(actual) === JSON.stringify(expect)
  if (ok) {
    console.log(`✓ ${name}`)
  } else {
    failed += 1
    console.log(`✗ ${name}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  }
}

const T = '2026-09-12' // 今天（本地日历）
const NOW = Date.parse('2026-09-12T00:00:00Z')

const row = (over = {}) => ({
  id: 'id-1',
  kind: 'memo',
  content: '内容',
  pinned: false,
  due_date: null,
  finished_at: null,
  created_at: '2026-09-12T12:00:00Z',
  ...over,
})

// ── 日期工具 ──
check('addDaysISO 跨月', addDaysISO('2026-09-19', 11), '2026-09-30')
check('addDaysISO 跨年', addDaysISO('2026-12-30', 5), '2027-01-04')
check('diffDays 方向', diffDays('2026-09-12', '2026-09-08'), 4)
check('isISODate 拒绝 2月30', isISODate('2026-02-30'), false)
check('isISODate 拒绝非日期', isISODate('2026-09-1x'), false)

// ── 8.2 生命周期：未设日期 = 创建日+7 截止、+8 过期、+38 清除 ──
check('未设日期截止 = 创建日+7', deadlineOf(row()), '2026-09-19')
check('截止日当天仍正常（D7）', deriveState(row({ due_date: '2026-09-12' }), T), 'normal')
check('次日进已过期', deriveState(row({ due_date: '2026-09-11' }), T), 'expired')
check('过期满 7 天仍滞留', deriveState(row({ due_date: '2026-09-05' }), T), 'expired')
check('第 8 天自动归档（D9）', deriveState(row({ due_date: '2026-09-04' }), T), 'done-auto')
check('手动完成恒为 done-manual', deriveState(row({ due_date: '2026-09-04', finished_at: '2026-09-12T01:00:00Z' }), T), 'done-manual')
check('灵感永不过期', deriveState(row({ kind: 'idea', created_at: '2026-05-01T12:00:00Z' }), T), 'normal')

// ── 倒计时角标（D5/D6）：只有设了日期的正常态备忘才有 ──
check('还剩 N 天', countdownOf(row({ due_date: '2026-09-14' }), T), { key: 'days', text: '还剩 2 天' })
check('明天到期', countdownOf(row({ due_date: '2026-09-13' }), T), { key: 'tomorrow', text: '明天到期' })
check('今天到期', countdownOf(row({ due_date: '2026-09-12' }), T), { key: 'today', text: '今天到期' })
check('无日期不显示倒计时（D5）', countdownOf(row()), null)
check('灵感无角标', countdownOf(row({ kind: 'idea', due_date: '2026-09-14' }), T), null)
check('过期后不显示倒计时', countdownOf(row({ due_date: '2026-09-11' }), T), null)

// ── 已过期域（D8）：过期天数 = 排序键，天数最多的最前 ──
check('已过期天数', expiredDays(row({ due_date: '2026-09-09' }), T), 3)
const expSorted = sortForExpired(
  [
    { row: row({ id: 'a', due_date: '2026-09-10' }), state: 'expired' },
    { row: row({ id: 'b', due_date: '2026-09-06' }), state: 'expired' },
  ],
  T,
)
check('已过期排序：快被收走的最前', expSorted.map((v) => v.row.id), ['b', 'a'])

// ── 筛选排序（2026-09-12 用户裁定 + 澄清：仅备忘截止日 near/far、无日期按
//    派生截止日（创建日 + 7）参与排序；仅灵感创建日 old/new）──
const mv = [
  { row: row({ id: 'a', due_date: '2026-09-17' }), state: 'normal' },
  { row: row({ id: 'b', due_date: '2026-09-14' }), state: 'normal' },
  // 无日期：created 9/12（本地日 ±12 时区稳定）→ 派生截止 9/19，排序自然插序
  { row: row({ id: 'c', due_date: null }), state: 'normal' },
  { row: row({ id: 'd', due_date: '2026-09-15' }), state: 'normal' },
]
check(
  '备忘筛选 near：截止由近到远、无日期按派生截止插序',
  sortForMemoFilter(mv, 'near').map((v) => v.row.id),
  ['b', 'd', 'a', 'c'],
)
check(
  '备忘筛选 far：截止由远到近',
  sortForMemoFilter(mv, 'far').map((v) => v.row.id),
  ['c', 'a', 'd', 'b'],
)
// 无日期备忘的超期提醒：过期天数按派生截止日计（创建日 + 7）
check(
  '无日期备忘过期徽标天数',
  expiredDays(row({ id: 'c2', due_date: null, created_at: `${addDaysISO(T, -9)}T12:00:00Z` }), T),
  2,
)
const iv = [
  { row: row({ id: 'a', kind: 'idea', created_at: '2026-09-12T12:00:00Z' }), state: 'normal' },
  { row: row({ id: 'b', kind: 'idea', created_at: '2026-09-01T12:00:00Z' }), state: 'normal' },
  { row: row({ id: 'c', kind: 'idea', created_at: '2026-09-05T12:00:00Z' }), state: 'normal' },
]
check(
  '灵感筛选 old：从旧到新',
  sortForIdeaFilter(iv, 'old').map((v) => v.row.id),
  ['b', 'c', 'a'],
)
check(
  '灵感筛选 new（默认）：从新到旧',
  sortForIdeaFilter(iv, 'new').map((v) => v.row.id),
  ['a', 'c', 'b'],
)

// ── 清除（8.5 / D10）：自动行 截止+38；手动行 finished_at+30 天精确 ──
check('自动归档未满 30 天不清除', isCleared(row({ due_date: '2026-08-28' }), T, NOW), false)
check('截止+38 起清除', isCleared(row({ due_date: '2026-08-04' }), T, NOW), true)
check('手动完成 +30 天内保留', isCleared(row({ finished_at: '2026-08-13T12:00:00Z' }), T, NOW), false)
check('手动完成 +30 天整清除', isCleared(row({ finished_at: '2026-08-13T00:00:00Z' }), T, NOW), true)

// ── 分区（D11）：置顶只影响正常态收录，不豁免流转 ──
check('置顶正常态 → pin 区', zoneOf(row({ pinned: true, due_date: '2026-09-14' }), T), 'pin')
check('置顶过期照常流转（D11）', zoneOf(row({ pinned: true, due_date: '2026-09-11' }), T), 'expired')
check('未置顶正常态 → 时间线', zoneOf(row(), T), 'timeline')
check('手动完成 → 已完成域', zoneOf(row({ finished_at: '2026-09-12T01:00:00Z' }), T), 'done')

// ── 校验（8.4，CF 层与前端表单同源） ──
check('内容空白拒绝', contentError('   '), '内容不能为空')
check('内容 501 字拒绝', contentError('字'.repeat(501)), '内容最多 500 字')
check('内容合法', contentError('冰箱鸡蛋没了，买鸡蛋'), null)
check('灵感带日期拒绝（D3）', dueDateError('2026-09-14', 'idea', T), '灵感不能设置日期')
check('日期 = 今天合法（立即今天到期）', dueDateError('2026-09-12', 'memo', T), null)
check('日期 = 今天+7 合法', dueDateError('2026-09-19', 'memo', T), null)
check('日期 = 今天+8 拒绝', dueDateError('2026-09-20', 'memo', T), '日期最多选到 9月19日')
check('日期早于今天拒绝', dueDateError('2026-09-11', 'memo', T), '日期不能早于今天')
check('日期格式非法拒绝', dueDateError('09/12/2026', 'memo', T), '日期格式无效')
check('不设日期合法', dueDateError(null, 'memo', T), null)

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 个断言失败`)
process.exit(failed === 0 ? 0 : 1)
