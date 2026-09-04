// src/lib/iconColor.js
//
// 根据 icon 的主色 manifest 生成卡片渐变背景色。
//
// 取色规则：渐变固定从白色过渡到"选定颜色"，选定颜色直接用清单第一主色；
// 没有 logo 映射（或没命中）时用传入的默认色（比如原来 colorFor 给的 hash 单色）。
// 不管有没有 logo 映射，渐变都是「白色 → 选定颜色」，观感统一。

import iconColors from './iconColors.json'

// 跟 board.css 里 --au-text 保持一致，深色卡片用的默认文字色（十六进制，用于亮度计算）
const DARK_TEXT_HEX = '#1a1a1a'

function relativeLuminance(hex) {
  const toLinear = (c) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  const r = toLinear(parseInt(hex.slice(1, 3), 16))
  const g = toLinear(parseInt(hex.slice(3, 5), 16))
  const b = toLinear(parseInt(hex.slice(5, 7), 16))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(l1, l2) {
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// 选定颜色：直接用第一主色，不做饱和度判断。
function resolveSelectedColor(iconKey, defaultColor) {
  const colors = iconColors[iconKey]
  if (!colors || !colors.length) return defaultColor
  return colors[0]
}

// 卡片的"主色"（跟 cardStyle/cardBackground 取的是同一个色，只是不拼渐变），
// 给展开态的环境光效果（ambient glow）用：需要一个纯色去驱动 --bd-ambient。
export function dominantColor(iconKey, defaultColor) {
  return resolveSelectedColor(iconKey, defaultColor)
}

export function cardBackground(iconKey, defaultColor) {
  const color = resolveSelectedColor(iconKey, defaultColor)
  return `linear-gradient(90deg, ${color}, #ffffff)`
}

// 给定某个具体背景色，跟白字/深色字比对比度，选对比度更高的那个。
function chooseTextColor(bgHex, defaultTextColor) {
  const lum = relativeLuminance(bgHex)
  const contrastWithWhite = contrastRatio(lum, 1)
  const contrastWithDark = contrastRatio(lum, relativeLuminance(DARK_TEXT_HEX))
  return contrastWithWhite >= contrastWithDark ? '#ffffff' : defaultTextColor
}

// 背景 + 两组文字色：渐变现在是「选定颜色 → 白色」，所以左侧（名称/图标区）背景是
// 选定颜色，颜色深浅不定，单独按它的真实对比度判断该用白字还是深色字；右侧（金额区）
// 背景总是接近纯白，深色字最保险，直接用传入的默认文字色。
export function cardStyle(iconKey, defaultColor, defaultTextColor = 'var(--au-text)') {
  const color = resolveSelectedColor(iconKey, defaultColor)
  return {
    background: `linear-gradient(90deg, ${color}, #ffffff)`,
    nameColor: chooseTextColor(color, defaultTextColor),
    valueColor: defaultTextColor,
  }
}