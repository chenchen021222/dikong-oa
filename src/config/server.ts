/**
 * 数据服务地址配置。
 *
 * 开发调试：
 *   - Web 预览（pnpm dev）走 vite 中间件 /local-db（同机 SQLite）
 *   - 桌面端（pnpm tauri dev）读本机 SQLite
 *
 * 生产打包：
 *   - 统一连接管理员服务器（192.168.8.86:8618）
 *   - 所有数据（账号/资料/禅道凭据/任务缓存）集中存储
 */
export const DATA_API_BASE = 'http://192.168.8.86:8618'

