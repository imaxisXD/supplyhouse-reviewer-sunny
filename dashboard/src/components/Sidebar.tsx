import { NavLink } from "react-router-dom";


const navItems = [
  {
    section: "Main",
    items: [
      { to: "/", label: "Submit Review", icon: "M12 4v16m8-8H4" },
      { to: "/reviews", label: "Reviews", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
      { to: "/repos", label: "Repositories", icon: "M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" },
    ]
  },
  {
    section: "Analytics",
    items: [
      { to: "/indexing", label: "Indexing", icon: "M4 6h16M4 10h16M4 14h16M4 18h16" },
      { to: "/observability", label: "Observability", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
    ]
  }
];

export function Sidebar() {
  return (
    <aside className="w-64 flex flex-col border-r border-ink-900 bg-white h-screen overflow-y-auto">

      <div className="px-5 py-5 border-b border-ink-900">
        <div className="mt-4 flex items-center gap-3 text-brand-600">
          <div className="flex h-9 w-9 items-center justify-center border border-brand-500/50 bg-brand-500/10">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9 22 9 12 15 12 15 22" />
            </svg>
          </div>
          <div>
            <div className="text-sm font-semibold text-ink-950">Supply House</div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-ink-600">Reviewer</div>
          </div>
        </div>
      </div>

      <div className="bg-white h-full flex flex-col justify-between">
      <nav className="px-4 py-5 space-y-6 h-fit">
        {navItems.map((section) => (
          <div key={section.section} className="space-y-3">
            <div className="text-[10px] uppercase tracking-[0.35em] text-ink-600">{section.section}</div>
            <div className="space-y-1">
              {section.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3 py-2 text-sm transition ${
                      isActive
                        ? "border border-ink-900 bg-warm-100 text-ink-950"
                        : "text-ink-700 hover:text-ink-950 hover:bg-warm-100/70"
                    }`
                  }
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d={item.icon} />
                  </svg>
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-4 py-4 border-t border-ink-900 text-[10px] uppercase tracking-[0.3em] text-ink-600">
        v2.0.0
      </div>
      </div>

      
    </aside>
  );
}
