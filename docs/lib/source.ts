import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { i18n } from "@/lib/i18n";
import { createElement, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  Bot,
  BookOpen,
  Bug,
  CalendarClock,
  Code2,
  Coffee,
  Compass,
  Container,
  Download,
  Factory,
  FileText,
  FileCog,
  Gamepad2,
  Gauge,
  GraduationCap,
  House,
  KeyRound,
  LayoutDashboard,
  Map,
  Monitor,
  Network,
  Package,
  Plug,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Swords,
  Terminal,
  Users,
  Wrench,
  Zap,
} from "lucide-react";

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

/** Handles the page tree icon workflow. */
function pageTreeIcon(Icon: IconComponent, key: string) {
  return createElement(Icon, {
    key,
    "aria-hidden": true,
    className: "baas-page-tree-icon",
    strokeWidth: 2,
  });
}

const folderIcons: Record<string, IconComponent> = {
  android: Smartphone,
  baasx: Terminal,
  developer: Code2,
  development: Code2,
  docker: Container,
  features: Settings,
  guide: Compass,
  other: BookOpen,
  others: BookOpen,
  reference: FileCog,
};

const pageIcons: Array<[string, IconComponent]> = [
  ["/docs", House],
  ["/guide/install", Download],
  ["/guide/android", Smartphone],
  ["/guide/interface", LayoutDashboard],
  ["/guide/configuration", Settings],
  ["/guide/scheduler", CalendarClock],
  ["/guide/wiki", FileCog],
  ["/features/profile", Compass],
  ["/features/home-runtime", House],
  ["/features/plugins", Plug],
  ["/features/server", Server],
  ["/features/emulator", Smartphone],
  ["/features/script", ScrollText],
  ["/features/pc-platform", Monitor],
  ["/features/stages", Map],
  ["/features/sweeps", Zap],
  ["/features/team", Users],
  ["/features/cafe", Coffee],
  ["/features/lesson", GraduationCap],
  ["/features/shop", ShoppingCart],
  ["/features/crafting", Factory],
  ["/features/combat", Swords],
  ["/features/maintenance", Wrench],
  ["/features/system", Gauge],
  ["/features/update", RefreshCw],
  ["/reference/release-history", RefreshCw],
  ["/reference/troubleshooting", Bug],
  ["/reference/report-uninstall", FileCog],
  ["/reference/setup-toml", Settings],
  ["/reference/cli-service", Terminal],
  ["/reference/backend-service", Server],
  ["/reference/client-api", Terminal],
  ["/reference/backend-development", Terminal],
  ["/reference/auto-fight-dev", Bot],
  ["/reference/development", FileCog],
  ["/android/install", Download],
  ["/android/profiles", Users],
  ["/android/shizuku", ShieldCheck],
  ["/android/background-game", Gamepad2],
  ["/android/configuration", Settings],
  ["/android/lifecycle", CalendarClock],
  ["/android/updates", RefreshCw],
  ["/android/compatibility", Smartphone],
  ["/docker/installation", Download],
  ["/docker/authentication", KeyRound],
  ["/docker/device", Smartphone],
  ["/docker/network", Network],
  ["/docker/backend", Server],
  ["/docker/development", Code2],
  ["/baasx/installation", Download],
  ["/baasx/workbench", LayoutDashboard],
  ["/baasx/configuration", Settings],
  ["/baasx/scheduler", CalendarClock],
  ["/baasx/command-packs", Package],
  ["/baasx/cli", Terminal],
  ["/baasx/troubleshooting", Bug],
];

/** Handles the with icon workflow. */
function withIcon<T extends { icon?: ReactNode }>(node: T, Icon: IconComponent, key: string): T {
  return node.icon ? node : { ...node, icon: pageTreeIcon(Icon, key) };
}

const iconTransformer = {
  /** Handles the file workflow. */
  file<T extends { icon?: ReactNode; url: string }>(node: T) {
    const match = pageIcons.find(([slug]) => node.url.endsWith(slug));
    return withIcon(node, match?.[1] ?? FileText, `page-tree-icon:${match?.[0] ?? node.url}`);
  },
  /** Handles the folder workflow. */
  folder<T extends { icon?: ReactNode }>(node: T, folderPath: string) {
    const folder = folderPath.split(/[\\/]/).filter(Boolean).at(-1);
    const Icon = folder ? folderIcons[folder] : undefined;
    return Icon ? withIcon(node, Icon, `page-tree-folder-icon:${folder}`) : node;
  },
};

export const source = loader({
  baseUrl: "/docs",
  i18n,
  pageTree: {
    transformers: [iconTransformer],
  },
  url: (slugs) => {
    const path = slugs.length > 0 ? `/${slugs.join("/")}` : "";
    return `/docs${path}`;
  },
  source: docs.toFumadocsSource(),
});
