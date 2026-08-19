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
    // SPA 场景：邮件确认链接会把 code 带在 URL query 里，交给 supabase-js 自动处理并落地到 session
    flowType: 'pkce',
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
})
