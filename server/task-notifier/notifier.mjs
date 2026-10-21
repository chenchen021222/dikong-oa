/**
 * 禅道任务到期/超时邮件提醒
 *
 * 流程：
 *   1. 读 DiKongOA 本机 SQLite 里的用户列表（username / 姓名 / 已绑定邮箱）
 *   2. 读每个用户在个人中心绑定的禅道账号密码（settings 表，按用户隔离）
 *   3. 逐人登录禅道 REST API，拉取「我的地盘 - 指派给我的任务」
 *   4. 筛出「今天到期」和「已超时」的任务
 *   5. 走内网 SMTP 给本人发一封汇总邮件（两类合并在一封里）
 *
 * 用法：
 *   node --experimental-sqlite notifier.mjs          # 跑一遍
 *   node --experimental-sqlite notifier.mjs --dry    # 只打印不发邮件（调试）
 *
 * 定时：Windows 计划任务 / schtasks 每天固定时间调本脚本即可，脚本跑完即退。
 */

import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf-8'))
const DRY_RUN = process.argv.includes('--dry')

// ---------- 配置 ----------
const ZENTAO_BASE = cfg.zentao.base.replace(/\/$/, '')
const DB_PATH =
  cfg.dbPath ||
  join(process.env.APPDATA ?? '', 'com.dikong.oa', 'dikong.db')

if (!existsSync(DB_PATH)) {
  console.error(`找不到应用数据库：${DB_PATH}`)
  console.error('请确认桌面端至少登录过一次，或在 config.json 中手动指定 dbPath')
  process.exit(1)
}
if (!DRY_RUN && (!cfg.smtp.host || cfg.smtp.host.startsWith('改成'))) {
  console.error('请先在 config.json 中填写 smtp.host（内网邮件服务器地址）')
  process.exit(1)
}

// ---------- 工具 ----------
const CLOSED = new Set(['done', 'closed', 'cancel', '已完成', '已关闭', '已取消'])
const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const TODAY = today()
const isOpen = (t) => !CLOSED.has(t.status ?? '')
const hasDeadline = (t) => t.deadline && t.deadline !== '0000-00-00'
const isDueToday = (t) => isOpen(t) && hasDeadline(t) && t.deadline === TODAY
const isOverdue = (t) => isOpen(t) && hasDeadline(t) && t.deadline < TODAY
const overdueDays = (t) =>
  Math.floor((new Date(TODAY) - new Date(t.deadline)) / 86400000)

