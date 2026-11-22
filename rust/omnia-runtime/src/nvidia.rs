use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Semaphore;
use tokio::time;

const DEFAULT_TIMEOUT: Duration = Duration::from_millis(2_750);
const CLEANUP_TIMEOUT: Duration = Duration::from_millis(250);
const MAX_STDOUT_BYTES: usize = 64 * 1024;
const MAX_STDERR_BYTES: usize = 16 * 1024;
const MAX_RECORDS: usize = 32;
const MAX_FIELD_BYTES: usize = 512;
#[cfg(windows)]
const WINDOWS_CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug)]
pub struct NvidiaConfig {
    executable: Result<PathBuf, &'static str>,
    timeout: Duration,
    permits: Arc<Semaphore>,
}

impl NvidiaConfig {
    pub fn from_env() -> Self {
        let executable = match std::env::var("OMNIA_NVIDIA_SMI_PATH") {
            Ok(raw) => {
                let path = PathBuf::from(raw.trim());
                if raw.trim().is_empty() || !path.is_absolute() {
                    Err("configured NVIDIA probe path is invalid")
                } else {
                    Ok(path)
                }
            }
            Err(_) => {
                #[cfg(windows)]
                {
                    std::env::var_os("SystemRoot")
                        .map(PathBuf::from)
                        .filter(|root| root.is_absolute())
                        .map(|root| root.join("System32").join("nvidia-smi.exe"))
                        .ok_or("Windows system directory is unavailable")
                }
                #[cfg(not(windows))]
                {
                    Ok(PathBuf::from("nvidia-smi"))
                }
            }
        };
        let timeout_ms = std::env::var("OMNIA_NVIDIA_PROBE_TIMEOUT_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (100..=2_750).contains(value))
            .unwrap_or(DEFAULT_TIMEOUT.as_millis() as u64);
        Self {
            executable,
            timeout: Duration::from_millis(timeout_ms),
            permits: Arc::new(Semaphore::new(1)),
        }
    }

    #[cfg(test)]
    fn with_executable(path: PathBuf) -> Self {
        Self {
            executable: Ok(path),
            timeout: Duration::from_millis(250),
            permits: Arc::new(Semaphore::new(1)),
        }
    }
}

#[derive(Debug)]
struct GpuRecord {
    index: u32,
    name: String,
    driver_version: String,
    memory_total_mib: u64,
    memory_free_mib: u64,
}

fn observed_at_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn base_payload(state: &str) -> serde_json::Map<String, Value> {
    let mut payload = serde_json::Map::new();
    payload.insert("schema".to_string(), json!("omnia.hardware.nvidia.v1"));
    payload.insert("state".to_string(), json!(state));
    payload.insert("backend".to_string(), json!("nvidia-smi"));
    payload.insert("observedAtUnixMs".to_string(), json!(observed_at_unix_ms()));
    payload.insert("evidenceScope".to_string(), json!("device_query_only"));
    payload.insert(
        "workloads".to_string(),
        json!({
            "cuda": "unverified",
            "tensorrt": "unverified",
            "nvenc": "unverified"
        }),
    );
    payload
}

fn unavailable(code: &'static str, detail: &'static str) -> (u16, Value) {
    let mut payload = base_payload("unavailable");
    payload.insert("error".to_string(), json!(code));
    payload.insert("detail".to_string(), json!(detail));
    payload.insert("gpus".to_string(), json!([]));
    (503, Value::Object(payload))
}

fn probe_error(code: &'static str, detail: &'static str) -> (u16, Value) {
    let mut payload = base_payload("error");
    payload.insert("error".to_string(), json!(code));
    payload.insert("detail".to_string(), json!(detail));
    payload.insert("gpus".to_string(), json!([]));
    (503, Value::Object(payload))
}

fn ready(records: Vec<GpuRecord>) -> (u16, Value) {
    let gpus = records
        .into_iter()
        .map(|gpu| {
            json!({
                "index": gpu.index,
                "name": gpu.name,
                "driverVersion": gpu.driver_version,
                "memoryTotalMiB": gpu.memory_total_mib,
                "memoryFreeMiB": gpu.memory_free_mib,
            })
        })
        .collect::<Vec<_>>();
    let mut payload = base_payload("ready");
    payload.insert("gpus".to_string(), Value::Array(gpus));
    (200, Value::Object(payload))
}

async fn read_limited<R>(mut reader: R, limit: usize) -> Result<Vec<u8>, ()>
where
    R: AsyncRead + Unpin,
{
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await.map_err(|_| ())?;
        if read == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(read) > limit {
            return Err(());
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
}

fn parse_csv_record(line: &str) -> Result<Vec<String>, ()> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut closed_quote = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if quoted && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' if quoted => {
                quoted = false;
                closed_quote = true;
            }
            '"' if !closed_quote && field.trim().is_empty() => {
                quoted = true;
                field.clear();
            }
            '"' => return Err(()),
            ',' if !quoted => {
                let value = field.trim().to_string();
                if value.len() > MAX_FIELD_BYTES {
                    return Err(());
                }
                fields.push(value);
                field.clear();
                closed_quote = false;
            }
            _ => {
                if ch.is_control() || (closed_quote && !ch.is_whitespace()) {
                    return Err(());
                }
                field.push(ch);
            }
        }
    }
    if quoted {
        return Err(());
    }
    let value = field.trim().to_string();
    if value.len() > MAX_FIELD_BYTES {
        return Err(());
    }
    fields.push(value);
    Ok(fields)
}

