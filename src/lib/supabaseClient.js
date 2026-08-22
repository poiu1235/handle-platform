import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  // 提前暴露配置缺失的问题，而不是等到调用登录接口时才报一个含糊的网络错误
  console.error(
    '缺少 Supabase 配置：请在项目根目录创建 .env.local，并填入 VITE_SUPABASE_URL 和 VITE_SUPABASE_ANON_KEY（参考 .env.example）'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    flowType: 'pkce',
    autoRefreshToken: true,
    persistSession: true,
    // 邮箱确认/密码重置链接现在直接把 token_hash+type 带到我们自己域名，
    // 由 AuthCallback 在用户手动点击后调用 verifyOtp 完成验证 —— 不再依赖
    // supabase-js 自动解析 URL，避免邮箱客户端预取链接时把一次性 token 提前消耗掉。
    detectSessionInUrl: false,
  },
})