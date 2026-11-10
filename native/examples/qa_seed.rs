//! Disposable, synthetic paging fixture. Refuses an existing target directory.
//! This utility is not started by the product and never uses provider data.
use omnia_native::sessions::Sessions;
use omnia_session_store::HarnessStore;
use std::path::PathBuf;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let directory = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("supply a new absolute fixture directory")?,
    );
    if !directory.is_absolute() {
        return Err("fixture directory must be absolute".into());
    }
    std::fs::create_dir(&directory)?;
    let database = directory.join("sessions.sqlite3");
    let service = Sessions::open(&database).map_err(|e| e.message)?;
    let mut active = service.create("Off-page active").map_err(|e| e.message)?;
    service.select(&active.id, 0).map_err(|e| e.message)?;
    drop(service);
    let store = HarnessStore::open(&database).map_err(|e| e.message)?;
    active.updated_at_ms = 1;
    store.save_summary(&active).map_err(|e| e.message)?;
    for index in 0..124 {
        let mut row = active.clone();
        row.id = format!("paging-fixture-{index:04}");
        row.title = format!("Synthetic session {index:04}");
        row.updated_at_ms = 100;
        store.save_summary(&row).map_err(|e| e.message)?;
    }
    println!("{}", database.display());
    Ok(())
}
