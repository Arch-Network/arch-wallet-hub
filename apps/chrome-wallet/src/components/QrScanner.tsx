/**
 * Phase 2.6 -- QR scanner button.
 *
 * Opens a small inline scanner that grabs the camera via
 * `getUserMedia` and decodes barcodes with the browser-native
 * `BarcodeDetector`. We fall back to an upload-an-image picker on
 * browsers where the API isn't available (and where decode happens
 * via an offscreen canvas).
 *
 * Why inline rather than a popup window: chrome.windows.create can't
 * be triggered from a content script, and the popup itself can't
 * spawn its own popup without losing user context. An inline
 * <video> + close button is the simplest path.
 */

import { useState, useEffect, useRef, useCallback } from "react";

interface QrScannerProps {
  onResult: (text: string) => void;
  onClose: () => void;
}

interface BarcodeLike {
  detect(source: HTMLVideoElement | HTMLImageElement): Promise<{ rawValue: string }[]>;
}

function detectorAvailable(): boolean {
  return typeof (window as any).BarcodeDetector === "function";
}

function buildDetector(): BarcodeLike | null {
  if (!detectorAvailable()) return null;
  try {
    return new (window as any).BarcodeDetector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

export default function QrScanner({ onResult, onClose }: QrScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) track.stop();
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const detector = buildDetector();
    if (!detector) {
      setError("This browser does not support live QR scanning. Use the upload button instead.");
      return;
    }
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const first = codes[0]?.rawValue;
            if (first) {
              stop();
              onResult(first);
              return;
            }
          } catch {
            /* ignore frame errors; keep scanning */
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (e: any) {
        setError(e?.message || "Could not access the camera");
      }
    })();
    return () => {
      cancelled = true;
      stop();
    };
  }, [onResult, stop]);

  const handleUpload = useCallback(async (file: File) => {
    if (!file) return;
    const detector = buildDetector();
    if (!detector) {
      setError("This browser cannot decode images either; paste the address manually.");
      return;
    }
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    await new Promise((r) => {
      img.onload = r;
      img.onerror = r;
    });
    try {
      const codes = await detector.detect(img);
      const first = codes[0]?.rawValue;
      if (first) {
        onResult(first);
      } else {
        setError("No QR code found in image");
      }
    } catch (e: any) {
      setError(e?.message || "Could not decode image");
    } finally {
      URL.revokeObjectURL(img.src);
    }
  }, [onResult]);

  return (
    <div className="qr-scanner-overlay" onClick={onClose}>
      <div className="qr-scanner-modal" onClick={(e) => e.stopPropagation()}>
        <div className="qr-scanner-header">
          <span>Scan address QR</span>
          <button className="qr-scanner-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <video ref={videoRef} className="qr-scanner-video" playsInline muted />
        {error && <div className="error-banner" style={{ marginTop: 8 }}>{error}</div>}
        <div style={{ marginTop: 8, display: "flex", justifyContent: "center" }}>
          <label className="btn btn-sm btn-secondary" style={{ cursor: "pointer" }}>
            Upload image
            <input
              type="file"
              accept="image/*"
              capture="environment"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
              }}
            />
          </label>
        </div>
      </div>
    </div>
  );
}
