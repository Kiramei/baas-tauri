import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { CalendarCheckIcon } from "@phosphor-icons/react/dist/csr/CalendarCheck";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { GearSixIcon } from "@phosphor-icons/react/dist/csr/GearSix";
import { BookOpenTextIcon } from "@phosphor-icons/react/dist/csr/BookOpenText";
import type { PageKey } from "@/types/app";

interface NavigationIconProps {
  page: PageKey;
  selected: boolean;
  size?: number;
  className?: string;
}

// Import each icon directly so development and production load only this family of five.
const navigationIcons = {
  home: HouseIcon,
  scheduler: CalendarCheckIcon,
  configuration: SlidersHorizontalIcon,
  settings: GearSixIcon,
  wiki: BookOpenTextIcon,
} satisfies Record<PageKey, typeof HouseIcon>;

/** Page selection changes weight within one icon family; focus never swaps its silhouette. */
export default function NavigationIcon({
  page,
  selected,
  size = 19,
  className,
}: NavigationIconProps) {
  const Icon = navigationIcons[page];
  return (
    <Icon
      size={size}
      weight={selected ? "fill" : "regular"}
      color="currentColor"
      className={className}
      aria-hidden="true"
      focusable="false"
      data-navigation-icon={page}
      data-filled-navigation={selected ? page : undefined}
    />
  );
}
