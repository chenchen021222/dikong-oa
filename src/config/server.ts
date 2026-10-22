/**
 * 数据服务地址配置。
 *
 * 开发调试：
 *   - Web 预览（pnpm dev）走 vite 中间件 /local-db（同机 SQLite）
 *   - 桌面端（pnpm tauri dev）读本机 SQLite
 *
 * 生产：
 *   - 浏览器访问服务器页面时走同源 /local-db
 *   - 桌面端连接 192.168.101.172:8618
 */
export const DATA_API_BASE = 'http://192.168.101.172:8618'

