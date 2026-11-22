//! Bounded length-prefixed wire transport and authenticated loopback TCP helpers.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use thiserror::Error;

use crate::protocol::{
    FrameEnvelope, FramePayload, PeerSession, ProtocolError, MAX_FRAME_WIRE_BYTES,
};

/// Errors produced by framed TCP/stream transport.
#[derive(Debug, Error)]
pub enum TransportError {
    /// Underlying stream closed cleanly at a frame boundary.
    #[error("connection closed cleanly at frame boundary")]
    ConnectionClosed,
    /// Underlying stream ended mid-frame header or body.
    #[error("truncated frame on wire: {0}")]
    TruncatedFrame(String),
    /// Frame header length was zero.
    #[error("invalid zero-length frame header")]
    EmptyFrame,
    /// Frame header length exceeded [`MAX_FRAME_WIRE_BYTES`] prior to allocation.
    #[error("frame length {len} bytes exceeds maximum {max} bytes")]
    FrameTooLarge { len: usize, max: usize },
    /// Non-loopback target rejected by loopback-only connect helper.
    #[error("refusing non-loopback address {addr}")]
    NonLoopbackAddress { addr: SocketAddr },
    /// Protocol-level authentication, scope, replay, or payload validation error.
    #[error("protocol error: {0}")]
    Protocol(#[from] ProtocolError),
    /// Underlying I/O failure.
    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}

/// Writes a length-prefixed JSON [`FrameEnvelope`] (`4`-byte big-endian length + JSON bytes).
pub fn write_frame<W: Write>(
    writer: &mut W,
    envelope: &FrameEnvelope,
) -> Result<usize, TransportError> {
    let payload = envelope.to_bounded_json_bytes()?;
    let frame_len = payload.len();
    if frame_len == 0 {
        return Err(TransportError::EmptyFrame);
    }
    if frame_len > MAX_FRAME_WIRE_BYTES {
        return Err(TransportError::FrameTooLarge {
            len: frame_len,
            max: MAX_FRAME_WIRE_BYTES,
        });
    }
    let header = u32::try_from(frame_len)
        .map_err(|_| TransportError::FrameTooLarge {
            len: frame_len,
            max: MAX_FRAME_WIRE_BYTES,
        })?
        .to_be_bytes();

    writer.write_all(&header)?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(header.len() + frame_len)
}

/// Reads and deserializes a bounded length-prefixed JSON [`FrameEnvelope`].
pub fn read_frame<R: Read>(reader: &mut R) -> Result<FrameEnvelope, TransportError> {
    let mut header = [0u8; 4];
    match read_first_byte(reader)? {
        Some(first) => header[0] = first,
        None => return Err(TransportError::ConnectionClosed),
    }
    reader
        .read_exact(&mut header[1..])
        .map_err(map_truncated_eof)?;

    let frame_len = u32::from_be_bytes(header) as usize;
    if frame_len == 0 {
        return Err(TransportError::EmptyFrame);
    }
    if frame_len > MAX_FRAME_WIRE_BYTES {
        return Err(TransportError::FrameTooLarge {
            len: frame_len,
            max: MAX_FRAME_WIRE_BYTES,
        });
    }

    let mut buf = vec![0u8; frame_len];
    reader.read_exact(&mut buf).map_err(map_truncated_eof)?;
    Ok(FrameEnvelope::from_bounded_json_bytes(&buf)?)
}

/// Seals, signs, and writes an authenticated outbound frame over `writer`.
pub fn send_authenticated_frame<W: Write>(
    writer: &mut W,
    session: &mut PeerSession,
    payload: FramePayload,
    now_ms: u64,
) -> Result<FrameEnvelope, TransportError> {
    let envelope = session.seal_outbound(payload, now_ms)?;
    write_frame(writer, &envelope)?;
    Ok(envelope)
}

/// Reads, authenticates, validates scope/anti-replay, and returns an inbound frame.
pub fn recv_authenticated_frame<R: Read>(
    reader: &mut R,
    session: &mut PeerSession,
    now_ms: u64,
) -> Result<(FrameEnvelope, FramePayload), TransportError> {
    let envelope = read_frame(reader)?;
    let payload = session.open_inbound(&envelope, now_ms)?;
    Ok((envelope, payload))
}

/// Binds an ephemeral IPv4 loopback TCP listener on `127.0.0.1:0`.
pub fn bind_loopback_listener() -> Result<(TcpListener, SocketAddr), TransportError> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let addr = listener.local_addr()?;
    Ok((listener, addr))
}

