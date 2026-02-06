import { NavLink } from "react-router-dom";
import {
  IconPlusOutline24,
  IconPageOutline24,
  IconFolderOutline24,
  IconBulletListOutline24,
  IconChartBarAxisXOutline24,
  IconHouse6Outline24,
} from "nucleo-core-essential-outline-24";
import type { ComponentType } from "react";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number | string; className?: string }>;
}

const navItems: { section: string; items: NavItem[] }[] = [
  {
    section: "Main",
    items: [
      { to: "/", label: "Submit Review", icon: IconPlusOutline24 },
      { to: "/reviews", label: "Reviews", icon: IconPageOutline24 },
      { to: "/repos", label: "Repositories", icon: IconFolderOutline24 },
    ]
  },
  {
    section: "Analytics",
    items: [
      { to: "/indexing", label: "Indexing", icon: IconBulletListOutline24 },
      { to: "/observability", label: "Observability", icon: IconChartBarAxisXOutline24 },
    ]
  }
];

export function Sidebar() {
  return (
    <aside className="w-64 flex flex-col border-r border-ink-900 bg-white h-screen overflow-y-auto">

      <div className="px-5 py-5 border-b border-ink-900">
        <div className="mt-4 flex items-center gap-3 text-brand-600">
          <div className="flex h-9 w-9 items-center justify-center border border-brand-500/50 bg-brand-500/10">
            <IconHouse6Outline24 size={18} />
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
                  <item.icon size={16} />
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
