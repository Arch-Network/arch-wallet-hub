import { useNavigate, useLocation } from "react-router-dom";
import { NAV_ITEMS } from "./nav-items";

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
