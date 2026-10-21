import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getProvider } from '@/config/auth'
import {
  SESSION_KEY,
  changeLocalPassword,
  fetchUserinfo,
  localLogin,
  localLogout,
  refreshTokens,
  startLogin,
  updateLocalEmail,
  updateLocalPhone,
  updateLocalProfile,
  type Session,
} from '@/services/auth'

export const useAuthStore = defineStore('auth', () => {
  const session = ref<Session | null>(null)
  const loggingIn = ref(false)
  const error = ref<string | null>(null)

  const isAuthenticated = computed(() => {
    const s = session.value
    if (!s) return false
    // 有过期时间且已过期、又没有 refresh_token 时视为未登录
    if (s.tokens.expires_at && s.tokens.expires_at < Date.now() && !s.tokens.refresh_token) {
      return false
    }
    return true
  })

  const displayName = computed(() => {
    const u = session.value?.user
    return (u?.name ?? u?.preferred_username ?? u?.nickname ?? u?.sub ?? '用户') as string
  })

  function restore() {
    const raw = localStorage.getItem(SESSION_KEY)
    session.value = raw ? JSON.parse(raw) : null
  }

  async function login(providerId: string) {
    const provider = getProvider(providerId)
    if (!provider) throw new Error(`未知的登录方式: ${providerId}`)
    loggingIn.value = true
    error.value = null
    try {
      await startLogin(provider)
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      loggingIn.value = false
    }
  }

  async function loginLocal(username: string, password: string): Promise<boolean> {
    loggingIn.value = true
    error.value = null
    try {
      session.value = await localLogin(username, password)
      return true
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return false
    } finally {
      loggingIn.value = false
    }
  }

  function onLoginResult(s: Session | null, err?: Error) {
    loggingIn.value = false
    if (s) {
      session.value = s
      error.value = null
    } else {
      error.value = err?.message ?? '登录失败'
    }
  }

  /** 主动刷新 access token（在调用业务 API 前使用） */
  async function ensureFreshToken(): Promise<string | null> {
    const s = session.value
    if (!s) return null
    if (!s.tokens.expires_at || s.tokens.expires_at > Date.now() + 30_000) {
      return s.tokens.access_token
    }
    if (!s.tokens.refresh_token) return null

    const provider = getProvider(s.providerId)
    if (!provider) return null
    const tokens = await refreshTokens(provider, s.tokens.refresh_token)
    const user = await fetchUserinfo(provider, tokens.access_token).catch(() => s.user)
    session.value = { ...s, tokens, user }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session.value))
    return tokens.access_token
  }

  /** 更新显示名：写回会话并持久化（本地账号同步写 SQLite） */
  async function updateDisplayName(name: string): Promise<void> {
    const s = session.value
    if (!s) return
    if (s.providerId === 'local') await updateLocalProfile(s.tokens.access_token, name)
    session.value = { ...s, user: { ...(s.user ?? {}), name } }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session.value))
  }

  /** 更新手机号 */
  async function updatePhone(phone: string): Promise<void> {
    const s = session.value
    if (!s) return
    if (s.providerId === 'local') await updateLocalPhone(s.tokens.access_token, phone)
    session.value = { ...s, user: { ...(s.user ?? {}), phone } }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session.value))
  }

  /** 更新邮箱 */
  async function updateEmail(email: string): Promise<void> {
    const s = session.value
    if (!s) return
    if (s.providerId === 'local') await updateLocalEmail(s.tokens.access_token, email)
    session.value = { ...s, user: { ...(s.user ?? {}), email } }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session.value))
  }

  /** 资料是否已完善（本地账号要求绑定手机号 + 邮箱） */
  const isProfileComplete = computed(
    () => !!session.value?.user?.phone && !!session.value?.user?.email,
  )

  /** 修改本地账号密码 */
  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const s = session.value
    if (!s || s.providerId !== 'local') throw new Error('当前登录方式不支持修改密码')
    await changeLocalPassword(s.tokens.access_token, oldPassword, newPassword)
  }

  function logout() {
    if (session.value?.providerId === 'local') {
      localLogout(session.value.tokens.access_token)
    }
    session.value = null
    error.value = null
    localStorage.removeItem(SESSION_KEY)
  }

  return {
    session,
    loggingIn,
    error,
    isAuthenticated,
    displayName,
    restore,
    login,
    loginLocal,
    onLoginResult,
    ensureFreshToken,
    updateDisplayName,
    updatePhone,
    updateEmail,
    isProfileComplete,
    changePassword,
    logout,
  }
})
