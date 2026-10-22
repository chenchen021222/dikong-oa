/**
 * DiKongOA 数据服务。账号、会话、禅道任务和设置存在本机 MySQL。
 * 连接信息：%APPDATA%/com.dikong.oa/mysql.json
 */
import { readFileSync, existsSync } from 'node:fs'
import { createConnection } from 'node:net'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'

const SQLITE_PATH = join(process.env.APPDATA ?? process.env.HOME ?? '.', 'com.dikong.oa', 'dikong.db')

export function mysqlConfigPath() {
  return process.env.DIKONG_MYSQL_CONFIG
    || join(process.env.APPDATA ?? process.env.HOME ?? '.', 'com.dikong.oa', 'mysql.json')
}

function loadConfig() {
  const path = mysqlConfigPath()
  if (!existsSync(path)) throw new Error(`缺少 MySQL 配置：${path}`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(port) }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
  })
}

async function ensureServer(cfg) {
  if (await portOpen(cfg.port)) return
  if (!cfg.mysqld || !existsSync(cfg.mysqld)) {
    throw new Error(`MySQL 未在 ${cfg.port} 端口监听`)
  }
  const args = []
  if (cfg.defaultsFile) args.push(`--defaults-file=${cfg.defaultsFile}`)
  args.push(`--port=${cfg.port}`)
  const child = spawn(cfg.mysqld, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await portOpen(cfg.port)) return
  }
  throw new Error(`MySQL 未能在 ${cfg.port} 端口启动`)
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(128) NULL,
  phone VARCHAR(32) NULL,
  email VARCHAR(128) NULL,
  role VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sessions (
  token VARCHAR(64) NOT NULL,
  user_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token),
  KEY idx_sessions_user (user_id),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS zentao_tasks (
  id INT NOT NULL,
  user_id INT NOT NULL,
  name VARCHAR(512) NULL,
  status VARCHAR(64) NULL,
  deadline VARCHAR(32) NULL,
  pri VARCHAR(16) NULL,
  raw MEDIUMTEXT NULL,
  fetched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, user_id),
  CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS settings (
  \`key\` VARCHAR(191) NOT NULL,
  \`value\` MEDIUMTEXT NULL,
  PRIMARY KEY (\`key\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`

let pool
let ready

function dbOf(conn) {
  return {
    get: async (sql, ...params) => {
      const [rows] = await conn.execute(sql, params)
      return rows[0]
    },
    all: async (sql, ...params) => {
      const [rows] = await conn.execute(sql, params)
      return rows
    },
    run: async (sql, ...params) => {
      const [result] = await conn.execute(sql, params)
      return result
    },
  }
}

async function ensureAdmin(conn) {
  const [rows] = await conn.query('SELECT COUNT(*) AS c FROM users')
  if (Number(rows[0].c) > 0) return
  await conn.query(
    'INSERT INTO users (username, password_hash, display_name) VALUES (?,?,?)',
    ['admin', bcrypt.hashSync('123456', 10), '系统管理员'],
  )
}

async function migrateFromSqlite(conn) {
  const [mark] = await conn.query("SELECT `value` FROM settings WHERE `key` = 'migrated_from_sqlite'")
  if (mark.length) return
  if (!existsSync(SQLITE_PATH)) {
    await ensureAdmin(conn)
    await conn.query("INSERT INTO settings (`key`, `value`) VALUES ('migrated_from_sqlite', 'no-sqlite')")
    return
  }

  const { DatabaseSync } = await import('node:sqlite')
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true })
  const users = sqlite.prepare(
    'SELECT id, username, password_hash, display_name, phone, email, created_at FROM users',
  ).all()
  const sessions = sqlite.prepare('SELECT token, user_id, created_at FROM sessions').all()
  const tasks = sqlite.prepare(
    'SELECT id, user_id, name, status, deadline, pri, raw, fetched_at FROM zentao_tasks',
  ).all()
  const settings = sqlite.prepare('SELECT key, value FROM settings').all()
  sqlite.close()

  const tx = await conn.getConnection()
  try {
    await tx.beginTransaction()
    for (const u of users) {
      await tx.query(
        `INSERT INTO users (id, username, password_hash, display_name, phone, email, created_at)
         VALUES (?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           password_hash = VALUES(password_hash),
           display_name = VALUES(display_name),
           phone = VALUES(phone),
           email = VALUES(email)`,
        [u.id, u.username, u.password_hash, u.display_name, u.phone, u.email, u.created_at],
      )
    }
    if (users.length) {
      const maxId = Math.max(...users.map((u) => Number(u.id)))
      await tx.query(`ALTER TABLE users AUTO_INCREMENT = ${maxId + 1}`)
    }
    for (const s of sessions) {
      await tx.query(
        'INSERT IGNORE INTO sessions (token, user_id, created_at) VALUES (?,?,?)',
        [s.token, s.user_id, s.created_at],
      )
    }
    for (const t of tasks) {
      await tx.query(
        `REPLACE INTO zentao_tasks (id, user_id, name, status, deadline, pri, raw, fetched_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [t.id, t.user_id, t.name, t.status, t.deadline, t.pri, t.raw, t.fetched_at],
      )
    }
    for (const s of settings) {
      await tx.query('REPLACE INTO settings (`key`, `value`) VALUES (?, ?)', [s.key, s.value])
    }
    await tx.query(
      "REPLACE INTO settings (`key`, `value`) VALUES ('migrated_from_sqlite', ?)",
      [new Date().toISOString()],
    )
    await tx.commit()
  } catch (error) {
    await tx.rollback()
    throw error
  } finally {
    tx.release()
  }
  await ensureAdmin(conn)
}

export async function initDb() {
  if (!ready) {
    ready = (async () => {
      const cfg = loadConfig()
      await ensureServer(cfg)
      const bootstrap = mysql.createPool({
        host: cfg.host,
        port: Number(cfg.port),
        user: cfg.user,
        password: cfg.password,
        waitForConnections: true,
        connectionLimit: 2,
        charset: 'utf8mb4',
        timezone: '+08:00',
        dateStrings: true,
      })
      await bootstrap.query(
        `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await bootstrap.end()
      pool = mysql.createPool({
        host: cfg.host,
        port: Number(cfg.port),
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        waitForConnections: true,
        connectionLimit: 8,
        charset: 'utf8mb4',
        timezone: '+08:00',
        dateStrings: true,
      })
      for (const statement of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) {
        await pool.query(statement)
      }
      await migrateFromSqlite(pool)
      await ensureRole(pool)
      console.log(`MySQL 已就绪: ${cfg.host}:${cfg.port}/${cfg.database}`)
    })().catch((error) => {
      ready = null
      throw error
    })
  }
  await ready
}

