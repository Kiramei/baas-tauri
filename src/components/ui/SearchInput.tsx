import type { ComponentProps } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { cn } from "@/shared/cn";

interface SearchInputProps extends ComponentProps<"input"> {
  containerClassName?: string;
}

/** A shared search surface; input handlers, refs, font and cursor stay native. */
export function SearchInput({
  className,
  containerClassName,
  type = "text",
  role = "searchbox",
  placeholder,
  "aria-label": ariaLabel,
  ...props
}: SearchInputProps) {
  return (
    <div className={cn("relative w-full min-w-0", containerClassName)}>
      <MagnifyingGlassIcon
        size={18}
        weight="regular"
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#909090] dark:text-[#9b9b9b]"
      />
      <input
        {...props}
        type={type}
        role={role}
        aria-label={ariaLabel ?? placeholder}
        placeholder={placeholder}
        data-slot="search-input"
        className={cn(
          "block h-9 w-full min-w-0 rounded-full border-0 bg-[#eeeeee] py-0 pl-10 pr-3 text-sm text-foreground outline-none placeholder:text-[#8f8f8f] disabled:opacity-40 dark:bg-[#2b2b2b] dark:placeholder:text-[#979797]",
          className
        )}
      />
    </div>
  );
}
