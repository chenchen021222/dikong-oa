use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

/// 初始化 SQLite：建表 + 写入默认管理员账号 admin / 123456
pub fn init(path: &std::path::Path) -> Result<Db, String> {
  let conn = Connection::open(path).map_err(|e| e.to_string())?;
  conn
    .execute_batch(
      "CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name  TEXT,
        created_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
      );
      CREATE TABLE IF NOT EXISTS zentao_tasks (
        id         INTEGER NOT NULL,
        user_id    INTEGER NOT NULL REFERENCES users(id),
        name       TEXT,
        status     TEXT,
        deadline   TEXT,
        pri        TEXT,
        raw        TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
        PRIMARY KEY (id, user_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );",
    )
    .map_err(|e| e.to_string())?;

  // 老库迁移：users 表补手机号/邮箱列（已存在时忽略报错）
  let _ = conn.execute("ALTER TABLE users ADD COLUMN phone TEXT", []);
  let _ = conn.execute("ALTER TABLE users ADD COLUMN email TEXT", []);

  let count: i64 = conn
    .query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))
    .map_err(|e| e.to_string())?;
  if count == 0 {
    let hash = bcrypt::hash("123456", bcrypt::DEFAULT_COST).map_err(|e| e.to_string())?;
    conn
      .execute(
        "INSERT INTO users (username, password_hash, display_name) VALUES (?1, ?2, ?3)",
        params!["admin", hash, "系统管理员"],
      )
      .map_err(|e| e.to_string())?;
  }

  Ok(Db(Mutex::new(conn)))
}

#[derive(Serialize)]
pub struct LocalSession {
  pub token: String,
  pub username: String,
  pub display_name: Option<String>,
  pub phone: Option<String>,
  pub email: Option<String>,
}

#[derive(Serialize)]
pub struct UserRow {
  pub id: i64,
  pub username: String,
  pub display_name: Option<String>,
  pub created_at: String,
}

fn do_login(conn: &Connection, username: &str, password: &str) -> Result<LocalSession, String> {
  let invalid = || "用户名或密码错误".to_string();

  let (user_id, hash, display_name, phone, email) = conn
    .query_row(
      "SELECT id, password_hash, display_name, phone, email FROM users WHERE username = ?1",
      params![username],
      |r| {
        Ok((
          r.get::<_, i64>(0)?,
          r.get::<_, String>(1)?,
          r.get::<_, Option<String>>(2)?,
          r.get::<_, Option<String>>(3)?,
          r.get::<_, Option<String>>(4)?,
        ))
      },
    )
    .map_err(|_| invalid())?;

  if !bcrypt::verify(&password, &hash).map_err(|e| e.to_string())? {
    return Err(invalid());
  }

  let token = uuid::Uuid::new_v4().to_string();
  conn
    .execute(
      "INSERT INTO sessions (token, user_id) VALUES (?1, ?2)",
      params![token, user_id],
    )
    .map_err(|e| e.to_string())?;

  Ok(LocalSession {
    token,
    username: username.to_string(),
    display_name,
    phone,
    email,
  })
}

#[tauri::command]
pub fn local_login(db: tauri::State<Db>, username: String, password: String) -> Result<LocalSession, String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  do_login(&conn, &username, &password)
}

#[tauri::command]
pub fn local_logout(db: tauri::State<Db>, token: String) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  conn
    .execute("DELETE FROM sessions WHERE token = ?1", params![token])
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// 通过会话 token 找到对应用户 id
fn user_id_by_token(conn: &Connection, token: &str) -> Result<i64, String> {
  conn
    .query_row(
      "SELECT user_id FROM sessions WHERE token = ?1",
      params![token],
      |r| r.get(0),
    )
    .map_err(|_| "会话已失效，请重新登录".to_string())
}

