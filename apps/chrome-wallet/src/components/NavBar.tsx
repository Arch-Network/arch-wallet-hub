import { useNavigate, useLocation } from "react-router-dom";

function IconHome({ active }: { active: boolean }) {
  const c = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" />
      <path d="M9 21V12h6v9" />
    </svg>
  );
}

function IconSend({ active }: { active: boolean }) {
  const c = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2L11 13" />
      <path d="M22 2L15 22l-4-9-9-4 20-7z" />
    </svg>
  );
}

function IconReceive({ active }: { active: boolean }) {
  const c = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v13" />
      <path d="M5 12l7 7 7-7" />
      <path d="M3 21h18" />
    </svg>
  );
}

function IconHistory({ active }: { active: boolean }) {
  const c = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </svg>
  );
}

function IconSettings({ active }: { active: boolean }) {
  const c = active ? "#c19a5b" : "currentColor";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const NAV_ITEMS = [
  { path: "/dashboard", label: "Home", Icon: IconHome },
  { path: "/send", label: "Send", Icon: IconSend },
  { path: "/receive", label: "Receive", Icon: IconReceive },
  { path: "/history", label: "History", Icon: IconHistory },
  { path: "/settings", label: "Settings", Icon: IconSettings },
];

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="app-nav">
      {NAV_ITEMS.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <button
            key={item.path}
            className={isActive ? "active" : ""}
            onClick={() => navigate(item.path)}
          >
            <span className="nav-icon">
              <item.Icon active={isActive} />
            </span>
            {item.label}
          </button>
        );
      })}
    </nav>
  );
}
