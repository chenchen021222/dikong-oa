# DiKong OA

企业办公平台（OA 工具），技术栈：**Vue 3 + TypeScript + Element Plus + Tauri 2**。

- Web 版：浏览器直接访问
- 桌面版：Tauri 壳复用同一份前端代码
- 登录：OAuth2 Authorization Code + PKCE，桌面端走系统浏览器 + `dikong://` 深链回跳

## 开发

```bash
pnpm install

# Web 开发（浏览器打开 http://localhost:5173）
pnpm dev

# 桌面开发（需要 Rust + MSVC Build Tools）
pnpm tauri dev

# 构建 Web 产物
pnpm build

# 打包桌面安装包
pnpm tauri build
```

## 配置 SSO Provider

编辑 `src/config/auth.ts`，在 `providers` 数组中填入企业 IdP 的端点：

```ts
{
  id: 'keycloak',
  name: '企业统一认证',
  authorizeUrl: 'https://sso.example.com/realms/dikong/protocol/openid-connect/auth',
  tokenUrl:    'https://sso.example.com/realms/dikong/protocol/openid-connect/token',
  userinfoUrl: 'https://sso.example.com/realms/dikong/protocol/openid-connect/userinfo',
  clientId: 'dikong-oa',
  scopes: ['openid', 'profile', 'email'],
}
```

IdP 侧需要注册两条 redirect_uri：

| 端 | Redirect URI |
| --- | --- |
| 桌面 | `dikong://auth/callback` |
| Web 开发 | `http://localhost:5173/auth/callback` |
| Web 生产 | `https://<你的域名>/auth/callback` |

> 企业微信 / 钉钉扫码登录非标准 OIDC，建议由后端做适配层，对外仍暴露 authorize/token/userinfo 三个标准端点。

## 目录结构

```
src/
├── config/auth.ts      # SSO Provider 配置（在这里加登录方式）
├── services/
│   ├── auth.ts         # 登录流程：授权 URL、code 换 token、深链监听
│   └── pkce.ts         # PKCE code_verifier/challenge 生成
├── stores/auth.ts      # Pinia：会话状态、token 刷新、登出
├── views/
│   ├── LoginView.vue   # 登录页
│   ├── AuthCallback.vue# Web 端 OAuth 回调页
│   └── HomeView.vue    # OA 工作台占位
└── router/             # 路由 + 登录守卫

src-tauri/              # Tauri 桌面壳（Rust）
```

## 登录流程

```
桌面端: App → 系统浏览器 SSO → dikong://auth/callback?code=xx
      → 深链插件回调 → PKCE 换 token → 进入工作台
Web 端: 页面 → SSO → /auth/callback?code=xx → 换 token → 工作台
```
