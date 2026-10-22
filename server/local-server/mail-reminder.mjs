/**
 * 禅道任务邮件提醒。
 * 收件人、时间和自动/手动由管理员在系统设置里保存，存在 settings.sys:mail_reminder。
 * 发信账号只读服务器上的 mail.json，不进入页面，也不写入数据库。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import nodemailer from 'nodemailer'
import { exec, queryAll } from './db-api.mjs'

const SETTINGS_KEY = 'sys:mail_reminder'
const ZENTAO_FALLBACK = 'http://172.24.7.129:31225'
const CLOSED = new Set(['done', 'closed', 'cancel', '已完成', '已关闭', '已取消'])
const PRI_TEXT = { 1: '紧急', 2: '高', 3: '中', 4: '低' }

let sending = false
let schedulerStarted = false

export function mailConfigPath() {
  if (process.env.DIKONG_MAIL_CONFIG) return process.env.DIKONG_MAIL_CONFIG
  const beside = join(dirname(fileURLToPath(import.meta.url)), '../task-notifier/config.json')
  return existsSync(beside) ? beside : '/opt/dikong-oa/mail.json'
}

function loadConfig() {
  const path = mailConfigPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function smtpReady(cfg = loadConfig()) {
  const host = cfg?.smtp?.host ?? ''
  return Boolean(host && !host.startsWith('改成') && cfg?.smtp?.user && cfg?.smtp?.pass)
}

function zentaoBase(cfg) {
  const raw = String(cfg?.zentao?.base ?? '')
  if (/^https?:\/\//.test(raw) && !raw.includes('你的禅道')) return raw.replace(/\/$/, '')
  return ZENTAO_FALLBACK
}

export function shanghaiNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const hour = parts.hour === '24' ? '00' : String(parts.hour).padStart(2, '0')
  const minute = String(parts.minute).padStart(2, '0')
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hm: `${hour}:${minute}`,
    weekday: parts.weekday,
  }
}

function bad(message) {
  const err = new Error(message)
  err.code = 400
  throw err
}

function normalizeTime(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return ''
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return ''
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

async function readRaw() {
  const rows = await queryAll('SELECT `value` FROM settings WHERE `key` = ?', [SETTINGS_KEY])
  if (!rows.length || !rows[0].value) return {}
  try {
    const parsed = JSON.parse(rows[0].value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function applyDefaults(raw) {
  const time = normalizeTime(raw.time) || '09:00'
  return {
    mode: raw.mode === 'auto' ? 'auto' : 'manual',
    time,
    weekdaysOnly: raw.weekdaysOnly !== false,
    includeOverdue: raw.includeOverdue !== false,
    includeDueToday: raw.includeDueToday !== false,
    sendEmpty: raw.sendEmpty === true,
    userIds: [...new Set((Array.isArray(raw.userIds) ? raw.userIds : []).map(Number).filter((id) => id > 0))],
    lastAutoDate: typeof raw.lastAutoDate === 'string' ? raw.lastAutoDate : '',
    lastResult: raw.lastResult && typeof raw.lastResult === 'object' ? raw.lastResult : null,
  }
}

async function writeRaw(settings) {
  await exec(
    'REPLACE INTO settings (`key`, `value`) VALUES (?, ?)',
    [SETTINGS_KEY, JSON.stringify(settings)],
  )
}

async function listUsers() {
  const users = await queryAll(
    'SELECT id, username, display_name, email FROM users ORDER BY id',
  )
  const creds = await queryAll(
    "SELECT `key`, `value` FROM settings WHERE `key` LIKE 'u%:zentao_cred'",
  )
  const bound = new Set()
  const credByUid = new Map()
  for (const row of creds) {
    const uid = Number(String(row.key).split(':')[0].slice(1))
    try {
      const value = JSON.parse(row.value || 'null')
      if (value?.account && value?.password) {
        bound.add(Number(uid))
        credByUid.set(Number(uid), value)
      }
    } catch { /* 忽略坏数据 */ }
  }
  return {
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      zentaoBound: bound.has(Number(user.id)),
    })),
    credByUid,
  }
}

export async function getMailView() {
  const settings = applyDefaults(await readRaw())
  const { users } = await listUsers()
  const cfg = loadConfig()
  const known = new Set(users.map((user) => user.id))
  return {
    mode: settings.mode,
    time: settings.time,
    weekdaysOnly: settings.weekdaysOnly,
    includeOverdue: settings.includeOverdue,
    includeDueToday: settings.includeDueToday,
    sendEmpty: settings.sendEmpty,
    userIds: settings.userIds.filter((id) => known.has(id)),
    smtpReady: smtpReady(cfg),
    smtpFrom: cfg?.smtp?.from || cfg?.smtp?.user || '',
    sending,
    lastAutoDate: settings.lastAutoDate,
    lastResult: settings.lastResult,
    users,
  }
}

