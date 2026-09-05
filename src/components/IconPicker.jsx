import { useEffect, useMemo, useState } from 'react'
import {
  buildDefaultVisibleIcons,
  GENERIC_DEFAULT_ICON_RE,
  suggestIconKey,
} from '../lib/iconMatch'
import { useIconManifest } from '../lib/useIconManifest'

// 图标选择区块（余额 ↔ 会员表单共用）：已选中锚定预览 / 搜索框 / 图标网格 /
// "默认N"兜底网格。纯受控组件——选中值与点选回调由父级表单持有，两边的
// 提交语义不同（余额：null = 不配置；会员：null = 按名称自动匹配），
// 状态机留在各自表单里，这里只管清单加载、搜索过滤和展示。
//
// props：
//   value       当前选中的 key（null = 未指定/自动，是否显示网格由此决定）
//   noneOption  网格里是否渲染"无"格（余额 true；会员无"无"的概念，false）
//   showAutoTag 预览上是否挂"按名称自动匹配"标签
//   clearLabel  预览右侧按钮文案（余额「移除」；会员手动指定时「恢复自动」；
//               null = 不渲染按钮）
//   onPick(key) 点选任意图标（noneOption 时也可能收到 null）
//   onClear()   预览按钮回调
export function IconPickerField({
  value,
  noneOption = false,
  showAutoTag = false,
  clearLabel = null,
  onPick,
  onClear,
}) {
  const iconOptions = useIconManifest()
  const [iconQuery, setIconQuery] = useState('')

  // 搜索：按标题（文件名/key）做包含匹配，不区分大小写（中文本身不受影响）。
  // "默认N"这组通用兜底图标不参与常规展示/搜索——只在搜不到任何结果时出现。
  const iconQueryTrim = iconQuery.trim().toLowerCase()
  const browsableIconOptions = useMemo(
    () => iconOptions.filter((key) => !GENERIC_DEFAULT_ICON_RE.test(key)),
    [iconOptions]
  )
  const defaultIconOptions = useMemo(
    () => iconOptions.filter((key) => GENERIC_DEFAULT_ICON_RE.test(key)),
    [iconOptions]
  )
  const matchedIconOptions = iconQueryTrim
    ? browsableIconOptions.filter((key) => key.toLowerCase().includes(iconQueryTrim))
    : buildDefaultVisibleIcons(browsableIconOptions)
  // 选择框最多两行：连"无"一起 12 个格子，一排 6 个——超出部分不展示，
  // 想找更靠后的图标用搜索框缩小范围
  const filteredIconOptions = matchedIconOptions.slice(0, 11)
  const showDefaultFallback = iconQueryTrim.length > 0 && matchedIconOptions.length === 0
  // 选中了真实图标（非"无"）且当前没在搜索时，收起网格，只显示"已选中"的锚定预览；
  // 用户重新在搜索框打字，或点预览上的"移除"，才会再展开选择网格
  const showIconPicker = value === null || iconQueryTrim.length > 0

  // 点选后收起网格、回到"已选中"预览（搜索词一并清掉，与原余额表单行为一致）；
  // 重新搜索会再展开网格
  function pickAndCollapse(key) {
    setIconQuery('')
    onPick(key)
  }

  if (showIconPicker) {
    return (
      <>
        <input
          className="bd-icon-search"
          value={iconQuery}
          onChange={(e) => setIconQuery(e.target.value)}
          placeholder="搜索图标标题，比如「喜茶」"
        />
        <div className="bd-icon-picker">
          {noneOption && (
            <button
              type="button"
              className={`bd-icon-option bd-icon-option-none ${value === null ? 'bd-icon-option-active' : ''}`}
              onClick={() => pickAndCollapse(null)}
            >
              无
            </button>
          )}
          {!showDefaultFallback &&
            filteredIconOptions.map((key) => (
              <button
                type="button"
                key={key}
                className={`bd-icon-option ${value === key ? 'bd-icon-option-active' : ''}`}
                onClick={() => pickAndCollapse(key)}
                title={key}
              >
                <img src={`/small_icon/${encodeURIComponent(key)}.png`} alt={key} />
              </button>
            ))}
        </div>

        {showDefaultFallback && (
          <>
            <p className="cd-field-hint">
              没有找到「{iconQuery.trim()}」相关的图标，可以先从下面选一个默认图标
            </p>
            <div className="bd-icon-picker bd-icon-picker--scroll">
              {defaultIconOptions.map((key) => (
                <button
                  type="button"
                  key={key}
                  className={`bd-icon-option ${value === key ? 'bd-icon-option-active' : ''}`}
                  onClick={() => pickAndCollapse(key)}
                  title={key}
                >
                  <img src={`/small_icon/${encodeURIComponent(key)}.png`} alt={key} />
                </button>
              ))}
            </div>
          </>
        )}
      </>
    )
  }

  return (
    <div className="bd-icon-selected">
      <img
        className="bd-icon-selected-img"
        src={`/small_icon/${encodeURIComponent(value)}.png`}
        alt=""
      />
      <div className="bd-icon-selected-info">
        <span className="bd-icon-selected-name">{value}</span>
        {showAutoTag && <span className="bd-icon-selected-tag">按名称自动匹配</span>}
      </div>
      {clearLabel && (
        <button type="button" className="bd-icon-selected-clear" onClick={onClear}>
          {clearLabel}
        </button>
      )}
    </div>
  )
}

// 会员卡表单的图标状态机（建卡 / 编辑共用）：null = 按名称自动匹配（落库 null，
// 展示层 suggestIconKey 推导），手动指定后落库具体 key。manual 标记用户是否
// 指定过——未指定时名称变化实时跟随自动建议；点「恢复自动」回到跟随态。
// 与余额的差异：余额 iconTouched 后"无"也是终态；会员没有"无"，恢复自动 =
// 回到跟随（同名覆盖提交契约见 CardAddModal buildSubmitPayload）。
export function useCardIconState({ name, initialKey, resetToken }) {
  const options = useIconManifest()
  const [iconKey, setIconKey] = useState(initialKey ?? null)
  const [manual, setManual] = useState(!!initialKey)
  // resetToken 变化（建卡弹窗"同名覆盖预填"：输入的名称命中/离开既有卡，命中卡
  // 换了卡）时整体重置图标状态——官方的渲染期调整模式，避免 effect 级联渲染。
  const [prevResetToken, setPrevResetToken] = useState(resetToken)
  if (resetToken !== prevResetToken) {
    setPrevResetToken(resetToken)
    setIconKey(initialKey ?? null)
    setManual(!!initialKey)
  }

  // 自动建议：只在用户还没手动指定时生效，名称/清单变化就实时跟随；一旦手动
  // 指定过（pick），这里永久让位，直到「恢复自动」回到跟随态
  useEffect(() => {
    if (manual) return
    setIconKey(suggestIconKey(name, options))
  }, [manual, name, options])

  function pick(key) {
    setIconKey(key)
    setManual(true)
  }

  function restoreAuto() {
    setIconKey(null)
    setManual(false)
  }

  return { iconKey, manual, pick, restoreAuto }
}
