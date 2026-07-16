import { loader } from "fumadocs-core/source";
import { docs } from "@/.source/server";
import { i18n } from "@/lib/i18n";
import { createElement, type ComponentType, type ReactNode, type SVGProps } from "react";
import {
  Bot,
  Bug,
  CalendarClock,
  Coffee,
  Code2,
  Compass,
  Download,
  Factory,
  FileCog,
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
  api: Code2,
  features: Settings,
  guide: Compass,
  reference: FileCog,
};

const pageIcons: Array<[string, IconComponent]> = [
  ["/guide/install", Download],
  ["/guide/android", Smartphone],
  ["/guide/interface", LayoutDashboard],
  ["/guide/scheduler", CalendarClock],
  ["/guide/wiki", FileCog],
  ["/api/overview", Code2],
  ["/api/tauri-commands", Terminal],
  ["/api/service-transport", Server],
  ["/api/frontend-runtime", LayoutDashboard],
  ["/api/android-runtime", Smartphone],
  ["/api/contracts-testing", FileCog],
  ["/features/profile", Compass],
  ["/features/home-runtime", House],
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
  ["/reference/backend-development", Terminal],
  ["/reference/auto-fight-dev", Bot],
  ["/reference/development", FileCog],
];

/** Handles the with icon workflow. */
function withIcon<T extends { icon?: ReactNode }>(node: T, Icon: IconComponent, key: string): T {
  return node.icon ? node : { ...node, icon: pageTreeIcon(Icon, key) };
}

const iconTransformer = {
  /** Handles the file workflow. */
  file<T extends { icon?: ReactNode; url: string }>(node: T) {
    const match = pageIcons.find(([slug]) => node.url.endsWith(slug));
    return match ? withIcon(node, match[1], `page-tree-icon:${match[0]}`) : node;
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
  url: (slugs, locale) => {
    const lang = locale === "en" ? "en" : "zh";
    const path = slugs.length > 0 ? `/${slugs.join("/")}` : "";
    return `/docs/${lang}${path}`;
  },
  source: docs.toFumadocsSource(),
});
