/**
 * SSO / OAuth2 Provider 配置
 *
 * 新增一种登录方式 = 在这里加一条配置，无需改代码。
 * 所有 provider 走标准 OAuth2 Authorization Code + PKCE 流程。
 *
 * 常见端点示例：
 * - Keycloak:  {issuer}/protocol/openid-connect/auth | /token | /userinfo
 * - Casdoor:   {host}/login/oauth/authorize          | {host}/api/login/oauth/access_token | {host}/api/userinfo
 * - Authing:   {host}/oidc/auth                      | {host}/oidc/token                  | {host}/oidc/me
 * - Logto:     {endpoint}/oidc/auth                  | {endpoint}/oidc/token              | {endpoint}/oidc/me
 *
 * 企业微信 / 钉钉扫码登录不是标准 OIDC，如需接入建议由后端做适配层，
 * 对外仍暴露统一的 authorize/token/userinfo 端点。
 */

export interface AuthProvider {
  id: string
  /** 登录按钮上显示的名称 */
  name: string
  authorizeUrl: string
  tokenUrl: string
  userinfoUrl?: string
  clientId: string
  scopes: string[]
  /** 某些 IdP 需要额外参数，如 response_mode、企业微信 appid 等 */
  extraAuthorizeParams?: Record<string, string>
}

/** 桌面端自定义协议，须与 src-tauri/tauri.conf.json 中 deep-link schemes 一致 */
export const DESKTOP_SCHEME = 'dikong'

const SSO_BASE = 'https://sso.example.com'

export const providers: AuthProvider[] = [
  {
    id: 'keycloak',
    name: '企业统一认证',
    authorizeUrl: `${SSO_BASE}/realms/dikong/protocol/openid-connect/auth`,
    tokenUrl: `${SSO_BASE}/realms/dikong/protocol/openid-connect/token`,
    userinfoUrl: `${SSO_BASE}/realms/dikong/protocol/openid-connect/userinfo`,
    clientId: 'dikong-oa',
    scopes: ['openid', 'profile', 'email'],
  },
  {
    id: 'casdoor',
    name: 'Casdoor SSO',
    authorizeUrl: `${SSO_BASE}/login/oauth/authorize`,
    tokenUrl: `${SSO_BASE}/api/login/oauth/access_token`,
    userinfoUrl: `${SSO_BASE}/api/userinfo`,
    clientId: 'your-client-id',
    scopes: ['openid', 'profile', 'email'],
  },
]

export function getProvider(id: string): AuthProvider | undefined {
  return providers.find((p) => p.id === id)
}
