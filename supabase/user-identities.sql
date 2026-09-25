-- user_identities（PRD D3 3.3.2）：微信身份 ↔ Supabase 账号映射。
-- 本期唯一的库表变更；手动在 Supabase Dashboard SQL Editor 执行。
--
-- 安全设计：启用 RLS 但不创建任何 policy——anon / authenticated 一律拒，
-- 读写只经服务端（service_role）发生。用户不能自助改绑定，
-- 绑定必须走「有效登录态 + 一次性 wx.login code」的服务端流程
-- （functions/auth/wechat-bind.js），S2 小微 AI 的身份链路复用同一张表。

create table if not exists public.user_identities (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  provider   text not null default 'wechat_mp',
  openid     text not null,
  unionid    text,
  bound_at   timestamptz not null default now(),
  unique (provider, openid),   -- 一个微信身份只能对应一个账号
  unique (user_id, provider)   -- 一个账号在一个小程序里只有一个 openid
);

alter table public.user_identities enable row level security;

-- 不创建任何 policy：anon/authenticated 一律拒，读写只经服务端（service_role）。
-- 用户不能自助改绑定，绑定必须走「有效登录态 + 一次性 code」的服务端流程。