/// Connects to an explicit loopback TCP socket address with bounded read/write timeouts.
pub fn connect_loopback(
    addr: SocketAddr,
    io_timeout: Duration,
) -> Result<TcpStream, TransportError> {
    if !addr.ip().is_loopback() {
        return Err(TransportError::NonLoopbackAddress { addr });
    }
    let stream = TcpStream::connect_timeout(&addr, io_timeout)?;
    configure_stream(&stream, io_timeout)?;
    Ok(stream)
}

/// Applies `TCP_NODELAY` and bounded read/write timeouts to an accepted or connected stream.
pub fn configure_stream(stream: &TcpStream, io_timeout: Duration) -> Result<(), TransportError> {
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(io_timeout))?;
    stream.set_write_timeout(Some(io_timeout))?;
    Ok(())
}

fn read_first_byte<R: Read>(reader: &mut R) -> io::Result<Option<u8>> {
    let mut byte = [0u8; 1];
    loop {
        match reader.read(&mut byte) {
            Ok(0) => return Ok(None),
            Ok(_) => return Ok(Some(byte[0])),
            Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        }
    }
}

fn map_truncated_eof(err: io::Error) -> TransportError {
    if err.kind() == io::ErrorKind::UnexpectedEof {
        TransportError::TruncatedFrame(err.to_string())
    } else {
        TransportError::Io(err)
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;
    use std::net::Shutdown;
    use std::sync::{Arc, Mutex};
    use std::thread;

    use super::*;
    use crate::crypto::sha256_hex;
    use crate::pairing::{
        complete_pairing_approver, complete_pairing_initiator, CapabilityScope, PairingApproval,
        PairingOffer,
    };
    use crate::protocol::{ButtonAction, KeyAction, MouseButton, TouchAction, TouchPoint};
    use crate::replay::ReplayError;

    const SECRET: &[u8] = b"omnia-loopback-tcp-secret";

    fn build_paired_sessions() -> (PeerSession, PeerSession) {
        let offer = PairingOffer::create(
            "sess-tcp-01",
            "host-desktop",
            "controller-mobile",
            "offer-nonce-tcp",
            vec![
                CapabilityScope::MouseInput,
                CapabilityScope::KeyboardInput,
                CapabilityScope::TouchInput,
            ],
            vec![CapabilityScope::ScreenStream],
            10_000,
            20_000,
            120_000,
            SECRET,
        )
        .expect("offer");

        let approval = PairingApproval::approve(
            &offer,
            "controller-mobile",
            "approval-nonce-tcp",
            vec![
                CapabilityScope::MouseInput,
                CapabilityScope::KeyboardInput,
                CapabilityScope::TouchInput,
            ],
            vec![CapabilityScope::ScreenStream],
            SECRET,
            10_100,
        )
        .expect("approval");

        let (h_lease, h_key) =
            complete_pairing_initiator(&offer, &approval, SECRET, 10_200).expect("host");
        let (c_lease, c_key) =
            complete_pairing_approver(&offer, &approval, SECRET, 10_200).expect("ctrl");

        (
            PeerSession::new(h_lease, h_key).expect("host session"),
            PeerSession::new(c_lease, c_key).expect("ctrl session"),
        )
    }

    #[test]
    fn write_and_read_frame_rejects_oversized_length_prefix_without_oom() {
        let oversized_len = (MAX_FRAME_WIRE_BYTES as u32) + 1;
        let mut raw = oversized_len.to_be_bytes().to_vec();
        raw.extend_from_slice(b"{}");
        let mut cursor = Cursor::new(raw);
        let err = read_frame(&mut cursor).expect_err("oversized header must fail before read");
        assert!(matches!(
            err,
            TransportError::FrameTooLarge {
                len,
                max: MAX_FRAME_WIRE_BYTES
            } if len == MAX_FRAME_WIRE_BYTES + 1
        ));

        let mut empty_cursor = Cursor::new(Vec::<u8>::new());
        assert!(matches!(
            read_frame(&mut empty_cursor),
            Err(TransportError::ConnectionClosed)
        ));
    }

    #[test]
    fn loopback_tcp_bidirectional_authenticated_exchange_and_clean_disconnect() {
        let (host_session, ctrl_session) = build_paired_sessions();
        let host_arc = Arc::new(Mutex::new(host_session));
        let ctrl_arc = Arc::new(Mutex::new(ctrl_session));

        let (listener, addr) = bind_loopback_listener().expect("bind 127.0.0.1:0");
        assert!(addr.ip().is_loopback());
        let timeout = Duration::from_secs(5);

        let host_handle = {
            let host_arc = Arc::clone(&host_arc);
            thread::spawn(move || {
                let (stream, peer_addr) = listener.accept().expect("accept client");
                assert!(peer_addr.ip().is_loopback());
                configure_stream(&stream, timeout).expect("configure host stream");

                let mut reader = stream.try_clone().expect("clone host read");
                let mut writer = stream;

                let write_host = Arc::clone(&host_arc);
                let writer_thread = thread::spawn(move || {
                    for idx in 1..=3u64 {
                        let env = {
                            let mut guard = write_host.lock().expect("lock host");
                            guard
                                .seal_outbound(
                                    FramePayload::ScreenFrameHeader {
                                        frame_id: idx,
                                        width: 1920,
                                        height: 1080,
                                        format: "bgra8".to_string(),
                                        byte_len: 4096,
                                        sha256_hex: sha256_hex(format!("frame-{idx}").as_bytes()),
                                        keyframe: idx == 1,
                                        preview_base64: None,
                                    },
                                    11_000 + idx,
                                )
                                .expect("seal screen")
                        };
                        write_frame(&mut writer, &env).expect("write screen");
                    }

                    let hb = {
                        let mut guard = write_host.lock().expect("lock host");
                        guard
                            .seal_outbound(
                                FramePayload::Heartbeat {
                                    ping_nonce: 707,
                                    echo_nonce: None,
                                },
                                11_010,
                            )
                            .expect("seal heartbeat")
                    };
                    write_frame(&mut writer, &hb).expect("write heartbeat");

                    let disc = {
                        let mut guard = write_host.lock().expect("lock host");
                        guard
                            .seal_outbound(
                                FramePayload::DisconnectNotice {
                                    reason: "host session complete".to_string(),
                                    graceful: true,
                                },
                                11_020,
                            )
                            .expect("seal disconnect")
                    };
                    write_frame(&mut writer, &disc).expect("write disconnect");
                    writer
                });

                let mut received = Vec::new();
                loop {
                    match read_frame(&mut reader) {
                        Ok(env) => {
                            let payload = {
                                let mut guard = host_arc.lock().expect("lock host");
                                guard.open_inbound(&env, 11_050).expect("open ctrl frame")
                            };
                            let is_disconnect =
                                matches!(payload, FramePayload::DisconnectNotice { .. });
                            received.push(payload);
                            if is_disconnect {
                                break;
                            }
                        }
                        Err(TransportError::ConnectionClosed) => break,
                        Err(other) => panic!("unexpected host read error: {other}"),
                    }
                }
                let writer = writer_thread.join().expect("host writer joins");
                writer
                    .shutdown(Shutdown::Write)
                    .expect("shutdown host write");
                assert!(matches!(
                    read_frame(&mut reader),
                    Err(TransportError::ConnectionClosed)
                ));
                received
            })
        };

        let ctrl_handle = {
            let ctrl_arc = Arc::clone(&ctrl_arc);
            thread::spawn(move || {
                let stream = connect_loopback(addr, timeout).expect("connect loopback");
                let mut reader = stream.try_clone().expect("clone ctrl read");
                let mut writer = stream;

                let write_ctrl = Arc::clone(&ctrl_arc);
                let writer_thread = thread::spawn(move || {
                    let payloads = vec![
                        FramePayload::MouseMove {
                            x: 0.4,
                            y: 0.6,
                            display_id: 0,
                        },
                        FramePayload::MouseClick {
                            x: 0.4,
                            y: 0.6,
                            button: MouseButton::Left,
                            action: ButtonAction::Click,
                            display_id: 0,
                        },
                        FramePayload::KeyEvent {
                            key_code: "KeyK".to_string(),
                            action: KeyAction::Press,
                            shift: false,
                            ctrl: true,
                            alt: false,
                            meta: false,
                            repeat: false,
                        },
                        FramePayload::TouchEvent {
                            action: TouchAction::Move,
                            display_id: 0,
                            points: vec![TouchPoint {
                                pointer_id: 1,
                                x: 0.25,
                                y: 0.75,
                                pressure: 0.5,
                            }],
                        },
                        FramePayload::Heartbeat {
                            ping_nonce: 808,
                            echo_nonce: Some(707),
                        },
                        FramePayload::DisconnectNotice {
                            reason: "controller finished".to_string(),
                            graceful: true,
                        },
                    ];

                    for (offset, payload) in payloads.into_iter().enumerate() {
                        let env = {
                            let mut guard = write_ctrl.lock().expect("lock ctrl");
                            guard
                                .seal_outbound(payload, 11_030 + (offset as u64))
                                .expect("seal ctrl payload")
                        };
                        write_frame(&mut writer, &env).expect("write ctrl payload");
                    }
                    writer
                });

                let mut received = Vec::new();
                loop {
                    match read_frame(&mut reader) {
                        Ok(env) => {
                            let payload = {
                                let mut guard = ctrl_arc.lock().expect("lock ctrl");
                                guard.open_inbound(&env, 11_050).expect("open host frame")
                            };
                            let is_disconnect =
                                matches!(payload, FramePayload::DisconnectNotice { .. });
                            received.push(payload);
                            if is_disconnect {
                                break;
                            }
                        }
                        Err(TransportError::ConnectionClosed) => break,
                        Err(other) => panic!("unexpected ctrl read error: {other}"),
                    }
                }
                let writer = writer_thread.join().expect("ctrl writer joins");
                writer
                    .shutdown(Shutdown::Write)
                    .expect("shutdown ctrl write");
                assert!(matches!(
                    read_frame(&mut reader),
                    Err(TransportError::ConnectionClosed)
                ));
                received
            })
        };

        let host_received = host_handle.join().expect("host thread");
        let ctrl_received = ctrl_handle.join().expect("ctrl thread");

        assert_eq!(host_received.len(), 6);
        assert!(matches!(host_received[0], FramePayload::MouseMove { .. }));
        assert!(matches!(host_received[1], FramePayload::MouseClick { .. }));
        assert!(matches!(host_received[2], FramePayload::KeyEvent { .. }));
        assert!(matches!(host_received[3], FramePayload::TouchEvent { .. }));
        assert!(matches!(host_received[4], FramePayload::Heartbeat { .. }));
        assert!(matches!(
            host_received[5],
            FramePayload::DisconnectNotice { graceful: true, .. }
        ));

        assert_eq!(ctrl_received.len(), 5);
        assert!(matches!(
            ctrl_received[0],
            FramePayload::ScreenFrameHeader { frame_id: 1, .. }
        ));
        assert!(matches!(
            ctrl_received[3],
            FramePayload::Heartbeat {
                ping_nonce: 707,
                ..
            }
        ));
        assert!(matches!(
            ctrl_received[4],
            FramePayload::DisconnectNotice { graceful: true, .. }
        ));

        let host_guard = host_arc.lock().expect("lock host");
        assert!(host_guard.is_local_disconnected());
        assert!(host_guard.is_peer_disconnected());
        assert_eq!(host_guard.inbound_accepted_count(), 6);
        assert_eq!(host_guard.audit_log().len(), 11);

        let ctrl_guard = ctrl_arc.lock().expect("lock ctrl");
        assert!(ctrl_guard.is_local_disconnected());
        assert!(ctrl_guard.is_peer_disconnected());
        assert_eq!(ctrl_guard.inbound_accepted_count(), 5);
        assert_eq!(ctrl_guard.audit_log().len(), 11);
    }

    #[test]
    fn loopback_tcp_rejects_replayed_and_revoked_frames_mid_stream() {
        let (mut host_session, mut ctrl_session) = build_paired_sessions();
        let (listener, addr) = bind_loopback_listener().expect("bind loopback");
        let timeout = Duration::from_secs(5);

        let env1 = ctrl_session
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.1,
                    y: 0.2,
                    display_id: 0,
                },
                11_000,
            )
            .expect("env1");
        let env2 = ctrl_session
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.3,
                    y: 0.4,
                    display_id: 0,
                },
                11_010,
            )
            .expect("env2");

        let env1_replay = env1.clone();
        let client = thread::spawn(move || {
            let mut stream = connect_loopback(addr, timeout).expect("connect");
            write_frame(&mut stream, &env1).expect("write env1");
            write_frame(&mut stream, &env1_replay).expect("write replay");
            write_frame(&mut stream, &env2).expect("write env2");
        });

        let (mut server_stream, _) = listener.accept().expect("accept");
        configure_stream(&server_stream, timeout).expect("cfg");

        let first = recv_authenticated_frame(&mut server_stream, &mut host_session, 11_001);
        assert!(first.is_ok());

        let replay = recv_authenticated_frame(&mut server_stream, &mut host_session, 11_002);
        assert!(matches!(
            replay,
            Err(TransportError::Protocol(ProtocolError::Replay(
                ReplayError::DuplicateSequence { seq: 1 }
            )))
        ));

        // Revoke mid-stream before reading env2 -> must fail closed!
        host_session.revoke("revoked during live TCP stream");
        let post_revoke = recv_authenticated_frame(&mut server_stream, &mut host_session, 11_011);
        assert!(matches!(
            post_revoke,
            Err(TransportError::Protocol(ProtocolError::Pairing(
                crate::pairing::PairingError::LeaseRevoked { .. }
            )))
        ));

        client.join().expect("client join");
    }

    #[test]
    fn loopback_tcp_accepts_reordered_frames_and_rejects_non_loopback_address() {
        let non_loopback: SocketAddr = "192.0.2.1:9999".parse().expect("valid ip");
        assert!(matches!(
            connect_loopback(non_loopback, Duration::from_millis(50)),
            Err(TransportError::NonLoopbackAddress { .. })
        ));

        let (mut host_session, mut ctrl_session) = build_paired_sessions();
        let (listener, addr) = bind_loopback_listener().expect("bind loopback");
        let timeout = Duration::from_secs(5);

        let env1 = ctrl_session
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.1,
                    y: 0.1,
                    display_id: 0,
                },
                12_001,
            )
            .expect("seq 1");
        let env2 = ctrl_session
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.2,
                    y: 0.2,
                    display_id: 0,
                },
                12_002,
            )
            .expect("seq 2");
        let env3 = ctrl_session
            .seal_outbound(
                FramePayload::MouseMove {
                    x: 0.3,
                    y: 0.3,
                    display_id: 0,
                },
                12_003,
            )
            .expect("seq 3");

        let client = thread::spawn(move || {
            let mut stream = connect_loopback(addr, timeout).expect("connect");
            // Deliver out of order: seq 3 -> seq 1 -> seq 2
            write_frame(&mut stream, &env3).expect("write seq 3");
            write_frame(&mut stream, &env1).expect("write seq 1");
            write_frame(&mut stream, &env2).expect("write seq 2");
        });

        let (mut server_stream, _) = listener.accept().expect("accept");
        configure_stream(&server_stream, timeout).expect("cfg");

        for expected_seq in [3u64, 1, 2] {
            let (env, _) = recv_authenticated_frame(&mut server_stream, &mut host_session, 12_010)
                .expect("reordered frame within 64-packet window must succeed");
            assert_eq!(env.seq, expected_seq);
        }
        assert_eq!(host_session.highest_inbound_seq(), 3);
        assert_eq!(host_session.inbound_accepted_count(), 3);

        client.join().expect("client join");
    }
}