fn parse_unsigned<T: std::str::FromStr>(value: &str) -> Result<T, &'static str> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("nvidia_output_malformed");
    }
    value.parse().map_err(|_| "nvidia_output_malformed")
}

fn parse_csv(stdout: &[u8]) -> Result<Vec<GpuRecord>, &'static str> {
    let text = std::str::from_utf8(stdout).map_err(|_| "nvidia_output_invalid_utf8")?;
    let mut records = Vec::new();
    let mut indexes = HashSet::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if records.len() >= MAX_RECORDS {
            return Err("nvidia_output_too_many_records");
        }
        let fields = parse_csv_record(line).map_err(|_| "nvidia_output_malformed")?;
        if fields.len() != 5 || fields.iter().any(|field| field.is_empty()) {
            return Err("nvidia_output_malformed");
        }
        let index = parse_unsigned::<u32>(&fields[0])?;
        let total = parse_unsigned::<u64>(&fields[3])?;
        let free = parse_unsigned::<u64>(&fields[4])?;
        if !indexes.insert(index) || total == 0 || free > total {
            return Err("nvidia_output_malformed");
        }
        records.push(GpuRecord {
            index,
            name: fields[1].clone(),
            driver_version: fields[2].clone(),
            memory_total_mib: total,
            memory_free_mib: free,
        });
    }
    if records.is_empty() {
        return Err("nvidia_no_device");
    }
    Ok(records)
}

fn command_for(path: &PathBuf) -> Command {
    let mut command = Command::new(path);
    command
        .args([
            "--query-gpu=index,name,driver_version,memory.total,memory.free",
            "--format=csv,noheader,nounits",
        ])
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        command.creation_flags(WINDOWS_CREATE_NO_WINDOW);
    }
    command
}

