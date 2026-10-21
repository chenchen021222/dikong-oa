import { invoke } from '@tauri-apps/api/core'
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { open } from '@tauri-apps/plugin-shell'
import { DESKTOP_SCHEME, getProvider, type AuthProvider } from '@/config/auth'
import { DATA_API_BASE } from '@/config/server'
import { pkceChallenge, randomState, randomString } from './pkce'

/** 是否运行在 Tauri 桌面壳内 */
export const isTauri = '__TAURI_INTERNALS__' in window

const PENDING_KEY = 'oauth:pending'
export const SESSION_KEY = 'oauth:session'

export interface TokenSet {
  access_token: string
  id_token?: string
  refresh_token?: string
  /** 过期时间戳（ms） */
  expires_at?: number
}

export interface Session {
  providerId: string
  tokens: TokenSet
  user?: Record<string, unknown>
}

interface PendingLogin {
  providerId: string
  state: string
  verifier: string
}

/** 桌面端走自定义协议回跳，浏览器端回到本站 /auth/callback 路由 */
export function redirectUri(): string {
  return isTauri ? `${DESKTOP_SCHEME}://auth/callback` : `${location.origin}/auth/callback`
}

function buildAuthorizeUrl(provider: AuthProvider, state: string, challenge: string): string {
  const url = new URL(provider.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', provider.clientId)
  url.searchParams.set('redirect_uri', redirectUri())
  url.searchParams.set('scope', provider.scopes.join(' '))
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  for (const [k, v] of Object.entries(provider.extraAuthorizeParams ?? {})) {
    url.searchParams.set(k, v)
  }
  return url.toString()
}

/** 发起登录：桌面端拉起系统浏览器，Web 端整页跳转 */
export async function startLogin(provider: AuthProvider): Promise<void> {
  const pending: PendingLogin = {
    providerId: provider.id,
    state: randomState(),
    verifier: randomString(64),
  }
  const challenge = await pkceChallenge(pending.verifier)
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending))

  const url = buildAuthorizeUrl(provider, pending.state, challenge)
  if (isTauri) await open(url)
  else location.assign(url)
}

export async function exchangeCode(
  provider: AuthProvider,
  code: string,
  verifier: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    client_id: provider.clientId,
    code_verifier: verifier,
  })
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`换取 token 失败: ${res.status} ${await res.text()}`)

  const data = await res.json()
  return {
    access_token: data.access_token,
    id_token: data.id_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  }
}

export async function refreshTokens(provider: AuthProvider, refreshToken: string): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: provider.clientId,
  })
  const res = await fetch(provider.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`刷新 token 失败: ${res.status}`)

  const data = await res.json()
  return {
    access_token: data.access_token,
    id_token: data.id_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  }
}

export async function fetchUserinfo(
  provider: AuthProvider,
  accessToken: string,
): Promise<Record<string, unknown> | undefined> {
  if (!provider.userinfoUrl) return undefined
  const res = await fetch(provider.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return res.ok ? res.json() : undefined
}

interface LocalLoginResult {
  token: string
  username: string
  display_name: string | null
  phone?: string | null
  email?: string | null
}

function toLocalSession(res: LocalLoginResult): Session {
  return {
    providerId: 'local',
    tokens: {
      access_token: res.token,
      expires_at: Date.now() + 7 * 24 * 3600 * 1000, // 本地会话 7 天
    },
    user: {
      name: res.display_name ?? res.username,
      username: res.username,
      phone: res.phone ?? '',
      email: res.email ?? '',
    },
  }
}

/**
 * 数据接口统一入口。
 * - 配了 DATA_API_BASE（打包给别人）：走你电脑上的局域网数据服务
 * - 否则：Web 开发走 vite 中间件 /local-db；桌面端走 Tauri invoke 读本机库
 */
/** Web 开发预览优先用同源 vite 中间件（免起面板）；打包/Tauri 走配置的远程地址 */
/** 开发调试用 vite 中间件（同机 SQLite），生产打包统一连远程服务器 */
const API_PREFIX =
  import.meta.env.DEV && !isTauri ? '/local-db' : `${DATA_API_BASE}/local-db`

/** 是否使用远程数据服务（生产打包时为 true） */
export const useRemoteDb = !API_PREFIX.startsWith('/')

export async function webDb<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    throw new Error(
      useRemoteDb
        ? '无法连接数据服务器，请联系管理员确认服务已启动'
        : '本地数据接口不可用，请重启开发服务',
    )
  }
  const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string }
  if (!res.ok) throw new Error(json.error ?? `请求失败: ${res.status}`)
  return json.data as T
}

