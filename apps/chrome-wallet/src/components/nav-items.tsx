import type { FC, ReactNode } from "react";

interface NavIconProps {
  active: boolean;
}

// Flat line icons per the rebrand: a single currentColor stroke, no
// filled backgrounds. The active tab tints currentColor to the primary
// orange via `.nav-item.active` / `.side-nav-item.active` in global.css,
// so these icons stay theme-agnostic and inherit their color. The active
// icon also draws a slightly heavier stroke.
function Glyph({ active, children }: NavIconProps & { children: ReactNode }) {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function IconHome({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <path d="M4.5 10.5a2 2 0 0 1 .72-1.54l5.5-4.6a2 2 0 0 1 2.56 0l5.5 4.6a2 2 0 0 1 .72 1.54v8a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" />
      <path d="M9.75 20.5v-4.25a2.25 2.25 0 0 1 4.5 0v4.25" />
    </Glyph>
  );
}

function IconSend({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.25 14.75l5.5-5.5" />
      <path d="M10 9.25h4.75V14" />
    </Glyph>
  );
}

function IconReceive({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.75 9.25l-5.5 5.5" />
      <path d="M14 14.75H9.25V10" />
    </Glyph>
  );
}

/** Clock with a counterclockwise arrow: looking back through activity. */
function IconHistory({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <path d="M5.45 7.41A8 8 0 1 1 4 12" />
      <path d="M8.35 6.63 5.45 7.41 5.19 4.42" />
      <path d="M12 7.75V12l2.75 1.75" />
    </Glyph>
  );
}

function IconSettings({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <path d="M10.14 5.05 10.61 2.7H13.39L13.86 5.05A7.2 7.2 0 0 1 15.6 5.76L17.59 4.44 19.56 6.41 18.24 8.4A7.2 7.2 0 0 1 18.95 10.14L21.3 10.61V13.39L18.95 13.86A7.2 7.2 0 0 1 18.24 15.6L19.56 17.59 17.59 19.56 15.6 18.24A7.2 7.2 0 0 1 13.86 18.95L13.39 21.3H10.61L10.14 18.95A7.2 7.2 0 0 1 8.4 18.24L6.41 19.56 4.44 17.59 5.76 15.6A7.2 7.2 0 0 1 5.05 13.86L2.7 13.39V10.61L5.05 10.14A7.2 7.2 0 0 1 5.76 8.4L4.44 6.41 6.41 4.44 8.4 5.76A7.2 7.2 0 0 1 10.14 5.05Z" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  );
}

/** Two coins trading places. */
function IconSwap({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <circle cx="7.5" cy="7.5" r="3.5" />
      <circle cx="16.5" cy="16.5" r="3.5" />
      <path d="M13 4.5a6.5 6.5 0 0 1 6.5 6.5" />
      <path d="M17.5 9l2 2 2-2" />
      <path d="M11 19.5A6.5 6.5 0 0 1 4.5 13" />
      <path d="M2.5 15l2-2 2 2" />
    </Glyph>
  );
}

/** A framed picture with another behind it: a gallery, not one image. */
function IconCollectibles({ active }: NavIconProps) {
  return (
    <Glyph active={active}>
      <path d="M7.5 3.5h10a3 3 0 0 1 3 3v10" />
      <rect x="3.5" y="7" width="13.5" height="13.5" rx="2.5" />
      <circle cx="12.75" cy="11.25" r="1.25" />
      <path d="M3.75 18.25l3.95-3.95a1.25 1.25 0 0 1 1.77 0l5.7 5.7" />
    </Glyph>
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
 * bar to five destinations, including the gallery even when it is empty.
 */
export const POPUP_NAV_ITEMS: NavItem[] = [
  { path: "/dashboard", label: "Home", Icon: IconHome },
  { path: "/swap", label: "Swap", Icon: IconSwap },
  { path: "/collectibles", label: "Collectibles", Icon: IconCollectibles },
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