pub async fn probe(config: &NvidiaConfig) -> (u16, Value) {
    let Ok(_permit) = config.permits.try_acquire() else {
        return unavailable(
            "nvidia_probe_busy",
            "A NVIDIA device query is already in progress",
        );
    };
    let path = match &config.executable {
        Ok(path) => path,
        Err(detail) => return unavailable("nvidia_executable_invalid", detail),
    };
    let mut child = match command_for(path).spawn() {
        Ok(child) => child,
        Err(_) => {
            return unavailable(
                "nvidia_unavailable",
                "NVIDIA probe executable is unavailable",
            )
        }
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return probe_error("nvidia_probe_error", "NVIDIA probe output is unavailable");
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.start_kill();
        return probe_error("nvidia_probe_error", "NVIDIA probe output is unavailable");
    };

    let result = time::timeout(config.timeout, async {
        let stdout_future = read_limited(stdout, MAX_STDOUT_BYTES);
        let stderr_future = read_limited(stderr, MAX_STDERR_BYTES);
        tokio::pin!(stdout_future);
        tokio::pin!(stderr_future);
        let status_future = async { child.wait().await.map_err(|_| ()) };
        tokio::pin!(status_future);
        tokio::try_join!(stdout_future, stderr_future, status_future)
    })
    .await;

    let (stdout, _stderr, status) = match result {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => {
            let _ = child.start_kill();
            let _ = time::timeout(CLEANUP_TIMEOUT, child.wait()).await;
            return probe_error(
                "nvidia_probe_io_failed",
                "NVIDIA probe output could not be read within its byte limits",
            );
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = time::timeout(CLEANUP_TIMEOUT, child.wait()).await;
            return probe_error("nvidia_probe_timeout", "NVIDIA probe timed out");
        }
    };
    if status.code() == Some(6) {
        return unavailable("nvidia_no_device", "No NVIDIA device was reported");
    }
    if !status.success() {
        return probe_error(
            "nvidia_probe_failed",
            "NVIDIA probe returned an unsuccessful status",
        );
    }
    match parse_csv(&stdout) {
        Ok(records) => ready(records),
        Err("nvidia_no_device") => unavailable("nvidia_no_device", "No NVIDIA device was reported"),
        Err(code) => probe_error(code, "NVIDIA probe output was invalid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_names_and_escaped_quotes() {
        let rows = parse_csv(
            br#"0,"GeForce, GTX ""Test""",621.14,4096,2048
"#,
        )
        .expect("quoted CSV should parse");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, r#"GeForce, GTX "Test""#);
        assert_eq!(rows[0].memory_total_mib, 4096);
    }

    #[test]
    fn rejects_bad_field_count_and_numbers() {
        assert_eq!(
            parse_csv(b"0,GeForce,621.14,4096").unwrap_err(),
            "nvidia_output_malformed"
        );
        assert_eq!(
            parse_csv(b"zero,GeForce,621.14,4096,2048").unwrap_err(),
            "nvidia_output_malformed"
        );
    }

    #[test]
    fn empty_output_is_no_device() {
        assert_eq!(parse_csv(b"\r\n").unwrap_err(), "nvidia_no_device");
    }

    #[test]
    fn rejects_ambiguous_quotes_duplicates_and_out_of_range_memory() {
        for input in [
            b"0,Ge\"Force\",621.14,4096,2048".as_slice(),
            b"0,\"GeForce\"suffix,621.14,4096,2048".as_slice(),
            b"0,GeForce,621.14,4096,2048\n0,GeForce,621.14,4096,2048".as_slice(),
            b"+0,GeForce,621.14,4096,2048".as_slice(),
            b"0,GeForce,621.14,4096,4097".as_slice(),
        ] {
            assert_eq!(parse_csv(input).unwrap_err(), "nvidia_output_malformed");
        }
    }

    #[tokio::test]
    async fn read_limit_rejects_oversized_output() {
        assert!(read_limited(b"012345".as_slice(), 5).await.is_err());
        assert_eq!(
            read_limited(b"01234".as_slice(), 5).await.unwrap(),
            b"01234"
        );
    }

    #[tokio::test]
    async fn concurrent_probe_reports_busy_without_starting_process() {
        let config = NvidiaConfig::with_executable(PathBuf::from("unused"));
        let _permit = config.permits.try_acquire().unwrap();
        let (status, body) = probe(&config).await;
        assert_eq!(status, 503);
        assert_eq!(body["error"], "nvidia_probe_busy");
        assert_eq!(body["workloads"]["cuda"], "unverified");
    }

    #[tokio::test]
    async fn missing_executable_is_explicitly_unavailable() {
        let config = NvidiaConfig::with_executable(PathBuf::from(
            r"C:\definitely-not-an-omnia-nvidia-probe.exe",
        ));
        let (status, body) = probe(&config).await;
        assert_eq!(status, 503);
        assert_eq!(body["state"], "unavailable");
        assert_eq!(body["error"], "nvidia_unavailable");
        assert_eq!(body["gpus"].as_array().map(Vec::len), Some(0));
    }
}
