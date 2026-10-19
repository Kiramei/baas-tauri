import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";

import { cn } from "@/shared/cn";

const PopoverOpenContext = React.createContext(false);

/** Renders the popover component. */
function Popover({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false);
  return (
    <PopoverOpenContext.Provider value={open ?? localOpen}>
      <PopoverPrimitive.Root
        data-slot="popover"
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(nextOpen) => {
          setLocalOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
        {...props}
      />
    </PopoverOpenContext.Provider>
  );
}

/** Renders the popover trigger component. */
function PopoverTrigger({
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return (
    <PopoverPrimitive.Trigger
      data-slot="popover-trigger"
      {...props}
      style={{ ...style, ...(__WITH_ANDROID__ ? { minWidth: 44, minHeight: 44 } : {}) }}
    />
  );
}

/** Renders the popover content component. */
function PopoverContent({
  className,
  align = "center",
  sideOffset = 4,
  collisionPadding = __WITH_ANDROID__ ? 12 : undefined,
  style,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  const open = React.useContext(PopoverOpenContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-native-preview-blocker={__WITH_ANDROID__ && open ? "" : undefined}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          "bg-[var(--menu-background)] text-popover-foreground backdrop-blur-xl backdrop-saturate-125 " +
            "data-[state=open]:animate-in data-[state=closed]:animate-out" +
            " data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 " +
            "duration-100 z-[1300] w-72 origin-(--radix-popover-content-transform-origin) rounded-[8px] " +
            "border-none p-3 shadow-[var(--menu-shadow)] outline-hidden",
          __WITH_ANDROID__ && "[&_[role=menuitem]]:min-h-11 [&_[role=option]]:min-h-11",
          className
        )}
        {...props}
        style={{
          ...style,
          ...(__WITH_ANDROID__
            ? {
                maxWidth:
                  "min(calc(var(--android-viewport-width, 100vw) - 24px), var(--radix-popover-content-available-width, 100vw))",
                maxHeight:
                  "min(calc(var(--android-viewport-height, 100dvh) - 24px), var(--radix-popover-content-available-height, 100dvh))",
                overflowY: "auto",
                overscrollBehavior: "contain",
              }
            : {}),
        }}
      />
    </PopoverPrimitive.Portal>
  );
}

/** Renders the popover anchor component. */
function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
