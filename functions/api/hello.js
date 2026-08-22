// 鉴权（验签 + recovery 拦截）已经在同目录的 _middleware.js 里统一做完，
// 走到这里时 context.data.user 一定是一个正常登录态用户。
export async function onRequestGet(context) {
  const { user } = context.data
  return new Response(JSON.stringify({ message: `hello, ${user.email}`, userId: user.id }), {
    headers: { 'Content-Type': 'application/json' },
  })
}