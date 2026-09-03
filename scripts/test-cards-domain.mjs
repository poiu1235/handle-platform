// 黄金测试数据 JS 侧断言（shared/cardsImportFixtures.js，cards-db.md 第 12 节预留 #4）：
// 覆盖 parseCardsText → mergeImportRows → classifyImport 全链路。SQL 侧
// （import_my_cards）以同一份用例在 Supabase 手工比对——两侧改动必须双跑通过。
// 运行：npm run test:cards

import { classifyImport, mergeImportRows, parseCardsText, buildImportPayload } from '../src/lib/cardsDomain.js'
import { CASES, LOADED, TODAY } from '../shared/cardsImportFixtures.js'

let failed = 0

for (const c of CASES) {
  const parsed = parseCardsText(c.text)
  const merged = mergeImportRows(parsed.rows)
  const result = classifyImport(merged, LOADED, TODAY)

  const problems = []
  if (result.creates.length !== c.expect.creates) {
    problems.push(`creates=${result.creates.length}（期望 ${c.expect.creates}）`)
  }
  if (result.updates.length !== c.expect.updates) {
    problems.push(`updates=${result.updates.length}（期望 ${c.expect.updates}）`)
  }
  if (result.errors.length !== c.expect.errors) {
    problems.push(`errors=${result.errors.length}（期望 ${c.expect.errors}）：${result.errors.map((e) => `第${e.line}行 ${e.reason}`).join('；')}`)
  }
  if (problems.length === 0 && c.expect.assert) {
    const msg = c.expect.assert(result)
    if (msg) problems.push(msg)
  }

  if (problems.length > 0) {
    failed++
    console.log(`✗ ${c.name}`)
    for (const p of problems) console.log(`    ${p}`)
  } else {
    console.log(`✓ ${c.name}`)
  }
}

// 载荷构造抽查：忽略字段不得进提交载荷
{
  const text = ['卡名\t剩余次数', '健身年卡\t20'].join('\n')
  const result = classifyImport(mergeImportRows(parseCardsText(text).rows), LOADED, TODAY)
  const payload = buildImportPayload(result)
  const row = payload[0]
  if (row.remaining_sessions !== undefined || row.total_sessions !== undefined) {
    failed++
    console.log('✗ 载荷构造：被忽略的次数字段不应进提交载荷')
  } else if (row.merchant !== undefined) {
    failed++
    console.log('✗ 载荷构造：merchant 列已合并进 name，不应出现')
  } else {
    console.log('✓ 载荷构造：4-B31 打包忽略字段不进提交载荷')
  }
}

if (failed > 0) {
  console.log(`\n${failed} 个用例失败`)
  process.exit(1)
}
console.log(`\n全部 ${CASES.length + 1} 个用例通过`)