async function ensureRole(conn) {
  const [cols] = await conn.query("SHOW COLUMNS FROM users LIKE 'role'")
  if (!cols.length) {
    await conn.query("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'")
  }
  await conn.query("UPDATE users SET role = 'admin' WHERE username = 'admin'")
}

export async function queryAll(sql, params = []) {
  await initDb()
  const [rows] = await pool.execute(sql, params)
  return rows
}

export async function exec(sql, params = []) {
  await initDb()
  const [result] = await pool.execute(sql, params)
  return result
}

async function uidByToken(db, token) {
  const row = await db.get('SELECT user_id FROM sessions WHERE token = ?', token)
  if (!row) throw new Error('会话已失效，请重新登录')
  return row.user_id
}

async function requireAdmin(db, token) {
  const uid = await uidByToken(db, String(token ?? ''))
  const row = await db.get('SELECT id, username, role FROM users WHERE id = ?', uid)
  if (!row || row.role !== 'admin') {
    const err = new Error('需要管理员权限')
    err.code = 403
    throw err
  }
  return row
}

function assertRole(role) {
  if (role !== 'admin' && role !== 'user') {
    const err = new Error('角色只能是管理员或普通用户')
    err.code = 400
    throw err
  }
}

const USER_FIELDS = 'id, username, display_name, phone, email, role, created_at'

