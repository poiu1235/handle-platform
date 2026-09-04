// 图标匹配相关的共享逻辑：清单加载、名称→图标 key 的自动匹配、默认展示的精选列表。
// 列表页（新增/修改弹窗）和批量导入页共用这一份，保证匹配规则不会两处各写一套、慢慢跑偏。

// ---------- 图标清单（public/small_icon/，由 scripts/gen-icon-manifest.js 生成）----------
// 模块级缓存：整个页面生命周期内只请求一次，各处调用直接复用同一份/同一个 pending promise
let iconManifestCache = null
let iconManifestPromise = null
export function loadIconManifest() {
  if (iconManifestCache) return Promise.resolve(iconManifestCache)
  if (!iconManifestPromise) {
    iconManifestPromise = fetch('/icon-manifest.json')
      .then((res) => (res.ok ? res.json() : []))
      .catch(() => [])
      .then((list) => {
        iconManifestCache = Array.isArray(list) ? list : []
        return iconManifestCache
      })
  }
  return iconManifestPromise
}

// 去掉字符串首尾所有"非中文/非英文字母"的字符（数字、符号、emoji、空格都算），
// 只掐头去尾，中间不动。例如「汉堡王+」→「汉堡王」，这样才能匹配到 汉堡王.png。
export function stripEdgeSymbols(str) {
  return (str || '').replace(/^[^A-Za-z\u4e00-\u9fa5]+|[^A-Za-z\u4e00-\u9fa5]+$/g, '')
}

// "默认N"是专门给「搜不到任何图标」兜底用的通用图标，不参与常规的按名称自动匹配、
// 也不出现在日常的图标网格/搜索结果里——它们不代表任何具体商户，被"匹配"上没有意义。
export const GENERIC_DEFAULT_ICON_RE = /^默认\d+$/

// 名称 → 图标 key 的粗匹配建议：两边都去掉首尾符号后再比较，谁包含谁都算命中，
// 取清单里第一个命中项。只是"预选建议"，不代表最终结果——用户随时可以在弹窗/导入
// 结果里换成任意图标或选择不配置。
// "预选建议"用的归一化：先去掉首尾符号，再把英文字母统一转小写（中文不受影响），
// 这样「QQ」「qq」「Qq」互相之间、以及跟清单里的「QQ邮箱」这类都能匹配上。
// 注意：这个归一化只用来做“比较”，最终返回的仍是 manifest 里原始的 key，
// 不会把大小写改写进结果里。
function normalizeForMatch(str) {
  return stripEdgeSymbols(str).toLowerCase()
}

export function suggestIconKey(name, manifest) {
  const n = normalizeForMatch((name || '').trim())
  if (!n || !manifest || manifest.length === 0) return null
  const candidates = manifest.filter((key) => !GENERIC_DEFAULT_ICON_RE.test(key))
  const exact = candidates.find((key) => normalizeForMatch(key) === n)
  if (exact) return exact
  return (
    candidates.find((key) => {
      const k = normalizeForMatch(key)
      return k && (n.includes(k) || k.includes(n))
    }) || null
  )
}

// 图标选择器"没有搜索词"时默认展示的图标——显式指定，不是简单取清单前 N 个。
// 想调整默认展示哪些、展示顺序，直接改这个数组（填 public/small_icon/ 里的文件名，
// 不含 .png）。清单里如果暂时还没有对应文件，会被自动跳过，不会出现空白格子；
// 如果指定的不够 11 个（配上"无"正好一排 6 个、两排 12 个），会用清单里剩下的
// 图标按顺序补满，保证选择器不会看起来比该有的空
export const DEFAULT_VISIBLE_ICON_KEYS = ['喜茶GO','网易严选','霸王茶姬','百度网盘','得物'
,'海底捞','海螺AI','航旅纵横','沪江网校','坚果云','剪映']

export function buildDefaultVisibleIcons(browsableIcons) {
  const curated = DEFAULT_VISIBLE_ICON_KEYS.filter((key) => browsableIcons.includes(key))
  if (curated.length >= 11) return curated.slice(0, 11)
  const rest = browsableIcons.filter((key) => !curated.includes(key))
  return [...curated, ...rest].slice(0, 11)
}