fn do_update_display_name(conn: &Connection, token: &str, display_name: &str) -> Result<(), String> {
  let uid = user_id_by_token(conn, token)?;
  conn
    .execute(
      "UPDATE users SET display_name = ?1 WHERE id = ?2",
      params![display_name, uid],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

fn do_change_password(
  conn: &Connection,
  token: &str,
  old_password: &str,
  new_password: &str,
) -> Result<(), String> {
  let uid = user_id_by_token(conn, token)?;

  let hash: String = conn
    .query_row(
      "SELECT password_hash FROM users WHERE id = ?1",
      params![uid],
      |r| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  if !bcrypt::verify(old_password, &hash).map_err(|e| e.to_string())? {
    return Err("原密码错误".to_string());
  }

  let new_hash = bcrypt::hash(new_password, bcrypt::DEFAULT_COST).map_err(|e| e.to_string())?;
  conn
    .execute(
      "UPDATE users SET password_hash = ?1 WHERE id = ?2",
      params![new_hash, uid],
    )
    .map_err(|e| e.to_string())?;
  // 修改密码后使其它会话失效，仅保留当前会话
  conn
    .execute(
      "DELETE FROM sessions WHERE user_id = ?1 AND token != ?2",
      params![uid, token],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn update_display_name(
  db: tauri::State<Db>,
  token: String,
  display_name: String,
) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  do_update_display_name(&conn, &token, &display_name)
}

#[tauri::command]
pub fn change_password(
  db: tauri::State<Db>,
  token: String,
  old_password: String,
  new_password: String,
) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  do_change_password(&conn, &token, &old_password, &new_password)
}

#[tauri::command]
pub fn update_phone(db: tauri::State<Db>, token: String, phone: String) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  conn
    .execute("UPDATE users SET phone = ?1 WHERE id = ?2", params![phone, uid])
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn update_email(db: tauri::State<Db>, token: String, email: String) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  conn
    .execute("UPDATE users SET email = ?1 WHERE id = ?2", params![email, uid])
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[derive(Serialize)]
pub struct ZentaoTaskRow {
  pub id: i64,
  pub name: String,
  pub status: String,
  pub deadline: String,
  pub pri: String,
  pub fetched_at: String,
}

/// 覆盖式写入当前用户的禅道任务缓存
#[tauri::command]
pub fn save_zentao_tasks(
  db: tauri::State<Db>,
  token: String,
  tasks: Vec<serde_json::Value>,
) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  conn
    .execute("DELETE FROM zentao_tasks WHERE user_id = ?1", params![uid])
    .map_err(|e| e.to_string())?;
  for t in &tasks {
    let id = t.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
    let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
    let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let deadline = t.get("deadline").and_then(|v| v.as_str()).unwrap_or("");
    let pri = t
      .get("pri")
      .map(|v| match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
      })
      .unwrap_or_default();
    conn
      .execute(
        "INSERT OR REPLACE INTO zentao_tasks (id, user_id, name, status, deadline, pri, raw) VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, uid, name, status, deadline, pri, t.to_string()],
      )
      .map_err(|e| e.to_string())?;
  }
  Ok(())
}

/// 读取当前用户的禅道任务缓存（离线秒开用）
#[tauri::command]
pub fn list_zentao_tasks(db: tauri::State<Db>, token: String) -> Result<Vec<ZentaoTaskRow>, String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  let mut stmt = conn
    .prepare("SELECT id, name, status, deadline, pri, fetched_at FROM zentao_tasks WHERE user_id = ?1 ORDER BY id DESC")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map(params![uid], |r| {
      Ok(ZentaoTaskRow {
        id: r.get(0)?,
        name: r.get(1)?,
        status: r.get(2)?,
        deadline: r.get(3)?,
        pri: r.get(4)?,
        fetched_at: r.get(5)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

/// 用户级设置读写（key 内部按用户隔离，如禅道凭据）
#[tauri::command]
pub fn get_user_setting(
  db: tauri::State<Db>,
  token: String,
  key: String,
) -> Result<Option<String>, String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  let k = format!("u{}:{}", uid, key);
  match conn.query_row("SELECT value FROM settings WHERE key = ?1", params![k], |r| {
    r.get::<_, String>(0)
  }) {
    Ok(v) => Ok(Some(v)),
    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
    Err(e) => Err(e.to_string()),
  }
}

#[tauri::command]
pub fn set_user_setting(
  db: tauri::State<Db>,
  token: String,
  key: String,
  value: String,
) -> Result<(), String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let uid = user_id_by_token(&conn, &token)?;
  let k = format!("u{}:{}", uid, key);
  conn
    .execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
      params![k, value],
    )
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[tauri::command]
pub fn list_users(db: tauri::State<Db>) -> Result<Vec<UserRow>, String> {
  let conn = db.0.lock().map_err(|e| e.to_string())?;
  let mut stmt = conn
    .prepare("SELECT id, username, display_name, created_at FROM users ORDER BY id")
    .map_err(|e| e.to_string())?;
  let rows = stmt
    .query_map([], |r| {
      Ok(UserRow {
        id: r.get(0)?,
        username: r.get(1)?,
        display_name: r.get(2)?,
        created_at: r.get(3)?,
      })
    })
    .map_err(|e| e.to_string())?
    .collect::<Result<Vec<_>, _>>()
    .map_err(|e| e.to_string())?;
  Ok(rows)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_db() -> Db {
    let dir = std::env::temp_dir().join(format!("dikong-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    init(&dir.join("t.db")).unwrap()
  }

  #[test]
  fn admin_can_login_with_correct_password() {
    let db = temp_db();
    let conn = db.0.lock().unwrap();
    let s = do_login(&conn, "admin", "123456").unwrap();
    assert_eq!(s.username, "admin");
    assert_eq!(s.display_name.as_deref(), Some("系统管理员"));
    assert!(!s.token.is_empty());
  }

  #[test]
  fn wrong_password_is_rejected() {
    let db = temp_db();
    let conn = db.0.lock().unwrap();
    assert!(do_login(&conn, "admin", "wrong").is_err());
    assert!(do_login(&conn, "nobody", "123456").is_err());
  }

  #[test]
  fn session_is_persisted() {
    let db = temp_db();
    let conn = db.0.lock().unwrap();
    let s = do_login(&conn, "admin", "123456").unwrap();
    let count: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM sessions WHERE token = ?1",
        params![s.token],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(count, 1);
  }

  #[test]
  fn display_name_can_be_updated() {
    let db = temp_db();
    let conn = db.0.lock().unwrap();
    let s = do_login(&conn, "admin", "123456").unwrap();
    do_update_display_name(&conn, &s.token, "新名字").unwrap();
    let name: String = conn
      .query_row(
        "SELECT display_name FROM users WHERE username = 'admin'",
        [],
        |r| r.get(0),
      )
      .unwrap();
    assert_eq!(name, "新名字");
    assert!(do_update_display_name(&conn, "bad-token", "x").is_err());
  }

  #[test]
  fn password_change_verifies_old_and_rotates_sessions() {
    let db = temp_db();
    let conn = db.0.lock().unwrap();
    let s = do_login(&conn, "admin", "123456").unwrap();

    assert!(do_change_password(&conn, &s.token, "wrong", "newpass").is_err());
    do_change_password(&conn, &s.token, "123456", "newpass").unwrap();

    // 新密码可登录，旧密码被拒
    assert!(do_login(&conn, "admin", "newpass").is_ok());
    assert!(do_login(&conn, "admin", "123456").is_err());
    // 当前会话仍有效
    assert!(user_id_by_token(&conn, &s.token).is_ok());
  }
}
