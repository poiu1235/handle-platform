-- ============================================================================
-- pro-manual-unbind.sql · 客服人工解绑模板（7.6 允许的动作之一：搬门钥匙；D-9 补记流水）
--
-- 🔴 单独成文件的原因：它会 **删 user_identities 的行**。只读巡检查询在 pro-ops.sql，
--   两件事不混在一份"顺手整体执行"的脚本里。
--
-- 什么时候用：用户撞了"30 天 3 次"那道上限（identity-unbind.js:18-19 返回 429），
--   客服核实之后替他解绑。**绑**这一步客服代不了——必须他本人在小程序里发起
--   （门禁＝有效 Bearer + 一次性 code）。
--
-- 🔴 核实判据（7.6 末节，锚点即凭证）：**客服会话的 openid ＝ 订单 payer_openid** 才办。
--   不等 ⇒ 不办，指回「请用购买那部微信来发消息」。
--   ⏸ 个人主体能否取到会话 openid 还没证（R-9 ⑭）；取不到才启用 D-20，本轮不许提前实现。
--   🔴 两档都不许退化成"邮箱＋自述"（那等于把 openid 锚的整条防线换成口头声明）。
--
-- ⚠ 三条已知代价（D-9 选 ⓐ「补记流水」而不是 ⓑ「做运维端点」时对价买下的，不是 bug）：
--   1. 这里只删库行，**不撤会话** ⇒ 对方在 access token 剩余有效期内（≤1 小时，4.4 已
--      明文接受这个陈旧窗口）仍能读写。
--   2. ✅ S-7 已判＝给 identity_unbinds 加 `openid` 列 ⇒ 流水自己就记着"解掉了哪个微信"，
--      不再靠人在 note 里手抄一遍（以前删完行，那把门钥匙在库里再无痕迹）。
--      ⚠ 自助路径（identity-unbind.js）要等 B1 补写才会填这一列 ⇒ 在那之前自助解绑的流水
--        openid 仍为 null；人工行走下面这条 insert 直接带上（库约束也这么要求：
--        identity_unbinds_manual_openid_required）。
--   3. 人工那次**不占**用户自己的 30 天额度（D-9a＝不占；靠 identity-unbind.js 里
--      `operator is null` 那个过滤，属 B1 的代码改动）⇒ 正因如此 note 是唯一限速依据。
--      库侧还有一道同向约束：identity_unbinds_manual_note_required
--      （pro-billing.sql 第 0 节）⇒ 即便有人绕过本模板手写 insert，operator 非空而 note 空
--      会被库直接拒（验收 #34）。
--
-- 用法：改下面四个 v_ 值 ⇒ **只选中这一段**执行。原样执行会在第一道门就报错，这是刻意的。
-- ============================================================================

do $$
declare
  v_user uuid := '00000000-0000-0000-0000-000000000000';  -- ← ① 当事人 user_id
  v_prov text := 'wechat_mp';                             -- ← ② provider（V1 只有这一个值）
  v_who  text := '';                                      -- ← ③ 必填：执行客服
  v_note text := '';                                      -- ← ④ 必填：用户主张 + 怎么核实的（openid 由列本身带，不用抄在这里）
begin
  if btrim(coalesce(v_who, '')) = '' then
    raise exception '必须填 v_who：写进 identity_unbinds."operator"，否则这条流水看不出是人工动的';
  end if;

  if btrim(coalesce(v_note, '')) = '' then
    raise exception '必须填 v_note：人工通道不受 30 天上限约束 ⇒ note 是唯一限速依据（D-9a）';
  end if;

  -- 🔴 顺序必须"先记流水、再删行"：openid 只有在删之前才读得到。
  insert into public.identity_unbinds (user_id, provider, openid, "operator", note)
  select i.user_id, i.provider, i.openid, v_who, v_note
  from public.user_identities i
  where i.user_id = v_user and i.provider = v_prov;

  if not found then
    raise exception '账号 % 名下没有 provider=% 的绑定行，什么都没做', v_user, v_prov;
  end if;

  delete from public.user_identities
  where user_id = v_user and provider = v_prov;

  -- 🔴 不撤会话（代价 1）；权益仍挂在被解绑的那个 openid 上（2.1 公理：解绑后该账号判出免费档，
  --   绑回同一个微信即恢复，解绑期间天数照旧流逝、不补）。
  raise notice '已解绑 user=% provider=%；被解绑的 openid 已记进 identity_unbinds.openid；会话未撤销（≤1 小时内对方仍能读写）', v_user, v_prov;
end;
$$;

-- 跑完自查一眼：这条流水必须在，且**不出现**在任何用户可见页面（账户页绑定历史／订单页都不读它）。
select iu.user_id, iu.provider, iu.openid, iu."operator", iu.note, iu.unbound_at
from public.identity_unbinds iu
order by iu.unbound_at desc
limit 5;

-- 反向自查：该账号此刻应当判不出任何微信权益（解绑下一拍就是免费档，无需任何写操作）。
-- 把 v_user 换成同一个 uuid 再跑一次这一段。
select i.user_id, i.provider, i.openid,
       (public.pro_coverage(i.provider, i.openid, 0, now())).is_covered as 该openid仍有权益
from public.user_identities i
where i.user_id = '00000000-0000-0000-0000-000000000000';
