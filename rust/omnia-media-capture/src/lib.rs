//! Truthful media, browser CDP, Win32 window capture, and OBS WebSocket v5 adapter contracts
//! for Omnia `INT-07`.

#![forbid(unsafe_code)]

pub mod browser_cdp;
pub mod browser_ws;
pub mod capability;
pub mod desktop_isolation;
pub mod input_diagnostics;
pub mod obs_v5;
pub mod window_capture;

pub use browser_cdp::{
    parse_cdp_list, parse_cdp_version, probe_cdp_endpoint, validate_cdp_url_with_policy,
    validate_loopback_cdp_url, CdpEndpointPolicy, CdpError, CdpProbeSnapshot, CdpTargetInfo,
    CdpVersionInfo, ValidatedCdpUrl,
};
pub use capability::{
    is_loopback_host, probe_loopback_tcp, probe_loopback_url_tcp, probe_unconfigured_adapter,
    validate_endpoint_url, AdapterKind, CapabilityReason, CapabilityReport, CapabilityStatus,
    EndpointUrlError, EndpointUrlPolicy, ValidatedEndpointUrl,
};
pub use desktop_isolation::{
    DesktopCapabilityMatrix, DesktopIsolationCapability, IsolationDomain, IsolationSurfaceSupport,
    DESKTOP_ISOLATION_SCHEMA_VERSION,
};
pub use input_diagnostics::{
    analyze_mouse_polling, classify_mouse_stroke, describe_windows_input_capabilities,
    detect_mouse_chatter, evaluate_keyboard_calibration, evaluate_stylus_sample,
    evaluate_touchpad_contacts, normalize_qwerty_key, qwerty_key_map, qwerty_key_position,
    EdgeStripSide, InputDiagnosticsError, KeyEventSample, KeyNeighborCandidate, KeySlipProfile,
    KeySlipSample, KeyboardCalibrationReport, MouseChatterReport, MousePollingReport,
    MouseStrokeClassification, MouseStrokePattern, PangramTestInput, QwertyKeyCoord,
    StrokeDirection, StrokePoint, StylusEvaluation, StylusSample, StylusStrokeState,
    SwitchChatterEvent, TouchpadAction, TouchpadContact, TouchpadEdgeScrollConfig,
    TouchpadEvaluation, WindowsInputCapabilityDescriptor, WindowsInputObservation,
    HID_USAGE_DIGITIZER_PEN, HID_USAGE_DIGITIZER_TOUCHPAD, HID_USAGE_HAPTICS_SIMPLE_CONTROLLER,
    HID_USAGE_PAGE_DIGITIZER, HID_USAGE_PAGE_HAPTICS, KEY_PITCH_PX,
    MIN_KEY_SLIP_CALIBRATION_POINTS, NOMINAL_MOUSE_POLLING_TIERS_HZ, PTP_REGISTRY_PATH,
};
pub use obs_v5::{
    build_identify_op1, build_request_op6, compute_obs_v5_auth, parse_hello_op0,
    parse_identify_op1, parse_request_op6, parse_request_response_op7, probe_obs_endpoint,
    validate_obs_ws_url, ObsAuthChallenge, ObsError, ObsHello, ObsIdentify, ObsOpCode, ObsRequest,
    ObsRequestResponse, ObsRequestStatus,
};
pub use window_capture::{
    compute_sha256_hex, evaluate_capture_receipt, probe_window_target_status,
    validate_capture_receipt, validate_capture_receipt_with_max_dim, validate_window_target,
    CaptureFrameReceipt, CapturePixelFormat, ValidatedCaptureReceipt, WindowCaptureError,
    WindowIdentity, DEFAULT_MAX_CAPTURE_DIMENSION, EMPTY_INPUT_SHA256_HEX,
};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{ErrorKind, Read, Write};
    use std::net::{Shutdown, TcpListener, TcpStream};
    use std::thread;
    use std::time::{Duration, Instant};

    fn accept_bounded(listener: &TcpListener, deadline: Instant) -> Option<TcpStream> {
        let _ = listener.set_nonblocking(true);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    return Some(stream);
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return None,
            }
        }
        None
    }

    fn read_http_request_bounded(stream: &mut TcpStream) -> String {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
        let mut buf = Vec::new();
        let mut chunk = [0u8; 2048];
        while buf.len() < 16_384 {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let take = n.min(16_384 - buf.len());
                    buf.extend_from_slice(&chunk[..take]);
                    if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn write_http_response_and_close(stream: &mut TcpStream, raw_response: &[u8]) {
        let _ = stream.write_all(raw_response);
        let _ = stream.flush();
        let _ = stream.shutdown(Shutdown::Write);
    }

    fn sample_window_identity() -> WindowIdentity {
        WindowIdentity {
            hwnd: 0x001A_04F2,
            pid: 4820,
            process_create_time_100ns: 133_758_012_345_678_901,
            title: "Omnia Studio - Workspace".to_string(),
            width: 4,
            height: 4,
            minimized: false,
        }
    }

    fn non_blank_bgra_4x4() -> Vec<u8> {
        let mut buf = Vec::with_capacity(4 * 4 * 4);
        for idx in 0..16u8 {
            buf.extend_from_slice(&[idx.wrapping_mul(13), idx.wrapping_mul(7), 0x40, 0xFF]);
        }
        buf
    }

    fn synthetic_minimal_png(width: u32, height: u32) -> Vec<u8> {
        let mut png = Vec::new();
        png.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        // IHDR length = 13
        png.extend_from_slice(&13u32.to_be_bytes());
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&width.to_be_bytes());
        png.extend_from_slice(&height.to_be_bytes());
        png.extend_from_slice(&[8, 6, 0, 0, 0]);
        png.extend_from_slice(&0u32.to_be_bytes()); // test placeholder CRC
                                                    // IDAT minimal chunk (12 bytes data -> total PNG >= 67 bytes)
        png.extend_from_slice(&12u32.to_be_bytes());
        png.extend_from_slice(b"IDAT");
        png.extend_from_slice(&[
            0x78, 0x9C, 0x63, 0x60, 0x60, 0x60, 0xF8, 0x0F, 0x00, 0x01, 0x05, 0x01,
        ]);
        png.extend_from_slice(&0u32.to_be_bytes());
        // IEND chunk
        png.extend_from_slice(&0u32.to_be_bytes());
        png.extend_from_slice(b"IEND");
        png.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
        assert!(png.len() >= 67);
        png
    }

    #[test]
    fn obs_v5_auth_matches_sha256_base64_vector_and_fails_closed_without_password() {
        // Independent SHA-256 + Base64 vector cross-checked against Python hashlib/base64:
        // secret = Base64(SHA256("supersecretpassword" + "lM3d4+6Y2H8jK1nP"))
        //        = "CUU6/HZeZiSUMXQaeXYjNVShPTOlJfGaJgywnh0kGWg="
        // auth   = Base64(SHA256(secret + "+1z5rQ9tV2xW4yZ8"))
        //        = "tx1EkgIyMVvGknGctKwS1JfIe8S5KIs/Zp6c+bWLLpI="
        let auth = compute_obs_v5_auth(
            "supersecretpassword",
            "lM3d4+6Y2H8jK1nP",
            "+1z5rQ9tV2xW4yZ8",
        );
        assert_eq!(auth, "tx1EkgIyMVvGknGctKwS1JfIe8S5KIs/Zp6c+bWLLpI=");

        let hello = ObsHello {
            obs_studio_version: Some("30.2.3".to_string()),
            obs_web_socket_version: "5.5.2".to_string(),
            rpc_version: 1,
            authentication: Some(ObsAuthChallenge {
                challenge: "+1z5rQ9tV2xW4yZ8".to_string(),
                salt: "lM3d4+6Y2H8jK1nP".to_string(),
            }),
        };

        let missing_pw_err = ObsIdentify::for_hello(&hello, None, Some(33)).unwrap_err();
        assert_eq!(missing_pw_err, ObsError::AuthPasswordRequired);
        let report = missing_pw_err.to_capability_report(Some("ws://127.0.0.1:4455".to_string()));
        assert_eq!(report.status, CapabilityStatus::Blocked);
        assert_eq!(report.reason_code, CapabilityReason::AuthPasswordRequired);
        assert!(!report.source_verified);

        let empty_pw_err = ObsIdentify::for_hello(&hello, Some(""), None).unwrap_err();
        assert_eq!(empty_pw_err, ObsError::AuthPasswordRequired);
    }

    #[test]
    fn obs_v5_op0_hello_and_op1_identify_roundtrip_with_and_without_auth() {
        let hello_json = json!({
            "op": 0,
            "d": {
                "obsStudioVersion": "30.2.3",
                "obsWebSocketVersion": "5.5.2",
                "rpcVersion": 1,
                "authentication": {
                    "challenge": "+1z5rQ9tV2xW4yZ8",
                    "salt": "lM3d4+6Y2H8jK1nP"
                }
            }
        })
        .to_string();

        let hello = parse_hello_op0(&hello_json).expect("valid op=0 Hello");
        assert_eq!(hello.obs_web_socket_version, "5.5.2");
        assert_eq!(hello.obs_studio_version.as_deref(), Some("30.2.3"));
        assert_eq!(hello.rpc_version, 1);

        let identify = ObsIdentify::for_hello(&hello, Some("supersecretpassword"), Some(3327))
            .expect("auth challenge solved");
        let identify_json = build_identify_op1(&identify).expect("op=1 serialized");
        assert!(!identify_json.contains("supersecretpassword"));
        let parsed_identify = parse_identify_op1(&identify_json).expect("op=1 roundtrip");
        assert_eq!(parsed_identify, identify);
        assert_eq!(
            parsed_identify.authentication.as_deref(),
            Some("tx1EkgIyMVvGknGctKwS1JfIe8S5KIs/Zp6c+bWLLpI=")
        );

        let no_auth_hello_json = json!({
            "op": 0,
            "d": {
                "obsWebSocketVersion": "5.4.0",
                "rpcVersion": 1
            }
        })
        .to_string();
        let no_auth_hello = parse_hello_op0(&no_auth_hello_json).expect("no-auth op=0");
        assert!(no_auth_hello.authentication.is_none());
        let no_auth_id =
            ObsIdentify::for_hello(&no_auth_hello, None, None).expect("no password needed");
        let no_auth_frame = build_identify_op1(&no_auth_id).expect("serialize no-auth op=1");
        assert_eq!(parse_identify_op1(&no_auth_frame).unwrap(), no_auth_id);
    }

    #[test]
    fn obs_v5_op6_request_and_op7_response_roundtrip_and_opcode_validation() {
        let req = ObsRequest::new(
            "SetCurrentProgramScene",
            "req-42",
            Some(json!({ "sceneName": "Omnia Capture" })),
        );
        let req_json = build_request_op6(&req).expect("op=6 built");
        let decoded_req = parse_request_op6(&req_json).expect("op=6 parsed");
        assert_eq!(decoded_req, req);

        // Feeding op=6 into parse_hello_op0 must fail with UnexpectedOpCode.
        let wrong_op = parse_hello_op0(&req_json).unwrap_err();
        assert_eq!(
            wrong_op,
            ObsError::UnexpectedOpCode {
                expected: 0,
                actual: 6
            }
        );

        let resp_ok_json = json!({
            "op": 7,
            "d": {
                "requestType": "GetSceneList",
                "requestId": "req-01",
                "requestStatus": { "result": true, "code": 100 },
                "responseData": { "currentProgramSceneName": "Main" }
            }
        })
        .to_string();
        let resp_ok = parse_request_response_op7(&resp_ok_json).expect("op=7 ok parsed");
        assert!(resp_ok.request_status.result);
        assert_eq!(resp_ok.request_status.code, 100);
        assert_eq!(
            resp_ok.response_data,
            Some(json!({ "currentProgramSceneName": "Main" }))
        );

        let resp_err_json = json!({
            "op": 7,
            "d": {
                "requestType": "SetCurrentProgramScene",
                "requestId": "req-42",
                "requestStatus": {
                    "result": false,
                    "code": 600,
                    "comment": "Scene not found"
                }
            }
        })
        .to_string();
        let resp_err = parse_request_response_op7(&resp_err_json).expect("op=7 failure parsed");
        assert!(!resp_err.request_status.result);
        assert_eq!(resp_err.request_status.code, 600);
        assert_eq!(
            resp_err.request_status.comment.as_deref(),
            Some("Scene not found")
        );
    }

    #[test]
    fn cdp_loopback_validation_accepts_loopback_and_rejects_remote_without_opt_in() {
        let ipv4 = validate_loopback_cdp_url("http://127.0.0.1:9222").unwrap();
        assert!(ipv4.is_loopback);
        assert!(!ipv4.non_loopback_opted_in);
        assert_eq!(ipv4.origin, "http://127.0.0.1:9222");

        let localhost = validate_loopback_cdp_url("http://localhost:9222/json/version").unwrap();
        assert!(localhost.is_loopback);
        assert_eq!(localhost.port, 9222);

        let ipv6 = validate_loopback_cdp_url("ws://[::1]:9229/devtools/browser/abc").unwrap();
        assert!(ipv6.is_loopback);
        assert_eq!(ipv6.host, "[::1]");
        assert_eq!(ipv6.connect_host, "::1");
        assert_eq!(ipv6.origin, "ws://[::1]:9229");

        // Non-loopback hosts must be rejected by default.
        for remote in [
            "http://192.168.1.25:9222",
            "http://example.com:9222",
            "http://localhost.evil.com:9222",
            "http://127.0.0.1.nip.io:9222",
            "ws://[::ffff:127.0.0.1]:9222",
        ] {
            let err = validate_loopback_cdp_url(remote).unwrap_err();
            let report = err.to_capability_report(None);
            assert_eq!(report.status, CapabilityStatus::Blocked, "url={remote}");
            assert_eq!(
                report.reason_code,
                CapabilityReason::NonLoopbackForbidden,
                "url={remote}"
            );
        }

        // Embedded userinfo credentials must always be blocked.
        let cred_err = validate_loopback_cdp_url("http://user:secret@127.0.0.1:9222").unwrap_err();
        let cred_report = cred_err.to_capability_report(None);
        assert_eq!(cred_report.status, CapabilityStatus::Blocked);
        assert_eq!(
            cred_report.reason_code,
            CapabilityReason::EmbeddedCredentialsForbidden
        );
        assert!(!cred_report.detail.contains("secret"));

        // Explicit opt-in permits non-loopback control endpoint and flags it transparently.
        let opted_in = validate_cdp_url_with_policy(
            "https://10.20.30.40:9222",
            CdpEndpointPolicy {
                allow_non_loopback: true,
            },
        )
        .unwrap();
        assert!(!opted_in.is_loopback);
        assert!(opted_in.non_loopback_opted_in);
    }

    #[test]
    fn cdp_version_and_list_parsers_decode_valid_and_reject_malformed_payloads() {
        let version_json = json!({
            "Browser": "Edg/130.0.2849.68",
            "Protocol-Version": "1.3",
            "User-Agent": "Mozilla/5.0",
            "V8-Version": "13.0.245.19",
            "WebKit-Version": "537.36",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/1111-2222"
        })
        .to_string();
        let version = parse_cdp_version(&version_json).expect("valid /json/version");
        assert_eq!(version.browser, "Edg/130.0.2849.68");
        assert_eq!(version.protocol_version, "1.3");
        assert_eq!(
            version.websocket_debugger_url.as_deref(),
            Some("ws://127.0.0.1:9222/devtools/browser/1111-2222")
        );

        let list_json = json!([
            {
                "description": "",
                "devtoolsFrontendUrl": "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/T1",
                "id": "T1",
                "title": "Omnia Studio",
                "type": "page",
                "url": "http://127.0.0.1:8787/",
                "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/T1"
            },
            {
                "id": "W2",
                "type": "service_worker",
                "title": "",
                "url": "http://127.0.0.1:8787/sw.js"
            }
        ])
        .to_string();
        let targets = parse_cdp_list(&list_json).expect("valid /json/list");
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].id, "T1");
        assert_eq!(targets[0].target_type, "page");
        assert_eq!(targets[1].target_type, "service_worker");

        assert!(parse_cdp_version(r#"{"Protocol-Version":"1.3"}"#).is_err());
        assert!(parse_cdp_list(r#"{"not":"an array"}"#).is_err());
        assert!(parse_cdp_list(r#"[{"id":"","type":"page"}]"#).is_err());
    }

    #[test]
    fn window_capture_accepts_valid_bgra_and_png_receipts() {
        let target = sample_window_identity();
        let pixels = non_blank_bgra_4x4();
        let digest = compute_sha256_hex(&pixels);
        let receipt = CaptureFrameReceipt {
            expected_target: target.clone(),
            observed_target: target.clone(),
            frame_width: 4,
            frame_height: 4,
            pixel_format: CapturePixelFormat::Bgra8,
            byte_len: pixels.len(),
            sha256_hex: digest.to_ascii_uppercase(),
            frame_bytes: Some(pixels),
            non_blank_verified: false, // raw pixel verifier checks pixels directly
        };
        let validated = validate_capture_receipt(&receipt).expect("valid BGRA receipt");
        assert_eq!(validated.sha256_hex, digest);
        assert!(validated.non_blank_verified);

        let report = evaluate_capture_receipt(&receipt);
        assert_eq!(report.status, CapabilityStatus::Available);
        assert_eq!(report.reason_code, CapabilityReason::Available);
        assert!(report.is_operational());

        // Also validate encoded PNG receipt path.
        let png = synthetic_minimal_png(4, 4);
        let png_receipt = CaptureFrameReceipt {
            expected_target: target.clone(),
            observed_target: target,
            frame_width: 4,
            frame_height: 4,
            pixel_format: CapturePixelFormat::Png,
            byte_len: png.len(),
            sha256_hex: compute_sha256_hex(&png),
            frame_bytes: Some(png),
            non_blank_verified: true,
        };
        assert_eq!(
            evaluate_capture_receipt(&png_receipt).status,
            CapabilityStatus::Available
        );
    }

    #[test]
    fn window_capture_detects_stale_hwnd_pid_reuse_and_geometry_drift() {
        let base = sample_window_identity();
        let pixels = non_blank_bgra_4x4();
        let sha = compute_sha256_hex(&pixels);

        // PID reuse: same HWND & PID, different process_create_time_100ns.
        let mut reused = base.clone();
        reused.process_create_time_100ns += 500;
        let reuse_receipt = CaptureFrameReceipt {
            expected_target: base.clone(),
            observed_target: reused,
            frame_width: 4,
            frame_height: 4,
            pixel_format: CapturePixelFormat::Bgra8,
            byte_len: pixels.len(),
            sha256_hex: sha.clone(),
            frame_bytes: Some(pixels.clone()),
            non_blank_verified: true,
        };
        let reuse_report = evaluate_capture_receipt(&reuse_receipt);
        assert_eq!(reuse_report.status, CapabilityStatus::StaleTarget);
        assert_eq!(reuse_report.reason_code, CapabilityReason::PidReuseDetected);
        assert!(!reuse_report.source_verified);

        // HWND drift.
        let mut hwnd_changed = base.clone();
        hwnd_changed.hwnd += 1;
        let hwnd_report = evaluate_capture_receipt(&CaptureFrameReceipt {
            observed_target: hwnd_changed,
            ..reuse_receipt.clone()
        });
        assert_eq!(hwnd_report.status, CapabilityStatus::StaleTarget);
        assert_eq!(hwnd_report.reason_code, CapabilityReason::HwndMismatch);

        // Zero HWND.
        let mut zero_hwnd = base.clone();
        zero_hwnd.hwnd = 0;
        let zero_report = probe_window_target_status(Some(&zero_hwnd));
        assert_eq!(zero_report.status, CapabilityStatus::StaleTarget);
        assert_eq!(zero_report.reason_code, CapabilityReason::InvalidHwnd);

        // Geometry drift mid-capture.
        let mut resized = base;
        resized.width = 8;
        let resize_report = evaluate_capture_receipt(&CaptureFrameReceipt {
            observed_target: resized,
            ..reuse_receipt
        });
        assert_eq!(resize_report.status, CapabilityStatus::StaleTarget);
        assert_eq!(
            resize_report.reason_code,
            CapabilityReason::GeometryMismatch
        );
    }

    #[test]
    fn window_capture_rejects_minimized_zero_area_and_oversized_targets() {
        let mut minimized = sample_window_identity();
        minimized.minimized = true;
        let min_report = probe_window_target_status(Some(&minimized));
        assert_eq!(min_report.status, CapabilityStatus::Blocked);
        assert_eq!(min_report.reason_code, CapabilityReason::WindowMinimized);

        let mut zero_area = sample_window_identity();
        zero_area.width = 0;
        let zero_report = probe_window_target_status(Some(&zero_area));
        assert_eq!(zero_report.status, CapabilityStatus::StaleTarget);
        assert_eq!(zero_report.reason_code, CapabilityReason::ZeroAreaWindow);

        let mut oversized = sample_window_identity();
        oversized.width = DEFAULT_MAX_CAPTURE_DIMENSION + 1;
        let over_report = probe_window_target_status(Some(&oversized));
        assert_eq!(over_report.status, CapabilityStatus::Blocked);
        assert_eq!(
            over_report.reason_code,
            CapabilityReason::DimensionExceedsLimit
        );
    }

    #[test]
    fn window_capture_rejects_blank_frames_bad_hashes_and_size_mismatches() {
        let target = sample_window_identity();

        // All-zero frame even with matching SHA-256 must fail BlankFrameDetected.
        let all_zero = vec![0u8; 4 * 4 * 4];
        let zero_receipt = CaptureFrameReceipt {
            expected_target: target.clone(),
            observed_target: target.clone(),
            frame_width: 4,
            frame_height: 4,
            pixel_format: CapturePixelFormat::Bgra8,
            byte_len: all_zero.len(),
            sha256_hex: compute_sha256_hex(&all_zero),
            frame_bytes: Some(all_zero),
            non_blank_verified: true,
        };
        let zero_report = evaluate_capture_receipt(&zero_receipt);
        assert_eq!(zero_report.status, CapabilityStatus::Error);
        assert_eq!(
            zero_report.reason_code,
            CapabilityReason::BlankFrameDetected
        );

        // Uniform solid-color frame must fail BlankFrameDetected.
        let uniform: Vec<u8> = [0x11, 0x22, 0x33, 0xFF].repeat(16);
        let uniform_report = evaluate_capture_receipt(&CaptureFrameReceipt {
            byte_len: uniform.len(),
            sha256_hex: compute_sha256_hex(&uniform),
            frame_bytes: Some(uniform),
            ..zero_receipt.clone()
        });
        assert_eq!(
            uniform_report.reason_code,
            CapabilityReason::BlankFrameDetected
        );

        // Hash mismatch on real pixel buffer.
        let valid_pixels = non_blank_bgra_4x4();
        let bad_hash_report = evaluate_capture_receipt(&CaptureFrameReceipt {
            byte_len: valid_pixels.len(),
            sha256_hex: "f".repeat(64),
            frame_bytes: Some(valid_pixels.clone()),
            ..zero_receipt.clone()
        });
        assert_eq!(bad_hash_report.status, CapabilityStatus::Error);
        assert_eq!(
            bad_hash_report.reason_code,
            CapabilityReason::FrameHashMismatch
        );

        // Empty-input SHA-256 rejected even if frame_bytes omitted.
        let empty_hash_report = evaluate_capture_receipt(&CaptureFrameReceipt {
            byte_len: valid_pixels.len(),
            sha256_hex: EMPTY_INPUT_SHA256_HEX.to_string(),
            frame_bytes: None,
            non_blank_verified: true,
            ..zero_receipt
        });
        assert_eq!(
            empty_hash_report.reason_code,
            CapabilityReason::EmptyFrameReceipt
        );
    }

    #[test]
    fn unconfigured_adapters_always_return_unavailable_never_available() {
        let cdp_unconf = probe_cdp_endpoint(
            None,
            CdpEndpointPolicy::default(),
            Duration::from_millis(200),
        );
        assert_eq!(cdp_unconf.0.status, CapabilityStatus::Unavailable);
        assert_eq!(cdp_unconf.0.reason_code, CapabilityReason::Unconfigured);
        assert!(!cdp_unconf.0.is_operational());
        assert!(cdp_unconf.1.is_none());

        let cdp_blank = probe_cdp_endpoint(
            Some("   "),
            CdpEndpointPolicy::default(),
            Duration::from_millis(200),
        );
        assert_eq!(cdp_blank.0.status, CapabilityStatus::Unavailable);

        let obs_unconf = probe_obs_endpoint(None, false, Duration::from_millis(200));
        assert_eq!(obs_unconf.status, CapabilityStatus::Unavailable);
        assert_eq!(obs_unconf.reason_code, CapabilityReason::Unconfigured);
        assert!(!obs_unconf.source_verified);

        let cap_unconf = probe_window_target_status(None);
        assert_eq!(cap_unconf.status, CapabilityStatus::Unavailable);
        assert_eq!(cap_unconf.reason_code, CapabilityReason::Unconfigured);

        let valid_target_no_frame = probe_window_target_status(Some(&sample_window_identity()));
        assert_eq!(valid_target_no_frame.status, CapabilityStatus::Unavailable);
        assert_eq!(
            valid_target_no_frame.reason_code,
            CapabilityReason::CaptureReceiptRequired
        );
        assert!(!valid_target_no_frame.source_verified);

        // Deserializing forged source_verified=true on unavailable status must neutralize it.
        let forged = json!({
            "adapter": "obs_v5",
            "status": "unavailable",
            "reason_code": "UNCONFIGURED",
            "detail": "forged",
            "source_verified": true
        });
        let decoded: CapabilityReport = serde_json::from_value(forged).unwrap();
        assert!(!decoded.source_verified);
        assert!(!decoded.is_operational());
    }

    #[test]
    fn live_loopback_tcp_and_cdp_http_probe_verify_reachability_and_refusal() {
        // 1. Live loopback TCP listener -> Available.
        let tcp_listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral loopback");
        let tcp_addr = tcp_listener.local_addr().unwrap();
        let tcp_handle = thread::spawn(move || {
            let _ = accept_bounded(&tcp_listener, Instant::now() + Duration::from_secs(3));
        });
        let tcp_ok = probe_loopback_tcp(
            AdapterKind::ObsV5,
            "127.0.0.1",
            tcp_addr.port(),
            false,
            Duration::from_millis(500),
        );
        let _ = tcp_handle.join();
        assert_eq!(tcp_ok.status, CapabilityStatus::Available);
        assert!(tcp_ok.is_operational());
        assert!(tcp_ok.latency_ms.is_some());

        // 2. Dropped listener port -> protocol probes must report Unavailable (even behind WFP proxies).
        let closed_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let closed_port = closed_listener.local_addr().unwrap().port();
        drop(closed_listener);
        let (cdp_closed, cdp_closed_snap) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{closed_port}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(250),
        );
        assert_eq!(cdp_closed.status, CapabilityStatus::Unavailable);
        assert!(matches!(
            cdp_closed.reason_code,
            CapabilityReason::EndpointUnreachable | CapabilityReason::Timeout
        ));
        assert!(!cdp_closed.source_verified);
        assert!(cdp_closed_snap.is_none());

        let obs_closed = probe_obs_endpoint(
            Some(&format!("ws://127.0.0.1:{closed_port}")),
            false,
            Duration::from_millis(250),
        );
        assert_eq!(obs_closed.status, CapabilityStatus::Unavailable);
        assert!(matches!(
            obs_closed.reason_code,
            CapabilityReason::EndpointUnreachable | CapabilityReason::Timeout
        ));
        assert!(!obs_closed.source_verified);

        // 3. Live loopback HTTP mock for CDP /json/version + /json/list -> Available.
        let cdp_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cdp_port = cdp_listener.local_addr().unwrap().port();
        let server_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            for _ in 0..2 {
                let Some(mut stream) = accept_bounded(&cdp_listener, deadline) else {
                    break;
                };
                let req_str = read_http_request_bounded(&mut stream);
                let target = req_str
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1);
                let body = if target == Some("/json/version") {
                    json!({
                        "Browser": "Edg/130.0.2849.68",
                        "Protocol-Version": "1.3",
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{cdp_port}/devtools/browser/live-1")
                    })
                    .to_string()
                } else {
                    json!([{
                        "id": "PAGE-1",
                        "type": "page",
                        "title": "Omnia Flagship Studio",
                        "url": "http://127.0.0.1:8787/",
                        "webSocketDebuggerUrl": format!("ws://127.0.0.1:{cdp_port}/devtools/page/PAGE-1")
                    }])
                    .to_string()
                };
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                write_http_response_and_close(&mut stream, resp.as_bytes());
            }
        });

        let cdp_url = format!("http://127.0.0.1:{cdp_port}");
        let (report, snapshot) = probe_cdp_endpoint(
            Some(&cdp_url),
            CdpEndpointPolicy::default(),
            Duration::from_millis(1000),
        );
        server_thread.join().unwrap();
        assert_eq!(
            report.status,
            CapabilityStatus::Available,
            "detail={}",
            report.detail
        );
        assert!(report.is_operational());
        let snap = snapshot.expect("snapshot populated");
        assert_eq!(snap.version.browser, "Edg/130.0.2849.68");
        assert_eq!(snap.targets.len(), 1);
        assert_eq!(snap.targets[0].id, "PAGE-1");
    }

    #[test]
    fn cdp_probe_blocks_rogue_non_loopback_debugger_url_from_server() {
        let cdp_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let cdp_port = cdp_listener.local_addr().unwrap().port();
        let server_thread = thread::spawn(move || {
            let Some(mut stream) =
                accept_bounded(&cdp_listener, Instant::now() + Duration::from_secs(3))
            else {
                return;
            };
            let _ = read_http_request_bounded(&mut stream);
            let body = json!({
                "Browser": "Chrome/130.0.0.0",
                "Protocol-Version": "1.3",
                "webSocketDebuggerUrl": "ws://evil.remote.host:9222/devtools/browser/hijack"
            })
            .to_string();
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            write_http_response_and_close(&mut stream, resp.as_bytes());
        });

        let cdp_url = format!("http://127.0.0.1:{cdp_port}");
        let (report, snapshot) = probe_cdp_endpoint(
            Some(&cdp_url),
            CdpEndpointPolicy::default(),
            Duration::from_millis(1000),
        );
        server_thread.join().unwrap();
        assert_eq!(report.status, CapabilityStatus::Blocked);
        assert_eq!(report.reason_code, CapabilityReason::NonLoopbackForbidden);
        assert!(!report.source_verified);
        assert!(snapshot.is_none());
    }

    #[test]
    fn obs_v5_ws_url_loopback_validation_and_live_tcp_probe() {
        let ok = validate_obs_ws_url("ws://127.0.0.1:4455", false).unwrap();
        assert!(ok.is_loopback);
        assert_eq!(ok.port, 4455);

        let wrong_scheme = validate_obs_ws_url("http://127.0.0.1:4455", false).unwrap_err();
        assert_eq!(
            wrong_scheme.to_capability_report(None).status,
            CapabilityStatus::Error
        );

        let remote_blocked = validate_obs_ws_url("wss://obs.remote.lan:4455", false).unwrap_err();
        assert_eq!(
            remote_blocked.to_capability_report(None).status,
            CapabilityStatus::Blocked
        );

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let Some(mut stream) =
                accept_bounded(&listener, Instant::now() + Duration::from_secs(3))
            else {
                return;
            };
            let _ = read_http_request_bounded(&mut stream);
            write_http_response_and_close(
                &mut stream,
                b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            );
        });
        let probe_url = format!("ws://127.0.0.1:{port}");
        let report = probe_obs_endpoint(Some(&probe_url), false, Duration::from_millis(500));
        handle.join().unwrap();
        assert_eq!(report.adapter, AdapterKind::ObsV5);
        assert_eq!(
            report.status,
            CapabilityStatus::Available,
            "detail={}",
            report.detail
        );
        assert!(report.is_operational());

        // Plain HTTP 200 (non-WebSocket server) must fail with ProtocolError, never Available.
        let http_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let http_port = http_listener.local_addr().unwrap().port();
        let http_handle = thread::spawn(move || {
            let Some(mut stream) =
                accept_bounded(&http_listener, Instant::now() + Duration::from_secs(3))
            else {
                return;
            };
            let _ = read_http_request_bounded(&mut stream);
            write_http_response_and_close(
                &mut stream,
                b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
            );
        });
        let bad_report = probe_obs_endpoint(
            Some(&format!("ws://127.0.0.1:{http_port}")),
            false,
            Duration::from_millis(500),
        );
        http_handle.join().unwrap();
        assert_eq!(bad_report.status, CapabilityStatus::Error);
        assert_eq!(bad_report.reason_code, CapabilityReason::ProtocolError);
        assert!(!bad_report.source_verified);
    }

    #[test]
    fn capability_report_serde_roundtrip_preserves_all_five_statuses() {
        let reports = [
            CapabilityReport::available(
                AdapterKind::BrowserCdp,
                "verified",
                Some("http://127.0.0.1:9222".to_string()),
                Some(3),
            ),
            CapabilityReport::unconfigured(AdapterKind::ObsV5, "OMNIA_OBS_URL"),
            CapabilityReport::failure(
                AdapterKind::BrowserCdp,
                CapabilityStatus::Blocked,
                CapabilityReason::NonLoopbackForbidden,
                "blocked remote host",
                None,
            ),
            CapabilityReport::failure(
                AdapterKind::WindowCapture,
                CapabilityStatus::StaleTarget,
                CapabilityReason::PidReuseDetected,
                "pid recycled",
                None,
            ),
            CapabilityReport::failure(
                AdapterKind::WindowCapture,
                CapabilityStatus::Error,
                CapabilityReason::FrameHashMismatch,
                "hash mismatch",
                None,
            ),
        ];
        for report in reports {
            let serialized = serde_json::to_string(&report).unwrap();
            let decoded: CapabilityReport = serde_json::from_str(&serialized).unwrap();
            assert_eq!(decoded, report);
        }
    }

    #[test]
    fn window_capture_metadata_only_receipt_validates_stride_and_non_blank_flag() {
        let target = sample_window_identity();
        let sha = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00".to_string();

        let valid_meta = CaptureFrameReceipt {
            expected_target: target.clone(),
            observed_target: target.clone(),
            frame_width: 4,
            frame_height: 4,
            pixel_format: CapturePixelFormat::Rgba8,
            byte_len: 64,
            sha256_hex: sha.clone(),
            frame_bytes: None,
            non_blank_verified: true,
        };
        assert_eq!(
            evaluate_capture_receipt(&valid_meta).status,
            CapabilityStatus::Available
        );

        let unverified_blank = CaptureFrameReceipt {
            non_blank_verified: false,
            ..valid_meta.clone()
        };
        assert_eq!(
            evaluate_capture_receipt(&unverified_blank).reason_code,
            CapabilityReason::BlankFrameDetected
        );

        let wrong_stride = CaptureFrameReceipt {
            byte_len: 60,
            ..valid_meta
        };
        assert_eq!(
            evaluate_capture_receipt(&wrong_stride).reason_code,
            CapabilityReason::FrameSizeMismatch
        );
    }

    #[test]
    fn cdp_probe_handles_chunked_http_and_non_200_errors() {
        let err_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let err_port = err_listener.local_addr().unwrap().port();
        let err_thread = thread::spawn(move || {
            let Some(mut stream) =
                accept_bounded(&err_listener, Instant::now() + Duration::from_secs(3))
            else {
                return;
            };
            let _ = read_http_request_bounded(&mut stream);
            write_http_response_and_close(
                &mut stream,
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        });
        let (err_report, err_snap) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{err_port}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        err_thread.join().unwrap();
        assert_eq!(err_report.status, CapabilityStatus::Error);
        assert_eq!(err_report.reason_code, CapabilityReason::ProtocolError);
        assert!(err_snap.is_none());

        let chunk_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let chunk_port = chunk_listener.local_addr().unwrap().port();
        let chunk_thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            for _ in 0..2 {
                let Some(mut stream) = accept_bounded(&chunk_listener, deadline) else {
                    break;
                };
                let req_str = read_http_request_bounded(&mut stream);
                let target = req_str
                    .lines()
                    .next()
                    .unwrap_or("")
                    .split_whitespace()
                    .nth(1);
                let payload = if target == Some("/json/version") {
                    json!({
                        "Browser": "Chrome/131.0.0.0",
                        "Protocol-Version": "1.3"
                    })
                    .to_string()
                } else {
                    "[]".to_string()
                };
                let chunk_resp = format!(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                    payload.len(),
                    payload
                );
                write_http_response_and_close(&mut stream, chunk_resp.as_bytes());
            }
        });
        let (ok_report, ok_snap) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{chunk_port}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        chunk_thread.join().unwrap();
        assert_eq!(
            ok_report.status,
            CapabilityStatus::Available,
            "detail={}",
            ok_report.detail
        );
        assert_eq!(ok_snap.unwrap().version.browser, "Chrome/131.0.0.0");
    }

    fn serve_single_http_response(raw_response: &'static [u8]) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            if let Some(mut stream) = accept_bounded(&listener, deadline) {
                let _ = read_http_request_bounded(&mut stream);
                write_http_response_and_close(&mut stream, raw_response);
            }
        });
        (port, handle)
    }

    #[test]
    fn cdp_probe_rejects_malformed_and_conflicting_content_length() {
        let malformed_resp =
            b"HTTP/1.1 200 OK\r\nContent-Length: nope\r\nConnection: close\r\n\r\n{}";
        let (port1, handle1) = serve_single_http_response(malformed_resp);
        let (rep1, snap1) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{port1}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        handle1.join().unwrap();
        assert_eq!(
            rep1.status,
            CapabilityStatus::Error,
            "detail={}",
            rep1.detail
        );
        assert_eq!(rep1.reason_code, CapabilityReason::ProtocolError);
        assert!(!rep1.source_verified);
        assert!(snap1.is_none());

        let conflicting_resp =
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 4\r\nConnection: close\r\n\r\n{}";
        let (port2, handle2) = serve_single_http_response(conflicting_resp);
        let (rep2, snap2) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{port2}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        handle2.join().unwrap();
        assert_eq!(
            rep2.status,
            CapabilityStatus::Error,
            "detail={}",
            rep2.detail
        );
        assert_eq!(rep2.reason_code, CapabilityReason::ProtocolError);
        assert!(!rep2.source_verified);
        assert!(snap2.is_none());
    }

    #[test]
    fn cdp_probe_rejects_bad_zero_chunk_trailer_bytes() {
        let bad_trailer_resp =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\nXX";
        let (port1, handle1) = serve_single_http_response(bad_trailer_resp);
        let (rep1, snap1) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{port1}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        handle1.join().unwrap();
        assert_eq!(
            rep1.status,
            CapabilityStatus::Error,
            "detail={}",
            rep1.detail
        );
        assert_eq!(rep1.reason_code, CapabilityReason::ProtocolError);
        assert!(!rep1.source_verified);
        assert!(snap1.is_none());

        let bad_trailer_crlf_resp =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n2\r\n{}\r\n0\r\nXY\r\n";
        let (port2, handle2) = serve_single_http_response(bad_trailer_crlf_resp);
        let (rep2, snap2) = probe_cdp_endpoint(
            Some(&format!("http://127.0.0.1:{port2}")),
            CdpEndpointPolicy::default(),
            Duration::from_millis(500),
        );
        handle2.join().unwrap();
        assert_eq!(
            rep2.status,
            CapabilityStatus::Error,
            "detail={}",
            rep2.detail
        );
        assert_eq!(rep2.reason_code, CapabilityReason::ProtocolError);
        assert!(!rep2.source_verified);
        assert!(snap2.is_none());
    }
}
