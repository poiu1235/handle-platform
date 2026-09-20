// 通知邮件通道（v1.8 选型：Resend）。
// 为什么是它：Workers 裸 TCP 发不了 SMTP；GoTrue 自带邮件只覆盖认证事务模板，
// 自定义通知（解绑/撤注销/改密告警）从 CF 侧发不出去。HTTP-API 邮件服务里
// Resend 一次 POST 即用、免费档 3k/月与本项目体量匹配、域名 DKIM/SPF 验证
// 自助完成。（备选 Postmark/Brevo 同构可换——调用面收在本文件，替换只动这里。）
//
// 纪律（1.3「基础兜底」口径，通知是尽力而为的安全辅助不是业务关卡）：
//   · 永远 fire-and-forget：主业务已成功后 ctx.waitUntil(sendNotify(...))，
//     未配置 / 超时 / 非 2xx 都只进日志，绝不回滚或阻塞业务；
//   · 日志不落收件地址（PII），只记主题与结果。
//
// 部署：RESEND_API_KEY 走 CF Secret；MAIL_FROM 明文 var
// （如 `Handle Notifications <notify@handle.host>`），发信域名先在 Resend
// 完成 DNS 验证，否则接口返回 422——日志可见，业务不受影响。
const RESEND_API = 'https://api.resend.com/emails'

export async function sendNotify(env, { to, subject, text }) {
  if (!to) return false
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.log(`[mailer] RESEND_API_KEY/MAIL_FROM 未配置，跳过发送: ${subject}`)
    return false
  }
  try {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text }),
    })
    if (!res.ok) {
      console.error(`[mailer] 发送失败 (${res.status}): ${subject}`)
      return false
    }
    return true
  } catch (err) {
    console.error(`[mailer] 发送异常: ${subject}`, err?.message || err)
    return false
  }
}

// 通知文案集中放这里：同一事件的措辞只有一份，端点只决定发不发。
// providerLabel：当前只有「微信」，多端接入后按 provider 传对应名称。
export function notifyTemplates(providerLabel = '微信') {
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  return {
    unbound: {
      subject: '微信绑定已解绑',
      text:
        `你的账号已于 ${when} 解除${providerLabel}小程序绑定。\n\n` +
        `如这不是你的操作，请立即通过「忘记密码」修改密码——解绑时该账号的全部登录会话已被撤销，需要重新登录。`,
    },
    cancelRevoked: {
      subject: '注销申请已撤销',
      text:
        `你的账号已于 ${when} 重新登录，之前发起的注销申请已自动撤销，数据未做任何删除。\n\n` +
        `如果这不是你的操作，请立即修改密码。`,
    },
    passwordChanged: {
      subject: '密码已被修改',
      text:
        `你的账号密码已于 ${when} 修改成功，此前的全部登录会话（包括其他设备）已被撤销，需要重新登录。\n\n` +
        `如果这不是你的操作，请立即再次修改密码并检查${providerLabel}绑定。`,
    },
  }
}
