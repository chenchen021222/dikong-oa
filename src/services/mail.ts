import { webDb } from './auth'

export interface MailUser {
  id: number
  username: string
  display_name: string | null
  email: string | null
  zentaoBound: boolean
}

export interface MailLine {
  name: string
  email: string
  status: 'sent' | 'skipped' | 'failed'
  detail: string
}

export interface MailResult {
  at: string
  trigger: 'auto' | 'manual'
  sent: number
  skipped: number
  failed: number
  lines: MailLine[]
}

export interface MailSettings {
  mode: 'auto' | 'manual'
  time: string
  weekdaysOnly: boolean
  includeOverdue: boolean
  includeDueToday: boolean
  sendEmpty: boolean
  userIds: number[]
  smtpReady: boolean
  smtpFrom: string
  sending: boolean
  lastAutoDate: string
  lastResult: MailResult | null
  users: MailUser[]
}

export interface MailDraft {
  mode: 'auto' | 'manual'
  time: string
  weekdaysOnly: boolean
  includeOverdue: boolean
  includeDueToday: boolean
  sendEmpty: boolean
  userIds: number[]
}

function withToken(token: string, path: string) {
  return `${path}?token=${encodeURIComponent(token)}`
}

export function getMailSettings(token: string) {
  return webDb<MailSettings>(withToken(token, '/admin/mail'))
}

export function saveMailSettings(token: string, draft: MailDraft) {
  return webDb<MailSettings>('/admin/mail', { token, ...draft })
}

export function sendMailNow(token: string) {
  return webDb<MailSettings>('/admin/mail/send', { token }, 120000)
}
