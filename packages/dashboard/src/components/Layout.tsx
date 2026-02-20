import { useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";

const navItems = [
  {
    to: "/dashboard",
    label: "Dashboard",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="4" rx="1" /><rect x="14" y="10" width="7" height="7" rx="1" /><rect x="3" y="13" width="7" height="4" rx="1" />
      </svg>
    ),
  },
  {
    to: "/",
    label: "Search",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
    ),
  },
  {
    to: "/timeline",
    label: "Timeline",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
      </svg>
    ),
  },
  {
    to: "/entities",
    label: "Entities",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
        <path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" />
      </svg>
    ),
  },
  {
    to: "/graph",
    label: "Graph",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="5" cy="6" r="2" /><circle cx="19" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><circle cx="12" cy="11" r="2" />
        <path d="M6.7 7.5L10.8 9.8" /><path d="M17.3 7.5L13.2 9.8" /><path d="M12 13L12 16" />
      </svg>
    ),
  },
  {
    to: "/goals",
    label: "Goals",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>
    ),
  },
  {
    to: "/trash",
    label: "Trash",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    ),
  },
  {
    to: "/chat",
    label: "Chat",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    to: "/settings",
    label: "Settings",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
];

const EXPANDED_WIDTH = 256;
const COLLAPSED_WIDTH = 64;

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const isFullWidth = location.pathname === "/graph";
  const isCollapsed = collapsed && !isMobile;
  const width = isCollapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH;

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth <= 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Close sidebar on route change (mobile)
  useEffect(() => {
    if (isMobile) setMobileOpen(false);
  }, [location.pathname, isMobile]);

  const sidebarContent = (
    <nav
      style={{
        width: "100%",
        height: "100%",
        background: "linear-gradient(180deg, #08081a 0%, #06060e 100%)",
        display: "flex",
        flexDirection: "column",
        borderRight: "1px solid #16163a",
        overflow: "hidden",
      }}
    >
      {/* Logo */}
      <div
        style={{
          padding: isCollapsed ? "24px 0 28px" : "24px 24px 28px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          justifyContent: isCollapsed ? "center" : "flex-start",
          transition: "padding 0.25s ease",
          minHeight: 76,
        }}
      >
        <div style={{ position: "relative", flexShrink: 0 }}>
          <img
            src="/icon.svg"
            alt=""
            width={44}
            height={44}
            style={{
              display: "block",
              borderRadius: 12,
              boxShadow: "0 0 24px rgba(139, 92, 246, 0.3), 0 0 8px rgba(34, 211, 238, 0.15)",
            }}
          />
          <div
            style={{
              position: "absolute",
              inset: -6,
              borderRadius: 18,
              background: "radial-gradient(circle, rgba(139, 92, 246, 0.2) 0%, transparent 70%)",
              animation: "pulseGlow 4s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
        </div>
        {!isCollapsed && (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontWeight: 600,
                fontSize: 18,
                letterSpacing: "0.18em",
                background: "linear-gradient(135deg, #a78bfa, #22d3ee)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                whiteSpace: "nowrap",
                lineHeight: 1.2,
              }}
            >
              EXOCORTEX
            </span>
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 8,
                letterSpacing: "0.18em",
                color: "#8080a0",
                textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}
            >
              Neural Memory Interface
            </span>
          </div>
        )}
      </div>

      {/* Nav Items */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2, padding: isCollapsed ? "0 8px" : "0 10px" }}>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            title={isCollapsed ? item.label : undefined}
            style={({ isActive }) => ({
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: isCollapsed ? "10px 0" : "9px 14px",
              justifyContent: isCollapsed ? "center" : "flex-start",
              borderRadius: 8,
              color: isActive ? "#e8e8f4" : "#a0a0be",
              textDecoration: "none",
              fontSize: 14,
              fontWeight: isActive ? 600 : 400,
              background: isActive ? "rgba(139, 92, 246, 0.1)" : "transparent",
              borderLeft: isCollapsed ? "none" : isActive ? "2px solid #8b5cf6" : "2px solid transparent",
              transition: "all 0.2s",
              position: "relative",
              whiteSpace: "nowrap",
              overflow: "hidden",
            })}
          >
            <span style={{ display: "flex", flexShrink: 0 }}>{item.icon}</span>
            {!isCollapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </div>

      {/* Bottom section */}
      <div
        style={{
          padding: isCollapsed ? "12px 8px" : "12px 14px",
          borderTop: "1px solid #16163a",
          display: "flex",
          flexDirection: "column",
          alignItems: isCollapsed ? "center" : "flex-start",
          gap: 8,
        }}
      >
        {/* Collapse toggle (desktop only) */}
        {!isMobile && (
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: "rgba(139, 92, 246, 0.06)",
              border: "1px solid #16163a",
              color: "#a0a0be",
              cursor: "pointer",
              padding: collapsed ? "8px" : "7px 10px",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 12,
              transition: "all 0.2s",
              width: collapsed ? 40 : "100%",
              justifyContent: collapsed ? "center" : "flex-start",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = "rgba(139, 92, 246, 0.3)";
              e.currentTarget.style.background = "rgba(139, 92, 246, 0.1)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = "#16163a";
              e.currentTarget.style.background = "rgba(139, 92, 246, 0.06)";
            }}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                transform: collapsed ? "rotate(180deg)" : "none",
                transition: "transform 0.25s ease",
                flexShrink: 0,
              }}
            >
              <path d="M11 17l-5-5 5-5" />
              <path d="M18 17l-5-5 5-5" />
            </svg>
            {!collapsed && <span>Collapse</span>}
          </button>
        )}

        {!isCollapsed && (
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "#8080a0",
              letterSpacing: "0.08em",
              padding: "0 10px",
            }}
          >
            v0.1.0
          </div>
        )}
      </div>
    </nav>
  );

  if (isMobile) {
    return (
      <div style={{ display: "flex", minHeight: "100vh", position: "relative" }}>
        {/* Hamburger */}
        <button
          className="mobile-hamburger"
          onClick={() => setMobileOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>

        {/* Backdrop */}
        {mobileOpen && (
          <div className="mobile-backdrop" onClick={() => setMobileOpen(false)} />
        )}

        {/* Sidebar overlay */}
        <div
          className={`mobile-sidebar-overlay${mobileOpen ? " open" : ""}`}
          style={{ position: "fixed", width: EXPANDED_WIDTH }}
        >
          {sidebarContent}
        </div>

        {/* Main content */}
        <main className="mobile-main" style={{ flex: 1, padding: "56px 16px 32px", minHeight: "100vh", position: "relative", zIndex: 1 }}>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative" }}>
      {/* Sidebar wrapper */}
      <div
        style={{
          width,
          flexShrink: 0,
          position: "relative",
          transition: "width 0.25s ease",
        }}
      >
        {sidebarContent}

        {/* Breathing border accent */}
        <div
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            width: 1,
            height: "100%",
            background: "linear-gradient(180deg, #8b5cf6, #22d3ee, #8b5cf6)",
            backgroundSize: "100% 200%",
            animation: "breathe 6s ease infinite",
            zIndex: 2,
          }}
        />
      </div>

      {/* Main content */}
      <main
        style={{
          flex: 1,
          padding: "32px 40px",
          maxWidth: isFullWidth ? "none" : 1000,
          minHeight: "100vh",
          position: "relative",
          zIndex: 1,
        }}
      >
        <Outlet />
      </main>
    </div>
  );
}