async function zentaoLogin(account, password) {
  const res = await fetch(`${ZENTAO_BASE}/api.php/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) {
    throw new Error(data.error ?? `HTTP ${res.status}`)
  }
  return data.token
}

async function fetchMyTasks(token) {
  const res = await fetch(
    `${ZENTAO_BASE}/api.php/v1/user?fields=task&type=assignedTo&limit=200`,
    { headers: { Token: token } },
  )
  const data = await res.json().catch(() => ({}))
  const box = data.task ?? data.tasks ?? data
  if (Array.isArray(box)) return box
  if (Array.isArray(box?.tasks)) return box.tasks
  if (Array.isArray(box?.list)) return box.list
  return []
}

// ---------- 读用户 + 禅道凭据 ----------
const db = new DatabaseSync(DB_PATH, { readOnly: true })

// 老版本数据库可能还没有 email 列（下次启动桌面端会自动迁移补上），这里自适应
const userCols = new Set(
  db.prepare('PRAGMA table_info(users)').all().map((c) => c.name),
)
const users = db
  .prepare(
    `SELECT id, username, display_name, ${userCols.has('email') ? 'email' : "NULL AS email"} FROM users`,
  )
  .all()

// settings 表 key 形如 "u3:zentao_cred"，value 为 {account,password} 的 JSON
// 老库可能没有 settings 表（应用升级后首次启动才建），视为无人绑定
const tableNames = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name),
)
const credRows = tableNames.has('settings')
  ? db.prepare("SELECT key, value FROM settings WHERE key LIKE 'u%:zentao_cred'").all()
  : []
const credByUid = new Map()
for (const r of credRows) {
  const uid = Number(r.key.split(':')[0].slice(1))
  try {
    const v = JSON.parse(r.value || 'null')
    if (v?.account && v?.password) credByUid.set(uid, v)
  } catch { /* 忽略坏数据 */ }
}
db.close()

console.log(`共 ${users.length} 个用户，其中 ${credByUid.size} 个绑定了禅道账号`)

// ---------- 逐人巡检 ----------
// 支持两种模式：内网明文中继（secure:false 无 auth）/ 公网邮箱（如 QQ：465 SSL + 授权码）
const mailer = nodemailer.createTransport({
  host: cfg.smtp.host,
  port: cfg.smtp.port ?? 25,
  secure: !!cfg.smtp.secure,
  ignoreTLS: !cfg.smtp.secure && !cfg.smtp.user,
  auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
})

const PRI_TEXT = { 1: '紧急', 2: '高', 3: '中', 4: '低' }

function taskRow(t, extra = '') {
  const link = `${ZENTAO_BASE}/index.php?m=task&f=view&taskID=${t.id}`
  const pri = PRI_TEXT[t.pri] ?? (t.pri ?? '')
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">#${t.id}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${link}">${t.name ?? ''}</a></td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${pri}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${t.status ?? ''}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${t.deadline ?? ''}</td>
    ${extra}
  </tr>`
}

function buildMail(displayName, dueToday, overdue) {
  const head =
    '<tr><th style="text-align:left;padding:6px 10px;background:#f5f7fa">ID</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">任务</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">优先级</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">状态</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">截止</th>'

  let html = `<p>${displayName} 你好，你在禅道上有以下任务需要关注（${TODAY}）：</p>`
  if (overdue.length) {
    html += `<h3 style="color:#F54A45">超时任务（${overdue.length}）</h3>
      <table style="border-collapse:collapse;font-size:13px">${head}<th style="text-align:left;padding:6px 10px;background:#f5f7fa">已超时</th></tr>
      ${overdue.map((t) => taskRow(t, `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#F54A45">${overdueDays(t)} 天</td>`)).join('')}
      </table>`
  }
  if (dueToday.length) {
    html += `<h3 style="color:#FF8800">今日到期（${dueToday.length}）</h3>
      <table style="border-collapse:collapse;font-size:13px">${head}</tr>
      ${dueToday.map((t) => taskRow(t)).join('')}
      </table>`
  }
  html += `<p style="color:#999;font-size:12px">— DiKongOA 自动提醒，请勿回复</p>`
  return html
}

// --test [收件人]：绕过用户扫描，直接发一封示例提醒验证 SMTP 链路
if (DRY_RUN === false && process.argv.includes('--test')) {
  const idx = process.argv.indexOf('--test')
  const to = process.argv[idx + 1] && !process.argv[idx + 1].startsWith('-')
    ? process.argv[idx + 1]
    : cfg.smtp.user || cfg.smtp.from
  const demoOverdue = [{ id: 0, name: '【示例】已超时的任务', pri: 1, status: 'doing', deadline: '2026-10-19' }]
  const demoToday = [{ id: 0, name: '【示例】今天到期的任务', pri: 2, status: 'wait', deadline: TODAY }]
  const html = buildMail('测试用户', demoToday, demoOverdue)
  await mailer.sendMail({
    from: cfg.smtp.from,
    to,
    subject: `[禅道提醒-测试] 今日到期 1 项 / 超时 1 项`,
    html,
  })
  console.log(`测试邮件已发送到 ${to}`)
  process.exit(0)
}

let sent = 0
let skipped = 0
let failed = 0

for (const u of users) {
  const name = u.display_name || u.username
  const cred = credByUid.get(u.id)

  if (!cred) {
    console.log(`- ${name}：未绑定禅道账号，跳过`)
    skipped++
    continue
  }
  if (!u.email) {
    console.log(`- ${name}：未绑定邮箱，跳过`)
    skipped++
    continue
  }

  try {
    const token = await zentaoLogin(cred.account, cred.password)
    const tasks = await fetchMyTasks(token)
    const dueToday = tasks.filter(isDueToday)
    const overdue = tasks.filter(isOverdue)

    if (!dueToday.length && !overdue.length && !cfg.sendEmpty) {
      console.log(`- ${name}：无到期/超时任务`)
      skipped++
      continue
    }

    const subject = `[禅道提醒] 今日到期 ${dueToday.length} 项 / 超时 ${overdue.length} 项`
    const html = buildMail(name, dueToday, overdue)

    if (DRY_RUN) {
      console.log(`· ${name} <${u.email}> ${subject}`)
      overdue.forEach((t) => console.log(`    [超时${overdueDays(t)}天] #${t.id} ${t.name} 截止${t.deadline}`))
      dueToday.forEach((t) => console.log(`    [今日到期] #${t.id} ${t.name}`))
      continue
    }

    await mailer.sendMail({ from: cfg.smtp.from, to: u.email, subject, html })
    console.log(`+ ${name} <${u.email}>：已发送（到期 ${dueToday.length} / 超时 ${overdue.length}）`)
    sent++
  } catch (e) {
    console.error(`x ${name}：${e.message}`)
    failed++
  }
}

console.log(`完成：发送 ${sent} 封，跳过 ${skipped} 人，失败 ${failed} 人`)
process.exit(failed ? 2 : 0)
