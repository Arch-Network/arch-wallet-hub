import type { FC } from "react";

interface NavIconProps {
  active: boolean;
}

function IconHome({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M4 10.2L12 4l8 6.2V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10.2z" fill={f} stroke={s} strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="9.5" y="14" width="5" height="7" rx="0.5" fill={active ? "rgba(193,154,91,0.3)" : "none"} stroke={s} strokeWidth="1.4" />
    </svg>
  );
}

function IconSend({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" fill={f} stroke={s} strokeWidth="1.5" />
      <path d="M12 16V8" stroke={s} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 11.5L12 8l3.5 3.5" stroke={s} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconReceive({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" fill={f} stroke={s} strokeWidth="1.5" />
      <path d="M12 8v8" stroke={s} strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 12.5L12 16l3.5-3.5" stroke={s} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconHistory({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" fill={f} stroke={s} strokeWidth="1.5" />
      <path d="M12 7.5V12l3.2 3.2" stroke={s} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="1.2" fill={s} />
    </svg>
  );
}

function IconSettings({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" fill={f} stroke={s} strokeWidth="1.5" />
      <path d="M12 2v2.4M12 19.6V22M22 12h-2.4M4.4 12H2M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7M19.1 19.1l-1.7-1.7M6.6 6.6L4.9 4.9" stroke={s} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconSwap({ active }: NavIconProps) {
  const s = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M7 4v12M3 12l4 4 4-4" stroke={s} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 20V8M13 12l4-4 4 4" stroke={s} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface NavItem {
  path: string;
  label: string;
  Icon: FC<NavIconProps>;
}

/**
 * The popup (and narrow side panel) shows a bottom tab bar fixed to a
 * 400px-wide column. Send and Receive are *actions*, not destinations,
 * and live as hero buttons on the dashboard -- so we keep the bottom
 * bar to four true destinations and let the tap targets stay wide.
 */
export const POPUP_NAV_ITEMS: NavItem[] = [
  { path: "/dashboard", label: "Home", Icon: IconHome },
  { path: "/swap", label: "Swap", Icon: IconSwap },
  { path: "/history", label: "Activity", Icon: IconHistory },
  { path: "/settings", label: "Settings", Icon: IconSettings },
];

/**
 * The wide side panel (>=560px) has a persistent left sidebar with
 * room to breathe, so it surfaces Send and Receive as first-class
 * destinations alongside the rest. Phase 3 adds Collectibles here.
 */
export const SIDE_NAV_ITEMS: NavItem[] = [
  { path: "/dashboard", label: "Home", Icon: IconHome },
  { path: "/send", label: "Send", Icon: IconSend },
  { path: "/receive", label: "Receive", Icon: IconReceive },
  { path: "/swap", label: "Swap", Icon: IconSwap },
  { path: "/history", label: "Activity", Icon: IconHistory },
  { path: "/settings", label: "Settings", Icon: IconSettings },
];
