import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  buildComputerUseOverlayVisualSpec,
  completeAndAuditComputerUseVideo,
  DEFAULT_REMOTE_CAPTURE_SURFACES,
  enforceVideoRingBufferFifoLimit,
  handleComputerUseKillSwitchHotkey,
  markAndExtractVideoSegmentKeyframes,
  recordComputerUseActionInVideo,
  startComputerUseVideoCapture,
  VIDEO_RING_BUFFER_MAX_BYTES,
  type ComputerUseRingBufferStore,
} from "@/domain/sovereign-ide-remote-desktop";

export interface ComputerUseVideoOverlayPanelProps {
  readonly surfaceId?: string | undefined;
  readonly surfaceLabel?: string | undefined;
  readonly processName?: string | undefined;
  readonly testIdPrefix?: string | undefined;
}

export function ComputerUseVideoOverlayPanel(
  props: ComputerUseVideoOverlayPanelProps = {},
): React.JSX.Element {
  const prefix = props.testIdPrefix ?? "computer-use-video";

  const [store, setStore] = useState<ComputerUseRingBufferStore>(() => {
    const surface =
      DEFAULT_REMOTE_CAPTURE_SURFACES.find((s) => s.id === props.surfaceId) ??
      DEFAULT_REMOTE_CAPTURE_SURFACES[3] ??
      DEFAULT_REMOTE_CAPTURE_SURFACES[0]!;
    const cap1 = startComputerUseVideoCapture({
      captureId: `cu-video-${surface.id}-1`,
      captureNumber: 1,
      surface,
      startedAtMs: 1_760_000_000_000,
    });
    const withAction = recordComputerUseActionInVideo(cap1, {
      mouseIndex: 1,
      actionLabel: "Click explorer tree and focus editor tab",
      x: 640,
      y: 360,
      keyOrChord: "Ctrl+Shift+P",
      isAboutToType: true,
      durationDeltaMs: 420,
      bytesDelta: 4_200_000,
    });
    const seg1 = markAndExtractVideoSegmentKeyframes(withAction, "M1", 6_400_000);
    return enforceVideoRingBufferFifoLimit([seg1.session], VIDEO_RING_BUFFER_MAX_BYTES);
  });

  const [lastKillSwitchMessage, setLastKillSwitchMessage] = useState<string>("");
  const escapeArmedAtRef = useRef<number>(0);
  const escapeHeldRef = useRef<boolean>(false);

  const activeRecordingCaptures = useMemo(
    () => store.captures.filter((c) => c.status === "recording"),
    [store.captures],
  );

  const primaryCapture =
    activeRecordingCaptures[0] ?? store.captures[0]!;

  const overlaySpec = useMemo(
    () =>
      buildComputerUseOverlayVisualSpec(
        primaryCapture,
        Math.max(1, activeRecordingCaptures.length),
        activeRecordingCaptures.length > 0 ? activeRecordingCaptures : store.captures,
      ),
    [primaryCapture, activeRecordingCaptures, store.captures],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        escapeHeldRef.current = true;
        escapeArmedAtRef.current = Date.now();
        const res = handleComputerUseKillSwitchHotkey(
          store.captures,
          "Escape",
          VIDEO_RING_BUFFER_MAX_BYTES,
        );
        if (res.stoppedCaptureIds.length > 0) {
          setStore(res.store);
          setLastKillSwitchMessage(
            `Stopped ${res.stoppedCaptureIds.join(", ")} via Esc kill switch.`,
          );
          escapeArmedAtRef.current = 0;
        } else if (activeRecordingCaptures.length > 1) {
          setLastKillSwitchMessage(
            `Esc armed (${activeRecordingCaptures.length} active captures) — press 1..9 to stop target capture.`,
          );
        }
        return;
      }

      if (/^[1-9]$/.test(event.key) && (escapeHeldRef.current || Date.now() - escapeArmedAtRef.current <= 2500)) {
        const chord = `Esc+${event.key}`;
        const res = handleComputerUseKillSwitchHotkey(
          store.captures,
          chord,
          VIDEO_RING_BUFFER_MAX_BYTES,
        );
        escapeArmedAtRef.current = 0;
        if (res.stoppedCaptureIds.length > 0) {
          setStore(res.store);
          setLastKillSwitchMessage(
            `Stopped ${res.stoppedCaptureIds.join(", ")} via ${chord} kill switch.`,
          );
        }
        return;
      }

      if (/^esc(?:ape)?\+[1-9]$/i.test(event.key)) {
        const res = handleComputerUseKillSwitchHotkey(
          store.captures,
          event.key,
          VIDEO_RING_BUFFER_MAX_BYTES,
        );
        if (res.stoppedCaptureIds.length > 0) {
          setStore(res.store);
          setLastKillSwitchMessage(
            `Stopped ${res.stoppedCaptureIds.join(", ")} via ${event.key} kill switch.`,
          );
        }
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Esc") {
        escapeHeldRef.current = false;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [store.captures, activeRecordingCaptures.length]);

  function handleStartParallelCapture(): void {
    const nextNumber = store.captures.length + 1;
    const surface =
      DEFAULT_REMOTE_CAPTURE_SURFACES[nextNumber % DEFAULT_REMOTE_CAPTURE_SURFACES.length] ??
      DEFAULT_REMOTE_CAPTURE_SURFACES[0]!;
    const nextSession = startComputerUseVideoCapture({
      captureId: `cu-video-${surface.id}-${nextNumber}`,
      captureNumber: nextNumber,
      surface,
      startedAtMs: 1_760_000_000_000 + nextNumber * 1000,
    });
    setStore(
      enforceVideoRingBufferFifoLimit(
        [...store.captures, nextSession],
        VIDEO_RING_BUFFER_MAX_BYTES,
      ),
    );
  }

  function handleExtractMarkerSegment(): void {
    if (!primaryCapture || primaryCapture.status !== "recording") return;
    const nextMarkerIndex = primaryCapture.segments.length + 1;
    const withAction = recordComputerUseActionInVideo(primaryCapture, {
      mouseIndex: primaryCapture.captureNumber,
      actionLabel: `Action step #${nextMarkerIndex}`,
      x: (primaryCapture.virtualMice[0]?.x ?? 640) + 24,
      y: (primaryCapture.virtualMice[0]?.y ?? 360) + 16,
      keyOrChord: "Enter",
      isAboutToType: false,
      durationDeltaMs: 350,
    });
    const extracted = markAndExtractVideoSegmentKeyframes(
      withAction,
      `M${nextMarkerIndex}`,
      6_400_000,
    );
    const updatedCaptures = store.captures.map((c) =>
      c.captureId === primaryCapture.captureId ? extracted.session : c,
    );
    setStore(enforceVideoRingBufferFifoLimit(updatedCaptures, VIDEO_RING_BUFFER_MAX_BYTES));
  }

  function handleCompleteAndAuditVideo(): void {
    if (!primaryCapture) return;
    const audited = completeAndAuditComputerUseVideo(primaryCapture);
    const updatedCaptures = store.captures.map((c) =>
      c.captureId === primaryCapture.captureId ? audited : c,
    );
    setStore(enforceVideoRingBufferFifoLimit(updatedCaptures, VIDEO_RING_BUFFER_MAX_BYTES));
  }

  function handleTriggerKillSwitch(hotkeyChord: string): void {
    const res = handleComputerUseKillSwitchHotkey(
      store.captures,
      hotkeyChord,
      VIDEO_RING_BUFFER_MAX_BYTES,
    );
    setStore(res.store);
    setLastKillSwitchMessage(
      res.stoppedCaptureIds.length > 0
        ? `Stopped ${res.stoppedCaptureIds.join(", ")} via ${hotkeyChord}.`
        : `Kill switch ${hotkeyChord} requires target capture number.`,
    );
  }

  function handleEnforceRingBufferCap(): void {
    setStore((prev) =>
      enforceVideoRingBufferFifoLimit(prev.captures, VIDEO_RING_BUFFER_MAX_BYTES),
    );
  }

  const usedMb = (store.totalRetainedBytes / (1024 * 1024)).toFixed(1);
  const maxGb = (store.maxBufferBytes / (1024 * 1024 * 1024)).toFixed(2);
  const primaryKillChord =
    activeRecordingCaptures.length <= 1
      ? "Esc"
      : `Esc+${primaryCapture?.captureNumber ?? 1}`;

  return (
    <div
      data-testid={`${prefix}-overlay-root`}
      style={{
        position: "relative",
        padding: "10px",
        borderRadius: "8px",
        border: "1px solid rgba(14, 165, 233, 0.55)",
        boxShadow: overlaySpec.borderGradientStyle,
        display: "flex",
        flexDirection: "column",
        gap: "8px",
      }}
    >
      <style>{`
        @keyframes omnia-typing-dots-pulse {
          0%, 100% { opacity: 0.3; transform: translateY(0px); }
          50% { opacity: 1; transform: translateY(-1.5px); }
        }
      `}</style>
      <div
        data-testid="computer-use-gradient-border"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <strong
            data-testid={`${prefix}-ring-buffer-status`}
            style={{ fontSize: "12px", color: "var(--ide-fg)" }}
          >
            Video Ring Buffer: {usedMb} MB / {maxGb} GB FIFO (Evicted:{" "}
            {store.evictedCaptureIds.length})
          </strong>
          <span
            data-testid={`${prefix}-kill-switch-hint`}
            style={{
              fontSize: "11px",
              padding: "2px 6px",
              borderRadius: "4px",
              background: "var(--ide-raised)",
              color: "var(--text-secondary)",
            }}
          >
            Kill Switch: {overlaySpec.killSwitchHotkeyLabel}
          </span>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
          <button
            type="button"
            data-testid={`${prefix}-extract-segment-btn`}
            onClick={handleExtractMarkerSegment}
            style={{
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid var(--ide-border)",
              background: "var(--ide-raised)",
              color: "var(--ide-fg)",
              fontSize: "11px",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Mark &amp; Extract [M1 -&gt; M2] Keyframes
          </button>
          <button
            type="button"
            data-testid={`${prefix}-start-parallel-btn`}
            onClick={handleStartParallelCapture}
            style={{
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid var(--ide-border)",
              background: "var(--ide-chrome)",
              color: "var(--text)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            + Parallel Capture
          </button>
          <button
            type="button"
            data-testid={`${prefix}-complete-audit-btn`}
            onClick={handleCompleteAndAuditVideo}
            style={{
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid var(--ide-border)",
              background: "var(--ide-chrome)",
              color: "var(--text)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            Final Video Audit &amp; Delete
          </button>
          <button
            type="button"
            data-testid={`${prefix}-kill-esc-btn`}
            onClick={() => handleTriggerKillSwitch(primaryKillChord)}
            style={{
              padding: "4px 8px",
              borderRadius: "4px",
              border: "1px solid var(--ide-border)",
              background: "var(--ide-chrome)",
              color: "var(--text)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            {`Kill (${primaryKillChord})`}
          </button>
          {activeRecordingCaptures.length > 1
            ? activeRecordingCaptures
                .filter((cap) => cap.captureId !== primaryCapture?.captureId)
                .map((cap) => (
                  <button
                    key={`kill-${cap.captureId}`}
                    type="button"
                    data-testid={`${prefix}-kill-esc-${cap.captureNumber}-btn`}
                    onClick={() => handleTriggerKillSwitch(`Esc+${cap.captureNumber}`)}
                    style={{
                      padding: "4px 8px",
                      borderRadius: "4px",
                      border: "1px solid var(--ide-border)",
                      background: "var(--ide-chrome)",
                      color: "var(--text)",
                      fontSize: "11px",
                      cursor: "pointer",
                    }}
                  >
                    {`Kill (Esc+${cap.captureNumber})`}
                  </button>
                ))
            : null}
          <button
            type="button"
            data-testid={`${prefix}-enforce-fifo-btn`}
            onClick={handleEnforceRingBufferCap}
            style={{
              padding: "4px 6px",
              borderRadius: "4px",
              border: "1px solid var(--ide-border)",
              background: "var(--ide-chrome)",
              color: "var(--text-secondary)",
              fontSize: "11px",
              cursor: "pointer",
            }}
          >
            Enforce 1GB FIFO
          </button>
        </div>
      </div>

      {/* Parallel Virtual Mice & Virtual Keyboards Overlay Strip */}
      <div
        data-testid={`${prefix}-virtual-input-strip`}
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: "6px",
        }}
      >
        {overlaySpec.virtualMice.map((mouse) => (
          <div
            key={`vmouse-${mouse.mouseIndex}`}
            data-testid={`${prefix}-virtual-mouse-${mouse.mouseIndex}`}
            style={{
              padding: "5px 8px",
              borderRadius: "5px",
              background: "var(--ide-chrome)",
              border: "1px solid var(--ide-border)",
              fontSize: "11px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <strong>{mouse.badgeLabel}</strong>
            <span>{mouse.activeAction}</span>
          </div>
        ))}

        {overlaySpec.virtualKeyboards.map((kb) => (
          <div
            key={`vkb-${kb.keyboardIndex}`}
            data-testid={`${prefix}-virtual-keyboard-${kb.keyboardIndex}`}
            style={{
              padding: "5px 8px",
              borderRadius: "5px",
              background: "var(--ide-chrome)",
              border: "1px solid var(--ide-border)",
              fontSize: "11px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <strong>{kb.badgeLabel}</strong>
            <span>
              {kb.isAboutToType ? (
                <>
                  Preparing{" "}
                  <span
                    data-testid={`${prefix}-typing-dots-${kb.keyboardIndex}`}
                    className="omnia-typing-dots-animated"
                    style={{
                      display: "inline-block",
                      animation: "omnia-typing-dots-pulse 1.1s infinite ease-in-out",
                      fontWeight: 800,
                    }}
                  >
                    {kb.typingIndicatorDots}
                  </span>
                </>
              ) : (
                `Active: ${kb.activeKeyOrChord}`
              )}
            </span>
          </div>
        ))}
      </div>

      {/* Extracted [M1 -> M2] Keyframe Segments & Final Video Audit Receipt */}
      {primaryCapture ? (
        <div
          data-testid={`${prefix}-segments-list`}
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "6px",
            fontSize: "11px",
            color: "var(--text-secondary)",
          }}
        >
          <span>
            Capture #{primaryCapture.captureNumber} ({primaryCapture.status}):
          </span>
          {primaryCapture.segments.map((seg) => (
            <span
              key={`seg-${seg.segmentIndex}`}
              data-testid={`${prefix}-segment-${seg.fromMarker}-${seg.toMarker}`}
              style={{
                padding: "2px 6px",
                borderRadius: "4px",
                background: "var(--ide-chrome)",
                border: "1px solid var(--ide-border)",
                color: "var(--ide-fg)",
              }}
            >
              [{seg.fromMarker} -&gt; {seg.toMarker}] ({seg.extractedKeyframes.length} sharp keyframes)
            </span>
          ))}
          {primaryCapture.finalAuditSummary ? (
            <span
              data-testid={`${prefix}-final-audit-receipt`}
              style={{ color: "var(--ide-fg)", fontWeight: 600 }}
            >
              {primaryCapture.finalAuditSummary}
            </span>
          ) : null}
        </div>
      ) : null}

      {lastKillSwitchMessage ? (
        <div
          data-testid={`${prefix}-kill-switch-banner`}
          style={{ fontSize: "11px", color: "var(--ide-fg)" }}
        >
          {lastKillSwitchMessage}
        </div>
      ) : null}
    </div>
  );
}
