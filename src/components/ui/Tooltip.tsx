import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/shared/cn";

/** Renders the tooltip provider component. */
function TooltipProvider({
  delayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

/** Renders the tooltip component. */
function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

/** Renders the tooltip trigger component. */
function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

type TooltipContentProps = React.ComponentProps<typeof TooltipPrimitive.Content> & {
  arrowClassName?: string;
};

/** Renders the tooltip content component. */
function TooltipContent({
  className,
  arrowClassName,
  sideOffset = 8,
  children,
  ...props
}: TooltipContentProps) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "border border-white/8 bg-[#181818] text-[#fafafa] shadow-[0_4px_12px_rgba(0,0,0,0.18)] animate-in fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-100 z-[1400] w-fit max-w-72 origin-(--radix-tooltip-content-transform-origin) rounded-[14px] px-3 py-1.5 text-[13px] leading-5 text-balance",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow
          className={cn(
            "bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] hidden!",
            arrowClassName
          )}
        />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

type IconTooltipProps = Pick<TooltipContentProps, "side" | "align" | "sideOffset"> & {
  content: React.ReactNode;
  children: React.ReactElement;
  delayDuration?: number;
  disabled?: boolean;
};

/** Adds a styled hint without adding a DOM wrapper or changing the control's cursor. */
function IconTooltip({
  content,
  children,
  side = "top",
  align = "center",
  sideOffset = 8,
  delayDuration = 400,
  disabled = false,
}: IconTooltipProps) {
  if (disabled || !content) return children;
  return (
    <Tooltip delayDuration={delayDuration} disableHoverableContent>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} sideOffset={sideOffset}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, IconTooltip };
