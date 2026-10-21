/**
 * DiKongOA 本地数据服务 —— 路由核心（被两处复用）：
 *   1. vite.local-db.ts       → 开发期网页预览（同源 /local-db）
 *   2. server.mjs             → 常驻独立服务，供打包出去的客户端经局域网访问
 *
 * 数据统一存 SQLite（dikong.db），与 Tauri 桌面端同一份。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import bcrypt from 'bcryptjs'

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA busy_timeout = 3000')
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    phone TEXT,
    email TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  try { db.exec('ALTER TABLE users ADD COLUMN phone TEXT') } catch { /* 已有 */ }
  try { db.exec('ALTER TABLE users ADD COLUMN email TEXT') } catch { /* 已有 */ }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS zentao_tasks (
    id INTEGER NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id),
    name TEXT, status TEXT, deadline TEXT, pri TEXT, raw TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (id, user_id)
  )`)
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`)
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get()
  if (count.c === 0) {
    db.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?,?,?)').run(
      'admin', bcrypt.hashSync('123456', 10), '系统管理员',
    )
  }
  return db
}

function uidByToken(db, token) {
  const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token)
  if (!row) throw new Error('会话已失效，请重新登录')
  return row.user_id
}

const routes = {
  // 登录：bcrypt 校验 + 写 sessions，返回与 Tauri local_login 一致的结构
  'POST /login': (db, b) => {
    const row = db.prepare(
      'SELECT id, password_hash, display_name, phone, email FROM users WHERE username = ?',
    ).get(String(b.username))
    if (!row || !bcrypt.compareSync(String(b.password), String(row.password_hash))) {
      const err = new Error('用户名或密码错误')
      err.code = 401
      throw err
    }
    const token = randomUUID()
    db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, row.id)
    return {
      token, username: String(b.username),
      display_name: row.display_name, phone: row.phone, email: row.email,
    }
  },
  'POST /logout': (db, b) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(String(b.token))
    return null
  },
  // 资料更新：display_name / phone / email 按需更新
  'POST /user': (db, b) => {
    const uid = uidByToken(db, String(b.token))
    for (const [key, col] of [
      ['displayName', 'display_name'], ['phone', 'phone'], ['email', 'email'],
    ]) {
      if (b[key] !== undefined) {
        db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(String(b[key]), uid)
      }
    }
    return null
  },
  // 改密码：校验旧密码 + 轮换其它会话
  'POST /password': (db, b) => {
    const uid = uidByToken(db, String(b.token))
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(uid)
    if (!row || !bcrypt.compareSync(String(b.oldPassword), row.password_hash)) {
      const err = new Error('原密码错误')
      err.code = 400
      throw err
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(
      bcrypt.hashSync(String(b.newPassword), 10), uid,
    )
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(uid, String(b.token))
    return null
  },
  // 用户级设置：settings 表 key 形如 u{id}:zentao_cred
  'GET /setting': (db, _b, q) => {
    const uid = uidByToken(db, String(q.get('token')))
    const row = db.prepare('SELECT value FROM settings WHERE key = ?')
      .get(`u${uid}:${q.get('key')}`)
    return { value: row?.value ?? null }
  },
  'POST /setting': (db, b) => {
    const uid = uidByToken(db, String(b.token))
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(`u${uid}:${b.key}`, String(b.value ?? ''))
    return null
  },
  // 禅道任务缓存：整体覆盖当前用户的记录
  'GET /tasks': (db, _b, q) => {
    const uid = uidByToken(db, String(q.get('token')))
    return db.prepare(
      'SELECT id, name, status, deadline, pri, fetched_at FROM zentao_tasks WHERE user_id = ? ORDER BY id DESC',
    ).all(uid)
  },
  'POST /tasks': (db, b) => {
    const uid = uidByToken(db, String(b.token))
    db.prepare('DELETE FROM zentao_tasks WHERE user_id = ?').run(uid)
    const ins = db.prepare(
      'INSERT OR REPLACE INTO zentao_tasks (id, user_id, name, status, deadline, pri, raw) VALUES (?,?,?,?,?,?,?)',
    )
    for (const t of b.tasks ?? []) {
      ins.run(
        Number(t.id ?? 0), uid, String(t.name ?? ''), String(t.status ?? ''),
        String(t.deadline ?? ''), String(t.pri ?? ''), JSON.stringify(t),
      )
    }
    return null
  },
  // 管理员：列出全部用户（供服务端巡检/后台管理用）
  'GET /users': (db) => db.prepare('SELECT id, username, display_name, email FROM users').all(),
}

/** 统一入口：解析后的 method/path/body/query → { code, data } */
export function handle(dbPath, method, pathname, body, query) {
  const handler = routes[`${method} ${pathname}`]
  if (!handler) return { code: 404, data: { error: 'not found' } }
  const db = openDb(dbPath)
  try {
    return { code: 200, data: { data: handler(db, body, query) } }
  } catch (e) {
    const code = e.code ?? (e.message.includes('会话') ? 401 : 500)
    return { code, data: { error: e.message } }
  } finally {
    db.close()
  }
}

export const DEFAULT_DB_PATH = join(
  process.env.APPDATA ?? process.env.HOME ?? '.',
  'com.dikong.oa',
  'dikong.db',
)
