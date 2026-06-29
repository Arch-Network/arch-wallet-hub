import type { FC } from "react";

interface NavIconProps {
  active: boolean;
}

// Flat line icons per the rebrand: a single currentColor stroke, no
// filled backgrounds. The active tab tints currentColor to the primary
// orange via `.nav-item.active` / `.side-nav-item.active` in global.css,
// so these icons stay theme-agnostic and inherit their color.
function IconHome(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M4 11 L12 4 L20 11 M6 10 V20 H18 V10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSend(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M6 18 L18 6 M10 6 H18 V14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconReceive(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M12 4 V19 M6 13 L12 19 L18 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconHistory(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5 V12 L15 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSettings(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.4" stroke="currentColor" strokeWidth="2" />
      <path d="M12 3 V6 M12 18 V21 M3 12 H6 M18 12 H21 M5.5 5.5 L7.6 7.6 M16.4 16.4 L18.5 18.5 M18.5 5.5 L16.4 7.6 M7.6 16.4 L5.5 18.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconSwap(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path d="M7 5 V19 M4.5 7.5 L7 5 L9.5 7.5 M17 19 V5 M14.5 16.5 L17 19 L19.5 16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconCollectibles(_: NavIconProps) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="8.5" cy="8.5" r="1.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M21 16l-5-5L5 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
  { path: "/collectibles", label: "Collectibles", Icon: IconCollectibles },
  { path: "/history", label: "Activity", Icon: IconHistory },
  { path: "/settings", label: "Settings", Icon: IconSettings },
];
