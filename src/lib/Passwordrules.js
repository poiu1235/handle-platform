// 密码复杂度规则。必须跟 Supabase Dashboard → Authentication → Policies
// 里配置的密码策略保持一致：最短 8 位，且同时包含小写字母、大写字母、数字、符号。
// 这里的校验只是前端第一道拦截，真正兜底的是 Supabase 服务端策略。
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/

export function isPasswordValid(password) {
  return PASSWORD_REGEX.test(password)
}

export function passwordHint() {
  return '密码至少 8 位，需同时包含大写字母、小写字母、数字和符号'
}