import {
  Bot,
  Bug,
  CalendarClock,
  Coffee,
  Compass,
  Download,
  Factory,
  FileCog,
  Gamepad2,
  Gauge,
  GraduationCap,
  House,
  LayoutDashboard,
  Map,
  Monitor,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShoppingCart,
  Smartphone,
  Sparkles,
  Swords,
  Terminal,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const icons = {
  automation: Zap,
  backend: Server,
  cafe: Coffee,
  combat: Swords,
  crafting: Factory,
  development: Terminal,
  emulator: Smartphone,
  install: Download,
  interface: LayoutDashboard,
  lesson: GraduationCap,
  maintenance: Wrench,
  pc: Monitor,
  profile: Compass,
  runtime: House,
  scheduler: CalendarClock,
  script: ScrollText,
  server: Server,
  settings: Settings,
  shop: ShoppingCart,
  stages: Map,
  sweeps: Sparkles,
  system: Gauge,
  team: Users,
  troubleshooting: Bug,
  update: RefreshCw,
  wiki: FileCog,
  autoFight: Bot,
  game: Gamepad2,
} satisfies Record<string, LucideIcon>;

export type DocHomeIconName = keyof typeof icons;

export function DocHomeIcon({ name }: { name: DocHomeIconName }) {
  const Icon = icons[name];

  return <Icon aria-hidden="true" className="baas-doc-card-icon" strokeWidth={2} />;
}
