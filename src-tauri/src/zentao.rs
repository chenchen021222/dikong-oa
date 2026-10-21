use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const WIN_LABEL: &str = "zentao";

/// 打开禅道窗口。visible=false 时创建隐藏窗口用于静默探测登录态；
/// 已存在窗口时 visible=true 会把它展示并聚焦。
#[tauri::command]
pub fn zentao_open(app: AppHandle, url: String, visible: bool) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(WIN_LABEL) {
    if visible {
      w.show().map_err(|e| e.to_string())?;
      w.set_focus().map_err(|e| e.to_string())?;
    }
    return Ok(());
  }
  let parsed = url.parse::<tauri::Url>().map_err(|e| e.to_string())?;
  WebviewWindowBuilder::new(&app, WIN_LABEL, WebviewUrl::External(parsed))
    .title("禅道")
    .inner_size(1100.0, 780.0)
    .visible(visible)
    .build()
    .map_err(|e| e.to_string())?;
  Ok(())
}

/// 在禅道窗口的页面上下文里执行脚本（同源 fetch，携带禅道会话 cookie）。
/// 脚本内通过 window.__TAURI__.event.emit(...) 回传结果。
#[tauri::command]
pub fn zentao_eval(app: AppHandle, script: String) -> Result<(), String> {
  let w = app
    .get_webview_window(WIN_LABEL)
    .ok_or_else(|| "禅道窗口未打开".to_string())?;
  w.eval(&script).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn zentao_close(app: AppHandle) -> Result<(), String> {
  if let Some(w) = app.get_webview_window(WIN_LABEL) {
    w.close().map_err(|e| e.to_string())?;
  }
  Ok(())
}
