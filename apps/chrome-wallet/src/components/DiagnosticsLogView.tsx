import { useCallback, useEffect, useState } from "react";
import { clearRecentLogs, getRecentLogs, type LogEntry } from "../utils/log";

/**
 * Settings -> Diagnostics log viewer. Reads from the in-memory ring
 * buffer maintained by `utils/log`. Only renders when the user has
 * Debug mode enabled (gating happens in Settings.tsx, not here, so
 * this component stays a pure renderer).
 *
 * Refreshes on a short interval so a user watching the view sees
 * new entries arrive without having to navigate away and back. We
 * use polling rather than an event bus because every code path that
 * appends to the ring buffer already calls `console.*`, and adding
 * a second emit path just to drive React would be over-engineering
 * for a diagnostic surface that's only visible when explicitly opted
 * into.
 */
export default function DiagnosticsLogView() {
  const [entries, setEntries] = useState<LogEntry[]>(() => getRecentLogs());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const id = setInterval(() => {
      setEntries(getRecentLogs());
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const handleCopy = useCallback(async () => {
    const dump = entries
      .map((e) => {
        const ts = new Date(e.ts).toISOString();
        const extra = e.extra === undefined ? "" : ` ${safeStringify(e.extra)}`;
        return `[${ts}] ${e.level.toUpperCase()} ${e.msg}${extra}`;
      })
      .join("\n");
    try {
      await navigator.clipboard.writeText(dump || "(no log entries yet)");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked -- swallow silently */
    }
  }, [entries]);

  const handleClear = useCallback(() => {
    clearRecentLogs();
    setEntries([]);
  }, []);

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          Recent logs ({entries.length})
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleCopy}
            style={{ fontSize: 11, padding: "2px 8px" }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleClear}
            style={{ fontSize: 11, padding: "2px 8px" }}
            disabled={entries.length === 0}
          >
            Clear
          </button>
        </div>
      </div>
      <pre
        style={{
          margin: 0,
          padding: 8,
          maxHeight: 220,
          overflow: "auto",
          fontSize: 11,
          lineHeight: 1.4,
          background: "var(--bg-elevated, rgba(0,0,0,0.25))",
          color: "var(--text)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {entries.length === 0
          ? "(no log entries yet — interact with the wallet to populate)"
          : entries.map((e, i) => formatEntry(e, i)).join("\n")}
      </pre>
    </div>
  );
}

function formatEntry(e: LogEntry, idx: number): string {
  const ts = new Date(e.ts).toISOString().slice(11, 23);
  const lvl = e.level.toUpperCase().padEnd(5);
  const extra = e.extra === undefined ? "" : ` ${safeStringify(e.extra)}`;
  return `${idx.toString().padStart(3, " ")} ${ts} ${lvl} ${e.msg}${extra}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}
