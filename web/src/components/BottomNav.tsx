import { NavLink } from "react-router-dom";

function SongsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5 7.5h14M5 12h14M5 16.5h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AccountIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="9" r="3.1" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M6.2 18.2c1.2-2.2 3.1-3.3 5.8-3.3s4.6 1.1 5.8 3.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const tabs = [
  { to: "/songs", label: "Songs", icon: SongsIcon, end: true },
  { to: "/account", label: "Account", icon: AccountIcon, end: false },
];

export function BottomNav() {
  return (
    <nav className="bottom-nav" aria-label="App">
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => (isActive ? "nav-tab active" : "nav-tab")}
        >
          <tab.icon />
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
