/**
 * 服务器上的数据服务。
 * 浏览器经 Nginx 访问 /local-db；桌面端直接访问 :8618，绩效转发在 :8619。
 */
import { createServer } from 'node:http'
import http from 'node:http'
import { handle, initDb } from './db-api.mjs'
import { startMailScheduler } from './mail-reminder.mjs'
import { ensureStorage } from './storage.mjs'

const PORT = Number(process.env.PORT ?? 8618)
const SCORE_PORT = Number(process.env.SCORE_PORT ?? 8619)
const SCORE_TARGET = process.env.SCORE_TARGET ?? 'http://192.168.101.127:15050'

await initDb()
startMailScheduler()
ensureStorage()
  .then(() => console.log('MinIO 已就绪: dikong-images'))
  .catch((error) => console.error(`MinIO 未连接: ${error.message}`))

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) }
    })
  })
}

createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') return res.end()

  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname.replace(/^\/local-db/, '') || '/'

  if (path === '/health') {
    res.setHeader('Content-Type', 'application/json')
    return res.end(JSON.stringify({ ok: true }))
  }

  const body = req.method === 'POST' ? await readBody(req) : {}
  const { code, data } = await handle('', req.method, path, body, url.searchParams)
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
  console.log(`REQ ${ip} ${req.method} ${path} ${code}`)
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(data))
}).listen(PORT, '0.0.0.0', () => {
  console.log(`DiKongOA 数据服务已启动: http://0.0.0.0:${PORT}`)
})

createServer((req, res) => {
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  if (!req.url?.startsWith('/score-api')) {
    res.writeHead(404, cors)
    res.end()
    return
  }
  const ip = (req.socket.remoteAddress ?? '').replace('::ffff:', '')
  console.log(`SCORE-PROXY ${ip} ${req.method} ${req.url}`)
  const url = new URL(req.url.slice('/score-api'.length), SCORE_TARGET)
  const headers = { ...req.headers }
  delete headers.host
  delete headers.origin
  delete headers.referer
  const proxyReq = http.request(url, { method: req.method, headers }, (proxyRes) => {
    console.log(`SCORE-PROXY ${ip} -> ${proxyRes.statusCode}`)
    res.writeHead(proxyRes.statusCode ?? 502, { ...proxyRes.headers, ...cors })
    proxyRes.pipe(res)
  })
  req.pipe(proxyReq)
  proxyReq.on('error', (e) => {
    console.log(`SCORE-PROXY ${ip} ERROR ${e.message}`)
    if (!res.headersSent) res.writeHead(502, cors)
    res.end()
  })
}).listen(SCORE_PORT, '0.0.0.0', () => {
  console.log(`绩效转发已启动: http://0.0.0.0:${SCORE_PORT}/score-api -> ${SCORE_TARGET}`)
})
