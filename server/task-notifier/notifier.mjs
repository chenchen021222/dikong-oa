/**
 * 命令行补发。日常定时由服务器上的数据服务按系统设置执行，不要再另建计划任务。
 *
 *   node notifier.mjs            # 按已保存的收件人立即发送
 *   node notifier.mjs --dry      # 只打印，不发信，也不改上次发送记录
 *   node notifier.mjs --test [邮箱]
 */
import { sendReminders, sendTestMail } from '../local-server/mail-reminder.mjs'

if (process.argv.includes('--test')) {
  const index = process.argv.indexOf('--test')
  const to = process.argv[index + 1] && !process.argv[index + 1].startsWith('-')
    ? process.argv[index + 1]
    : undefined
  const recipient = await sendTestMail(to)
  console.log(`测试邮件已发送到 ${recipient}`)
  process.exit(0)
}

try {
  const result = await sendReminders({ trigger: 'manual', dry: process.argv.includes('--dry') })
  console.log(`完成：发送 ${result.sent} 封，跳过 ${result.skipped} 人，失败 ${result.failed} 人`)
  for (const line of result.lines) console.log(`- ${line.name} ${line.status} ${line.detail}`)
  process.exit(result.failed ? 2 : 0)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
