import { webDb } from './auth'

export interface AccountRow {
  id: number
  username: string
  display_name: string | null
  phone: string | null
  email: string | null
  role: 'admin' | 'user'
  created_at: string
}

function withToken(token: string, path: string) {
  return `${path}?token=${encodeURIComponent(token)}`
}

export function listAccounts(token: string) {
  return webDb<AccountRow[]>(withToken(token, '/admin/users'))
}

export function createAccount(
  token: string,
  body: {
    username: string
    password: string
    displayName: string
    phone: string
    email: string
    role: 'admin' | 'user'
  },
) {
  return webDb<AccountRow>('/admin/users', { token, ...body })
}

export function updateAccount(
  token: string,
  body: {
    id: number
    displayName: string
    phone: string
    email: string
    role: 'admin' | 'user'
    password?: string
  },
) {
  return webDb<AccountRow>('/admin/users/update', { token, ...body })
}

export function deleteAccount(token: string, id: number) {
  return webDb<null>('/admin/users/delete', { token, id })
}