function minutes(hm) {
  const [hour, minute] = hm.split(':').map(Number)
  return hour * 60 + minute
}

/** 自动发送：到达设定时间后的 3 小时内发一次；今天已经发过或刚过点才保存，则不再补发。 */
export function shouldAutoSend(settings, now = shanghaiNow()) {
  if (settings.mode !== 'auto' || !settings.userIds.length) return false
  if (settings.weekdaysOnly && (now.weekday === 'Sat' || now.weekday === 'Sun')) return false
  if (settings.lastAutoDate === now.date) return false
  const late = minutes(now.hm) - minutes(settings.time)
  return late >= 0 && late <= 180
}

export async function saveMailSettings(input) {
  const time = normalizeTime(input.time)
  if (!time) bad('请填写发送时间，格式为 HH:mm')
  const includeOverdue = input.includeOverdue !== false
  const includeDueToday = input.includeDueToday !== false
  if (!includeOverdue && !includeDueToday) bad('请至少选择一种提醒内容')
  const { users } = await listUsers()
  const known = new Set(users.map((user) => user.id))
  const userIds = [...new Set((input.userIds ?? []).map(Number))].filter((id) => known.has(id))
  const current = applyDefaults(await readRaw())
  const now = shanghaiNow()
  const mode = input.mode === 'auto' ? 'auto' : 'manual'
  await writeRaw({
    ...current,
    mode,
    time,
    weekdaysOnly: input.weekdaysOnly !== false,
    includeOverdue,
    includeDueToday,
    sendEmpty: input.sendEmpty === true,
    userIds,
    lastAutoDate: mode === 'auto' && now.hm >= time ? now.date : current.lastAutoDate,
  })
}

function todayStamp() {
  const now = shanghaiNow()
  return `${now.date} ${now.hm}`
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]))
}

function taskRow(base, task, extra = '') {
  const link = `${base}/index.php?m=task&f=view&taskID=${Number(task.id) || 0}`
  const pri = PRI_TEXT[task.pri] ?? (task.pri ?? '')
  return `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">#${Number(task.id) || 0}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${link}">${escapeHtml(task.name)}</a></td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(pri)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(task.status)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml(task.deadline)}</td>
    ${extra}
  </tr>`
}

function buildMail(displayName, date, dueToday, overdue, base) {
  const head =
    '<tr><th style="text-align:left;padding:6px 10px;background:#f5f7fa">ID</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">任务</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">优先级</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">状态</th>' +
    '<th style="text-align:left;padding:6px 10px;background:#f5f7fa">截止</th>'
  let html = `<p>${escapeHtml(displayName)} 你好，你在禅道上有以下任务需要关注（${date}）：</p>`
  if (!dueToday.length && !overdue.length) {
    html += '<p>今天没有到期或超时的任务。</p>'
  }
  if (overdue.length) {
    html += `<h3 style="color:#F54A45">超时任务（${overdue.length}）</h3>
      <table style="border-collapse:collapse;font-size:13px">${head}<th style="text-align:left;padding:6px 10px;background:#f5f7fa">已超时</th></tr>
      ${overdue.map((task) => taskRow(base, task, `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:#F54A45">${overdueDays(task, date)} 天</td>`)).join('')}
      </table>`
  }
  if (dueToday.length) {
    html += `<h3 style="color:#FF8800">今日到期（${dueToday.length}）</h3>
      <table style="border-collapse:collapse;font-size:13px">${head}</tr>
      ${dueToday.map((task) => taskRow(base, task)).join('')}
      </table>`
  }
  html += '<p style="color:#999;font-size:12px">— DiKongOA 自动提醒，请勿回复</p>'
  return html
}

function isOpen(task) {
  return !CLOSED.has(task.status ?? '')
}
function hasDeadline(task) {
  return task.deadline && task.deadline !== '0000-00-00'
}
function overdueDays(task, date) {
  return Math.floor((new Date(date) - new Date(task.deadline)) / 86400000)
}

async function zentaoLogin(base, account, password) {
  const res = await fetch(`${base}/api.php/v1/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password }),
    signal: AbortSignal.timeout(15000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.token) throw new Error(data.error ?? `禅道登录失败 HTTP ${res.status}`)
  return data.token
}

async function fetchMyTasks(base, token) {
  const res = await fetch(
    `${base}/api.php/v1/user?fields=task&type=assignedTo&limit=200`,
    { headers: { Token: token }, signal: AbortSignal.timeout(20000) },
  )
  const data = await res.json().catch(() => ({}))
  const box = data.task ?? data.tasks ?? data
  if (Array.isArray(box)) return box
  if (Array.isArray(box?.tasks)) return box.tasks
  if (Array.isArray(box?.list)) return box.list
  return []
}

function createTransport(cfg) {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port ?? 25,
    secure: !!cfg.smtp.secure,
    ignoreTLS: !cfg.smtp.secure && !cfg.smtp.user,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
  })
}

