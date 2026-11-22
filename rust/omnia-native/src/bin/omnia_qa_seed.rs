use std::fs;
use std::path::PathBuf;
use std::process;

use omnia_native::{parse_qa_seed_directory_arg, NativeSessionStore};

fn run_seed(args: &[String]) -> Result<PathBuf, String> {
    let dir = parse_qa_seed_directory_arg(args).map_err(|e| e.message)?;
    if dir.exists() {
        return Err("fixture directory must not already exist".to_owned());
    }
    fs::create_dir(&dir).map_err(|err| format!("failed to create fixture directory: {err}"))?;

    let db_path = dir.join("sessions.sqlite3");
    let mut store = NativeSessionStore::open(&db_path).map_err(|err| err.to_string())?;
    let _snap = store.seed_paging_fixture().map_err(|err| err.to_string())?;
    drop(store);
    Ok(db_path)
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run_seed(&args) {
        Ok(db_path) => {
            println!("{}", db_path.display());
        }
        Err(msg) => {
            eprintln!("{msg}");
            process::exit(1);
        }
    }
}
