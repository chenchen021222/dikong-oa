/**
 * Web 预览模式的本地数据库接口。
 *
 * 浏览器没有本地存储层，dev server 挂这个中间件后，网页预览和桌面端
 * 读写同一份 MySQL（连接见 %APPDATA%/com.dikong.oa/mysql.json）。
 * 路由实现见 server/local-server/db-api.mjs（与独立局域网服务共用）。
 * 仅开发环境生效（configureServer 不进构建产物）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { handle, DEFAULT_DB_PATH } from './server/local-server/db-api.mjs'

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
  })
}

export default function localDbApi(): Plugin {
  return {
    name: 'local-db-api',
    configureServer(server) {
      server.middlewares.use('/local-db', (req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const url = new URL(req.url ?? '/', 'http://local')
          const body = req.method === 'POST' ? await readBody(req) : {}
          const { code, data } = await handle(
            DEFAULT_DB_PATH,
            req.method ?? 'GET',
            url.pathname,
            body,
            url.searchParams,
          )
          res.statusCode = code
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(data))
        })()
      })
    },
  }
}