export async function sendTestMail(to) {
  const cfg = loadConfig()
  if (!smtpReady(cfg)) bad('邮件服务器尚未配置')
  const recipient = to || cfg.smtp.user || cfg.smtp.from
  const date = shanghaiNow().date
  const html = buildMail(
    '测试用户',
    date,
    [{ id: 0, name: '【示例】今天到期的任务', pri: 2, status: 'wait', deadline: date }],
    [{ id: 0, name: '【示例】已超时的任务', pri: 1, status: 'doing', deadline: '2026-10-19' }],
    zentaoBase(cfg),
  )
  await createTransport(cfg).sendMail({
    from: cfg.smtp.from,
    to: recipient,
    subject: '[禅道提醒-测试] 今日到期 1 项 / 超时 1 项',
    html,
  })
  return recipient
}

export async function sendReminders({ trigger = 'manual', dry = false } = {}) {
  if (sending) {
    const err = new Error('正在发送，请稍后再试')
    err.code = 409
    throw err
  }
  const cfg = loadConfig()
  if (!dry && !smtpReady(cfg)) bad('邮件服务器尚未配置，暂时无法发信')
  const settings = applyDefaults(await readRaw())
  if (!settings.userIds.length) bad('请先选择收件人并保存')
  if (!settings.includeOverdue && !settings.includeDueToday) bad('请至少选择一种提醒内容')

  sending = true
  const lines = []
  let sent = 0
  let skipped = 0
  let failed = 0
  try {
    const date = shanghaiNow().date
    const base = zentaoBase(cfg)
    const { users, credByUid } = await listUsers()
    const picked = new Set(settings.userIds)
    const targets = users.filter((user) => picked.has(user.id))
    const mailer = !dry && smtpReady(cfg) ? createTransport(cfg) : null

    for (const user of targets) {
      const name = user.display_name || user.username
      const email = String(user.email ?? '').trim()
      const cred = credByUid.get(Number(user.id))
      if (!cred) {
        lines.push({ name, email, status: 'skipped', detail: '未绑定禅道账号' })
        skipped++
        continue
      }
      if (!email) {
        lines.push({ name, email, status: 'skipped', detail: '未填写邮箱' })
        skipped++
        continue
      }
      try {
        const token = await zentaoLogin(base, cred.account, cred.password)
        const tasks = await fetchMyTasks(base, token)
        const dueToday = settings.includeDueToday
          ? tasks.filter((task) => isOpen(task) && hasDeadline(task) && task.deadline === date)
          : []
        const overdue = settings.includeOverdue
          ? tasks.filter((task) => isOpen(task) && hasDeadline(task) && task.deadline < date)
          : []
        if (!dueToday.length && !overdue.length && !settings.sendEmpty) {
          lines.push({ name, email, status: 'skipped', detail: '没有到期或超时任务' })
          skipped++
          continue
        }
        const parts = []
        if (settings.includeDueToday) parts.push(`今日到期 ${dueToday.length} 项`)
        if (settings.includeOverdue) parts.push(`超时 ${overdue.length} 项`)
        const subject = `[禅道提醒] ${parts.join(' / ')}`
        const html = buildMail(name, date, dueToday, overdue, base)
        if (dry) {
          lines.push({ name, email, status: 'sent', detail: `试运行，未真正发送（${parts.join(' / ')}）` })
          sent++
          continue
        }
        await mailer.sendMail({ from: cfg.smtp.from, to: email, subject, html })
        lines.push({ name, email, status: 'sent', detail: parts.join(' / ') })
        sent++
        console.log(`MAIL ${trigger} ${name} 已发送`)
      } catch (error) {
        lines.push({ name, email, status: 'failed', detail: error.message || '发送失败' })
        failed++
        console.error(`MAIL ${trigger} ${name} ${error.message}`)
      }
    }

    const lastResult = { at: todayStamp(), trigger, sent, skipped, failed, lines }
    if (!dry) {
      const latest = applyDefaults(await readRaw())
      await writeRaw({
        ...latest,
        lastResult,
        lastAutoDate: trigger === 'auto' ? date : latest.lastAutoDate,
      })
    }
    return lastResult
  } finally {
    sending = false
  }
}

async function tick() {
  if (sending) return
  const settings = applyDefaults(await readRaw())
  if (!smtpReady() || !shouldAutoSend(settings)) return
  const now = shanghaiNow()
  console.log(`MAIL 到达自动发送时间 ${now.date} ${settings.time}`)
  await sendReminders({ trigger: 'auto' })
}

export function startMailScheduler() {
  if (schedulerStarted) return
  schedulerStarted = true
  const run = () => {
    tick().catch((error) => console.error(`MAIL ${error.message}`))
  }
  setTimeout(run, 8000)
  setInterval(run, 30000)
}
