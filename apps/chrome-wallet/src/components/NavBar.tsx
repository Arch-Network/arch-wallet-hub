import { useNavigate, useLocation } from "react-router-dom";
import { POPUP_NAV_ITEMS } from "./nav-items";

export default function NavBar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <nav className="app-nav" aria-label="Wallet navigation">
      {POPUP_NAV_ITEMS.map((item) => {
        const isActive = location.pathname === item.path;
        return (
          <button
            key={item.path}
            className={isActive ? "active" : ""}
            aria-current={isActive ? "page" : undefined}
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
