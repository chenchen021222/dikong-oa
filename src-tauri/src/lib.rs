mod db;
mod zentao;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}))
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      db::local_login,
      db::local_logout,
      db::update_display_name,
      db::change_password,
      db::update_phone,
      db::update_email,
      db::save_zentao_tasks,
      db::list_zentao_tasks,
      db::get_user_setting,
      db::set_user_setting,
      db::list_users,
      zentao::zentao_open,
      zentao::zentao_eval,
      zentao::zentao_close
    ])
    .setup(|app| {
      use tauri::Manager;
      let dir = app.path().app_data_dir()?;
      std::fs::create_dir_all(&dir)?;
      app.manage(db::init(&dir.join("dikong.db"))?);

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