/** 本地账号密码登录：桌面端走 SQLite + bcrypt 校验 */
export async function localLogin(username: string, password: string): Promise<Session> {
  const res =
    isTauri && !useRemoteDb
      ? await invoke<LocalLoginResult>('local_login', { username, password })
      : await webDb<LocalLoginResult>('/login', { username, password })
  const session = toLocalSession(res)
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return session
}

/** 本地登出：删除数据库中的会话记录 */
export async function localLogout(token: string): Promise<void> {
  if (isTauri && !useRemoteDb) await invoke('local_logout', { token }).catch(() => {})
  else await webDb('/logout', { token }).catch(() => {})
}

/** 更新本地账号的显示名 */
export async function updateLocalProfile(token: string, displayName: string): Promise<void> {
  if (isTauri && !useRemoteDb) await invoke('update_display_name', { token, displayName })
  else await webDb('/user', { token, displayName })
}

/** 更新本地账号手机号 */
export async function updateLocalPhone(token: string, phone: string): Promise<void> {
  if (isTauri && !useRemoteDb) await invoke('update_phone', { token, phone })
  else await webDb('/user', { token, phone })
}

/** 更新本地账号邮箱 */
export async function updateLocalEmail(token: string, email: string): Promise<void> {
  if (isTauri && !useRemoteDb) await invoke('update_email', { token, email })
  else await webDb('/user', { token, email })
}

/** 本地账号修改密码 */
export async function changeLocalPassword(
  token: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  if (isTauri && !useRemoteDb) await invoke('change_password', { token, oldPassword, newPassword })
  else await webDb('/password', { token, oldPassword, newPassword })
}

/**
 * 处理 IdP 回跳 URL（两种形态都支持）：
 * - 桌面端:  dikong://auth/callback?code=...&state=...
 * - Web 端:  https://host/auth/callback?code=...&state=...
 * 成功返回 Session，失败抛错。
 */
export async function completeLogin(callbackUrl: string): Promise<Session> {
  const url = new URL(callbackUrl)
  const error = url.searchParams.get('error')
  if (error) throw new Error(url.searchParams.get('error_description') ?? error)

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code) throw new Error('回调缺少 code 参数')

  const raw = localStorage.getItem(PENDING_KEY)
  localStorage.removeItem(PENDING_KEY)
  const pending: PendingLogin | null = raw ? JSON.parse(raw) : null
  if (!pending || pending.state !== state) throw new Error('state 校验失败，可能存在 CSRF 风险')

  const provider = getProvider(pending.providerId)
  if (!provider) throw new Error(`未知的登录方式: ${pending.providerId}`)

  const tokens = await exchangeCode(provider, code, pending.verifier)
  const user = await fetchUserinfo(provider, tokens.access_token).catch(() => undefined)

  const session: Session = { providerId: provider.id, tokens, user }
  localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  return session
}

/**
 * 桌面端深链监听：冷启动处理 getCurrent，热启动处理 onOpenUrl。
 * onResult 用于拿到结果后跳转页面。
 */
export async function initDesktopAuth(
  onResult: (session: Session | null, error?: Error) => void,
): Promise<() => void> {
  const handle = async (urls: string[] | null) => {
    for (const u of urls ?? []) {
      if (!u.startsWith(`${DESKTOP_SCHEME}://auth/`)) continue
      try {
        onResult(await completeLogin(u))
      } catch (e) {
        onResult(null, e instanceof Error ? e : new Error(String(e)))
      }
    }
  }

  await handle(await getCurrent().catch(() => null))
  return onOpenUrl(handle)
}
