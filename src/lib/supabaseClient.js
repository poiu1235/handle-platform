import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // 提前暴露配置缺失的问题，而不是等到调用登录接口时才报一个含糊的网络错误
  console.error(
    '缺少 Supabase 配置：请在项目根目录创建 .env.local，并填入 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY（参考 .env.example）'
  )
}

// 邮箱验证 / 密码重置都走验证码（OTP）流程，不再依赖邮件里的可点击链接，
// 所以不需要 flowType/detectSessionInUrl 这些跟"解析 URL 里的链接参数"相关的配置了。
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
  },
})