/**
 * One row of the Settings → Connected Sites list. Collapsed by
 * default; expanding reveals the Permission Center for that origin:
 *
 *   - Five capability toggles mirroring the SitePermissions struct:
 *     read state, sign message, sign Arch hash, send transfer,
 *     sign PSBT.
 *   - Daily spend cap in ARCH (stored as lamports). Empty input
 *     means "no cap" -- the wallet always prompts. A typed cap of 0
 *     is honored as a kill switch ("auto-approve nothing").
 *   - Disconnect button -- final escape hatch when the user wants
 *     to forget the site entirely.
 *
 * Component-scoped state:
 *   - `expanded`: whether the Permission Center is open.
 *   - `capDraft`: live editing of the cap input so partial typed
 *     values don't write garbage to storage on every keystroke. We
 *     commit on blur / Save.
 *
 * Persistence happens via `walletStore.setSitePermissions` (partial
 * merges) and `walletStore.disconnectSite`. The parent re-reads
 * `state.connectedSites` from the wallet hook on every render, so we
 * just call the mutator and the row re-renders naturally.
 */

import { useState } from "react";
import type { ConnectedSite, SitePermissions } from "../state/types";
import { DEFAULT_SITE_PERMISSIONS } from "../state/types";
import { walletStore } from "../state/wallet-store";

interface Props {
  origin: string;
  site: ConnectedSite;
  onDisconnect: (origin: string) => Promise<void> | void;
}

const LAMPORTS_PER_ARCH = 1_000_000_000;

function lamportsToArchString(lamports: number | undefined): string {
  if (lamports === undefined || lamports === null) return "";
  // Display with up to 9 decimals, trimming trailing zeros. We never
  // toFixed because lamports values can be exact powers of ten that
  // shouldn't display as "1.000000000".
  const whole = Math.floor(lamports / LAMPORTS_PER_ARCH);
  const frac = lamports % LAMPORTS_PER_ARCH;
  if (frac === 0) return whole.toString();
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

/**
 * Parse the user-facing ARCH amount string into lamports. Returns
 *   - `null` for empty / whitespace input ("no cap")
 *   - `0` for "0" / "0.0" (the explicit kill switch)
 *   - `NaN` for malformed input (caller surfaces an error)
 *   - a non-negative integer otherwise
 */
function archStringToLamports(s: string): number | null | typeof NaN {
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{0,9})?$/.test(trimmed)) return NaN;
  const [whole, frac = ""] = trimmed.split(".");
  const wholeN = parseInt(whole!, 10);
  const fracPadded = frac.padEnd(9, "0").slice(0, 9);
  const fracN = parseInt(fracPadded || "0", 10);
  return wholeN * LAMPORTS_PER_ARCH + fracN;
}

const CAPABILITY_TOGGLES: Array<{
  key: keyof SitePermissions;
  label: string;
  description: string;
}> = [
  {
    key: "readState",
    label: "Read state",
    description: "getAccount / getBalance — never signs.",
  },
  {
    key: "signMessage",
    label: "Auto-sign messages",
    description: "Auto-approves Sign Message + SIWA challenges.",
  },
  {
    key: "signArchMessageHash",
    label: "Auto-sign Arch message hash",
    description: "Auto-approves raw 32-byte hash sign requests.",
  },
  {
    key: "sendTransfer",
    label: "Auto-approve transfers",
    description:
      "ARCH + APL token transfers. The daily cap below still applies.",
  },
  {
    key: "signPsbt",
    label: "Auto-sign PSBTs",
    description:
      "PSBT signing. The large-outflow gate still asks for confirmation when the spend exceeds the wallet's safety threshold.",
  },
];

export function ConnectedSiteRow({ origin, site, onDisconnect }: Props) {
  const permissions: SitePermissions = {
    ...DEFAULT_SITE_PERMISSIONS,
    ...(site.permissions ?? {}),
  };
  const [expanded, setExpanded] = useState(false);
  const [capDraft, setCapDraft] = useState(() =>
    lamportsToArchString(permissions.spendingLimitSatsPerDay),
  );
  const [capError, setCapError] = useState<string | null>(null);
  const [capSaved, setCapSaved] = useState(false);

  const handleTogglePermission = async (
    key: keyof SitePermissions,
    value: boolean,
  ) => {
    await walletStore.setSitePermissions(origin, { [key]: value });
  };

  const handleSaveCap = async () => {
    const parsed = archStringToLamports(capDraft);
    if (typeof parsed === "number" && Number.isNaN(parsed)) {
      setCapError("Enter a positive ARCH amount, or leave blank for no cap.");
      return;
    }
    setCapError(null);
    // Persist null as `undefined` via partial merge: the cleanest way to
    // express "no cap". We pass `undefined` directly so the merge in
    // setSitePermissions overwrites any previously-set cap.
    await walletStore.setSitePermissions(origin, {
      spendingLimitSatsPerDay: parsed === null ? undefined : parsed,
    });
    setCapSaved(true);
    setTimeout(() => setCapSaved(false), 1500);
  };

  return (
    <div
      style={{
        padding: "8px 0",
        borderBottom: "1px solid var(--border-primary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href={origin}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            {site.name || origin} {"\u2197"}
          </a>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{origin}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            {expanded ? "Hide" : "Manage"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-danger"
            onClick={() => onDisconnect(origin)}
          >
            Disconnect
          </button>
        </div>
      </div>

      {expanded && (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            background: "var(--bg-elevated, rgba(0,0,0,0.18))",
            borderRadius: 8,
            border: "1px solid var(--border-primary)",
          }}
        >
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 8 }}>
            Capabilities — what this site can do without prompting.
          </div>
          {CAPABILITY_TOGGLES.map((t) => (
            <div
              key={t.key}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                padding: "6px 0",
                borderTop: "1px dashed var(--border-primary)",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{t.label}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {t.description}
                </div>
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  flexShrink: 0,
                }}
              >
                <input
                  type="checkbox"
                  checked={!!permissions[t.key]}
                  onChange={(e) =>
                    handleTogglePermission(t.key, e.target.checked)
                  }
                />
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {permissions[t.key] ? "Auto" : "Prompt"}
                </span>
              </label>
            </div>
          ))}

          <div
            style={{
              marginTop: 12,
              paddingTop: 10,
              borderTop: "1px solid var(--border-primary)",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 500 }}>
              Daily ARCH spend cap
            </div>
            <div
              style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}
            >
              The Approve gate refuses ARCH transfers from this site once
              cumulative spend in the last 24h exceeds the cap. Leave blank
              for no cap; set to 0 to block all auto-approved transfers.
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                type="text"
                inputMode="decimal"
                className="input"
                value={capDraft}
                onChange={(e) => {
                  setCapDraft(e.target.value);
                  setCapError(null);
                  setCapSaved(false);
                }}
                placeholder="No cap"
                style={{ flex: 1, fontSize: 12 }}
              />
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ARCH</span>
              <button
                type="button"
                className={`btn btn-sm ${capSaved ? "btn-primary" : "btn-secondary"}`}
                onClick={handleSaveCap}
              >
                {capSaved ? "Saved" : "Save"}
              </button>
            </div>
            {capError && (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 11,
                  color: "var(--text-danger, #ff5252)",
                }}
              >
                {capError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