const routes = {
  'POST /login': async (db, b) => {
    const row = await db.get(
      'SELECT id, password_hash, display_name, phone, email, role FROM users WHERE username = ?',
      String(b.username),
    )
    if (!row || !bcrypt.compareSync(String(b.password), String(row.password_hash))) {
      const err = new Error('用户名或密码错误')
      err.code = 401
      throw err
    }
    const token = randomUUID()
    await db.run('INSERT INTO sessions (token, user_id) VALUES (?, ?)', token, row.id)
    return {
      token,
      username: String(b.username),
      display_name: row.display_name,
      phone: row.phone,
      email: row.email,
      role: row.role === 'admin' ? 'admin' : 'user',
    }
  },
  'GET /me': async (db, _b, q) => {
    const uid = await uidByToken(db, String(q.get('token')))
    const row = await db.get(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, uid)
    if (!row) throw new Error('用户不存在')
    return row
  },
  'GET /admin/users': async (db, _b, q) => {
    await requireAdmin(db, q.get('token'))
    return db.all(`SELECT ${USER_FIELDS} FROM users ORDER BY id`)
  },
  'POST /admin/users': async (db, b) => {
    await requireAdmin(db, b.token)
    const username = String(b.username ?? '').trim()
    const password = String(b.password ?? '')
    const role = b.role === 'admin' ? 'admin' : 'user'
    if (!/^[A-Za-z0-9_]{2,32}$/.test(username)) {
      const err = new Error('用户名需为 2-32 位字母、数字或下划线')
      err.code = 400
      throw err
    }
    if (password.length < 6) {
      const err = new Error('密码至少 6 位')
      err.code = 400
      throw err
    }
    const exists = await db.get('SELECT id FROM users WHERE username = ?', username)
    if (exists) {
      const err = new Error('用户名已存在')
      err.code = 400
      throw err
    }
    await db.run(
      `INSERT INTO users (username, password_hash, display_name, phone, email, role)
       VALUES (?,?,?,?,?,?)`,
      username,
      bcrypt.hashSync(password, 10),
      String(b.displayName ?? username),
      String(b.phone ?? ''),
      String(b.email ?? ''),
      role,
    )
    return db.get(`SELECT ${USER_FIELDS} FROM users WHERE username = ?`, username)
  },
  'POST /admin/users/update': async (db, b) => {
    const admin = await requireAdmin(db, b.token)
    const id = Number(b.id)
    const target = await db.get('SELECT id, role FROM users WHERE id = ?', id)
    if (!target) {
      const err = new Error('用户不存在')
      err.code = 404
      throw err
    }
    const role = b.role === 'admin' ? 'admin' : 'user'
    assertRole(role)
    if (target.role === 'admin' && role !== 'admin') {
      const count = await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
      if (Number(count.c) <= 1) {
        const err = new Error('至少保留一名管理员')
        err.code = 400
        throw err
      }
    }
    await db.run(
      `UPDATE users SET display_name = ?, phone = ?, email = ?, role = ? WHERE id = ?`,
      String(b.displayName ?? ''),
      String(b.phone ?? ''),
      String(b.email ?? ''),
      role,
      id,
    )
    if (b.password) {
      if (String(b.password).length < 6) {
        const err = new Error('密码至少 6 位')
        err.code = 400
        throw err
      }
      await db.run(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        bcrypt.hashSync(String(b.password), 10),
        id,
      )
      if (id !== admin.id) {
        await db.run('DELETE FROM sessions WHERE user_id = ?', id)
      }
    }
    return db.get(`SELECT ${USER_FIELDS} FROM users WHERE id = ?`, id)
  },
  'POST /admin/users/delete': async (db, b) => {
    const admin = await requireAdmin(db, b.token)
    const id = Number(b.id)
    if (id === admin.id) {
      const err = new Error('不能删除当前登录的管理员')
      err.code = 400
      throw err
    }
    const target = await db.get('SELECT id, role FROM users WHERE id = ?', id)
    if (!target) {
      const err = new Error('用户不存在')
      err.code = 404
      throw err
    }
    if (target.role === 'admin') {
      const count = await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'")
      if (Number(count.c) <= 1) {
        const err = new Error('至少保留一名管理员')
        err.code = 400
        throw err
      }
    }
    await db.run('DELETE FROM sessions WHERE user_id = ?', id)
    await db.run('DELETE FROM zentao_tasks WHERE user_id = ?', id)
    await db.run('DELETE FROM settings WHERE `key` LIKE ?', `u${id}:%`)
    await db.run('DELETE FROM users WHERE id = ?', id)
    return null
  },
  'POST /logout': async (db, b) => {
    await db.run('DELETE FROM sessions WHERE token = ?', String(b.token))
    return null
  },
  'POST /user': async (db, b) => {
    const uid = await uidByToken(db, String(b.token))
    for (const [key, col] of [
      ['displayName', 'display_name'],
      ['phone', 'phone'],
      ['email', 'email'],
    ]) {
      if (b[key] !== undefined) {
        await db.run(`UPDATE users SET ${col} = ? WHERE id = ?`, String(b[key]), uid)
      }
    }
    return null
  },
  'POST /password': async (db, b) => {
    const uid = await uidByToken(db, String(b.token))
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', uid)
    if (!row || !bcrypt.compareSync(String(b.oldPassword), row.password_hash)) {
      const err = new Error('原密码错误')
      err.code = 400
      throw err
    }
    await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ?',
      bcrypt.hashSync(String(b.newPassword), 10),
      uid,
    )
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token != ?', uid, String(b.token))
    return null
  },
  'GET /setting': async (db, _b, q) => {
    const uid = await uidByToken(db, String(q.get('token')))
    const row = await db.get('SELECT `value` FROM settings WHERE `key` = ?', `u${uid}:${q.get('key')}`)
    return { value: row?.value ?? null }
  },
  'POST /setting': async (db, b) => {
    const uid = await uidByToken(db, String(b.token))
    await db.run(
      'REPLACE INTO settings (`key`, `value`) VALUES (?, ?)',
      `u${uid}:${b.key}`,
      String(b.value ?? ''),
    )
    return null
  },
  'GET /tasks': async (db, _b, q) => {
    const uid = await uidByToken(db, String(q.get('token')))
    return db.all(
      'SELECT id, name, status, deadline, pri, fetched_at FROM zentao_tasks WHERE user_id = ? ORDER BY id DESC',
      uid,
    )
  },
  'POST /tasks': async (db, b) => {
    const uid = await uidByToken(db, String(b.token))
    await db.run('DELETE FROM zentao_tasks WHERE user_id = ?', uid)
    for (const t of b.tasks ?? []) {
      await db.run(
        `REPLACE INTO zentao_tasks (id, user_id, name, status, deadline, pri, raw)
         VALUES (?,?,?,?,?,?,?)`,
        Number(t.id ?? 0),
        uid,
        String(t.name ?? ''),
        String(t.status ?? ''),
        String(t.deadline ?? ''),
        String(t.pri ?? ''),
        JSON.stringify(t),
      )
    }
    return null
  },
  'GET /users': async (db, _b, q) => {
    await requireAdmin(db, q.get('token'))
    return db.all(`SELECT ${USER_FIELDS} FROM users ORDER BY id`)
  },
  'GET /admin/mail': async (db, _b, q) => {
    await requireAdmin(db, q.get('token'))
    const { getMailView } = await import('./mail-reminder.mjs')
    return getMailView()
  },
  'POST /admin/mail': async (db, b) => {
    await requireAdmin(db, b.token)
    const { saveMailSettings, getMailView } = await import('./mail-reminder.mjs')
    await saveMailSettings(b)
    return getMailView()
  },
  'POST /images': async (db, b) => {
    const uid = await uidByToken(db, String(b.token ?? ''))
    const { putImage } = await import('./storage.mjs')
    return putImage(uid, b)
  },
  'POST /admin/mail/send': async (db, b) => {
    await requireAdmin(db, b.token)
    const { sendReminders, getMailView } = await import('./mail-reminder.mjs')
    await sendReminders({ trigger: 'manual' })
    return getMailView()
  },
}

export async function handle(_dbPath, method, pathname, body, query) {
  const handler = routes[`${method} ${pathname}`]
  if (!handler) return { code: 404, data: { error: 'not found' } }
  try {
    await initDb()
    return { code: 200, data: { data: await handler(dbOf(pool), body, query) } }
  } catch (error) {
    const code = error.code && Number.isInteger(error.code)
      ? error.code
      : String(error.message ?? '').includes('会话')
        ? 401
        : 500
    return { code, data: { error: error.message } }
  }
}

export const DEFAULT_DB_PATH = SQLITE_PATH
