//! Omnia Studio standalone HTTP/JSON-RPC server executable (`omnia-studio.exe`).

use omnia_studio::config::{CliAction, StudioConfig};
use omnia_studio::start_studio_server;
use std::env;
use std::process::ExitCode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let action = match StudioConfig::parse_args(&args) {
        Ok(act) => act,
        Err(err) => {
            eprintln!("omnia-studio configuration error: {err}");
            return ExitCode::from(2);
        }
    };

    match action {
        CliAction::Help(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        CliAction::Smoke(smoke_cfg) => run_smoke(smoke_cfg).await,
        CliAction::Run(run_cfg) => run_forever(run_cfg).await,
    }
}

async fn run_smoke(cfg: StudioConfig) -> ExitCode {
    let server = match start_studio_server(cfg).await {
        Ok(srv) => srv,
        Err(err) => {
            eprintln!("omnia-studio smoke bind failed: {err}");
            return ExitCode::from(1);
        }
    };

    let addr = server.local_addr();
    let probe_res = smoke_probe_suite(addr).await;
    let base_url = server.base_url();
    server.shutdown().await;

    match probe_res {
        Ok(status_line) => {
            println!("omnia-studio smoke OK on {base_url} ({status_line})");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("omnia-studio smoke probe failed on {base_url}: {err}");
            ExitCode::from(1)
        }
    }
}

async fn smoke_probe_suite(addr: std::net::SocketAddr) -> Result<String, String> {
    let health = smoke_probe_endpoint(addr, "/api/health").await?;
    smoke_probe_endpoint(addr, "/api/v5/super/status").await?;
    smoke_probe_endpoint(addr, "/api/v5/super/capabilities").await?;
    smoke_probe_endpoint(addr, "/api/v5/computer/status").await?;
    Ok(health)
}

async fn smoke_probe_endpoint(addr: std::net::SocketAddr, path: &str) -> Result<String, String> {
    let mut stream = TcpStream::connect(addr)
        .await
        .map_err(|e| format!("connect error on {path}: {e}"))?;
    let host_header = if addr.is_ipv6() {
        format!("[{}]:{}", addr.ip(), addr.port())
    } else {
        format!("{}:{}", addr.ip(), addr.port())
    };
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host_header}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(req.as_bytes())
        .await
        .map_err(|e| format!("write error on {path}: {e}"))?;

    let mut resp = Vec::new();
    stream
        .read_to_end(&mut resp)
        .await
        .map_err(|e| format!("read error on {path}: {e}"))?;
    let text = String::from_utf8_lossy(&resp);
    let first_line = text.lines().next().unwrap_or_default().to_string();
    if !first_line.contains("200") || !text.contains("\"ok\":true") {
        return Err(format!("unexpected response for {path}: {first_line}"));
    }
    Ok(first_line)
}

async fn run_forever(cfg: StudioConfig) -> ExitCode {
    let server = match start_studio_server(cfg).await {
        Ok(srv) => srv,
        Err(err) => {
            eprintln!("omnia-studio startup failed: {err}");
            return ExitCode::from(1);
        }
    };

    println!(
        "Omnia Studio listening on {} (Super v5 workflows + 21 Computer Use tools)",
        server.base_url()
    );
    std::future::pending::<()>().await;
    server.shutdown().await;
    ExitCode::SUCCESS
}
