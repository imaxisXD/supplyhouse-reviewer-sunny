import { NavLink } from "react-router-dom";
import { useJourney, journeySteps, getJourneyStatus } from "../journey";

const navItems = [
  {
    section: "Main",
    items: [
      { to: "/", label: "Submit Review", icon: "M12 4v16m8-8H4" },
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
  const { currentStep, loading: journeyLoading } = useJourney();
  const isFirstRun = !journeyLoading && currentStep === "submit";

  return (
    <aside className="w-64 shrink-0 border-r border-ink-900 bg-white">
      <div className="px-5 py-5 border-b border-ink-900">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.35em] text-ink-600">
          <span>My Company</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </div>
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

      <nav className="px-4 py-5 space-y-6">
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

      <div className="px-4 py-5 border-t border-ink-900">
        <div className="text-[10px] uppercase tracking-[0.35em] text-ink-600 mb-3">Journey</div>
        <div className="border border-ink-900 bg-white p-3">
          {journeyLoading ? (
            <div className="text-xs text-ink-600">Syncing journey…</div>
          ) : isFirstRun ? (
            <div className="space-y-3">
              <div className="text-xs font-semibold uppercase tracking-[0.3em] text-brand-600">
                Go, complete step one
              </div>
              <p className="text-xs text-ink-600">
                Submit your first PR review to unlock the rest of the flow.
              </p>
              <NavLink
                to="/"
                className="inline-flex w-full items-center justify-center gap-2 border border-brand-500 bg-brand-500 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.3em] text-white transition hover:bg-brand-400"
              >
                Start review
              </NavLink>
            </div>
          ) : (
            <div className="space-y-2">
              {journeySteps.map((step) => {
                const status = getJourneyStatus(currentStep, step.id);
                const tone =
                  status === "current"
                    ? "text-brand-600"
                    : status === "complete"
                    ? "text-emerald-600"
                    : "text-ink-600";
                const dot =
                  status === "current"
                    ? "bg-brand-500 border-brand-500"
                    : status === "complete"
                    ? "bg-emerald-500 border-emerald-500"
                    : "bg-transparent border-ink-900";
                return (
                  <div key={step.id} className={`flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] ${tone}`}>
                    <span className={`h-2 w-2 border ${dot}`} />
                    <span>{step.sidebarLabel}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-4 border-t border-ink-900 text-[10px] uppercase tracking-[0.3em] text-ink-600">
        v1.0.0
      </div>
    </aside>
  );
}
