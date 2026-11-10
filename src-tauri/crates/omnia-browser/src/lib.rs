//! App-owned Chromium automation over local Chrome DevTools Protocol.
//! Tool registration never starts a browser; the first approved call does.
pub mod browser;
pub mod capture;
pub mod cdp;
pub mod emulate;
pub mod error;
pub mod input;
pub mod keys;
pub mod launch;
pub mod network;
pub mod record;
pub mod safety;
pub mod snapshot;
pub mod tab;
pub mod tools;

pub use browser::{Browser, DownloadBehavior, DownloadEvent, DownloadState};
pub use error::{BrowserError, Result};
pub use launch::LaunchOptions;
pub use tools::{browser_tools, BrowserConfig, BrowserHandle};
