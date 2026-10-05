// 生产者形状解析器：从源码里读出"某个函数到底 select 了哪几列"，以及"某个函数读了 `row.X` 里的哪些 X"。
// 为什么单独一份：`test:orders` 与 `test:refund` 都要钉同一件事（消费者对生产者的字段需求 ⊆ 生产者的 select），
// 而抄两遍解析器就会有两份不同的 bug——2026-10-05 夜我第一版用 `?select=([a-z_,0-9]+)` 去抓，
// 它在**跨行拼接**的模板字符串上会停在第一个反引号，于是抓到的其实是**下一个函数**的 select ⇒
// 判据恒绿、反证不红（把 `platform` 从 `getOrderRow` 里删掉，59 格一格都没红）。这种门比没有门更坏。
//
// 用法：selectColsOf(storeSrc, 'getOrderRow') → ['id','user_id',…]；readsRowFieldsOf(refundSrc) → ['status','env',…]

/** 取 `export async function <fn>(` 到下一个 `export async function` 之间的函数体 */
function bodyOf(src, fn) {
  const start = src.indexOf(`export async function ${fn}(`)
  if (start < 0) throw new Error(`源码里找不到函数 ${fn}（这一族的形状改了，判据要跟着改）`)
  const next = src.indexOf('export async function', start + 10)
  return src.slice(start, next < 0 ? src.length : next)
}

/**
 * 这个函数到底读了哪几列。🔴 不能只抓第一段：select 常常写成
 *   `` `${ORDERS}?select=a,b,` + `c,d&filter=…` ``（跨行拼接），
 * 所以取 `?select=` 之后到第一个 `&` 之前的**整段**，再把模板字符串的残渣（反引号／加号／空白）去掉。
 */
export function selectColsOf(src, fn) {
  const m = /\?select=([\s\S]*?)&/.exec(bodyOf(src, fn))
  if (!m) throw new Error(`${fn} 里没有 ?select=…& 这一段（判据要跟着改，别让它静默变成恒真）`)
  return m[1].replace(/[^a-z_,]/g, '').split(',').filter(Boolean)
}

/** 一个模块从 `row.` 上读了哪些字段（吃掉行注释，免得把"记录这条禁令的注释"也算成读取） */
export function readsRowFieldsOf(src) {
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
  return [...new Set([...code.matchAll(/\brow\.([a-z_0-9]+)/g)].map((x) => x[1]))].sort()
}

/** 按生产者的 select 裁一行——桩里的行必须长成"库里真会回回来的样子"，否则漏列这种事在桩里看不出来 */
export function pickToSelect(cols, row) {
  if (row === null || row === undefined) return row
  const out = {}
  for (const k of Object.keys(row)) if (cols.includes(k)) out[k] = row[k]
  return out
}
