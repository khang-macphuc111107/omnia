//! Runs every scenario in `evals/` against the harness with a scripted model.
//! Offline and deterministic; see `evals/README.md`.

use omnia_harness::eval::{evals_dir, run_scenario, scenario_files, summary_table};

#[test]
fn eval_suite() {
    let files = scenario_files(&evals_dir());
    assert!(
        !files.is_empty(),
        "no scenarios found in {}",
        evals_dir().display()
    );
    let reports: Vec<_> = files.iter().map(|path| run_scenario(path)).collect();
    let table = summary_table(&reports);
    println!("\n{table}");
    let failing: Vec<&str> = reports
        .iter()
        .filter(|report| !report.passed)
        .map(|report| report.name.as_str())
        .collect();
    assert!(
        failing.is_empty(),
        "failing eval scenarios: {failing:?}\n{table}"
    );
}

#[test]
fn scenario_names_match_file_names() {
    for path in scenario_files(&evals_dir()) {
        let report = run_scenario_name_only(&path);
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        assert_eq!(report, stem, "scenario `name` must equal its file stem");
    }
}

fn run_scenario_name_only(path: &std::path::Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap();
    value["name"].as_str().unwrap_or_default().to_owned()
}
