import { useNavigate, useLocation } from "react-router-dom";

function IconHome({ active }: { active: boolean }) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M4 10.2L12 4l8 6.2V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V10.2z" fill={f} stroke={s} strokeWidth="1.6" strokeLinejoin="round" />
      <rect x="9.5" y="14" width="5" height="7" rx="0.5" fill={active ? "rgba(193,154,91,0.3)" : "none"} stroke={s} strokeWidth="1.4" />
    </svg>
  );
}

function IconSend({ active }: { active: boolean }) {
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

function IconReceive({ active }: { active: boolean }) {
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

function IconHistory({ active }: { active: boolean }) {
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

function IconSettings({ active }: { active: boolean }) {
  const s = active ? "#c19a5b" : "currentColor";
  const f = active ? "rgba(193,154,91,0.15)" : "none";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" fill={f} stroke={s} strokeWidth="1.5" />
      <path d="M12 2v2.4M12 19.6V22M22 12h-2.4M4.4 12H2M19.1 4.9l-1.7 1.7M6.6 17.4l-1.7 1.7M19.1 19.1l-1.7-1.7M6.6 6.6L4.9 4.9" stroke={s} strokeWidth="1.6" strokeLinecap="round" />
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
