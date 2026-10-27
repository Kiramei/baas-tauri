import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "@/shared/cn";
import "./select-surface.css";

const SelectOpenContext = React.createContext(false);

/** Renders the select component. */
function Select({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Root>) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen ?? false);
  return (
    <SelectOpenContext.Provider value={open ?? localOpen}>
      <SelectPrimitive.Root
        data-slot="select"
        open={open}
        defaultOpen={defaultOpen}
        onOpenChange={(nextOpen) => {
          setLocalOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
        {...props}
      />
    </SelectOpenContext.Provider>
  );
}

/** Renders the select group component. */
function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

/** Renders the select value component. */
function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

/** Renders the select trigger component. */
function SelectTrigger({
  className,
  size = "default",
  children,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger> & {
  size?: "sm" | "default";
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        "border-input data-[placeholder]:text-muted-foreground [&_svg:not([class*='text-'])]:text-muted-foreground aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex w-fit items-center justify-between gap-2 rounded-[8px] border bg-transparent hover:bg-secondary/60 px-3 py-2 text-sm whitespace-nowrap transition-colors duration-150 outline-none disabled:cursor-not-allowed disabled:opacity-40 data-[size=default]:h-9 data-[size=sm]:h-8 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className
      )}
      {...props}
      style={{ ...style, ...(__WITH_ANDROID__ ? { minWidth: 44, minHeight: 44 } : {}) }}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

/** Renders the select content component. */
function SelectContent({
  className,
  children,
  position = "popper",
  collisionPadding = __WITH_ANDROID__ ? 12 : undefined,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  const open = React.useContext(SelectOpenContext);
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-native-preview-blocker={__WITH_ANDROID__ && open ? "" : undefined}
        className={cn(
          "select-surface text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-100 relative z-[1300] max-h-(--radix-select-content-available-height) max-w-[min(calc(100vw-24px),var(--radix-select-content-available-width))] min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-x-hidden overflow-y-auto border-none",
          position === "popper" &&
            "data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1",
          className
        )}
        position={position}
        collisionPadding={collisionPadding}
        {...props}
        style={{
          ...style,
          ...(__WITH_ANDROID__
            ? {
                maxWidth:
                  "min(calc(var(--android-viewport-width, 100vw) - 24px), var(--radix-select-content-available-width, 100vw))",
                maxHeight:
                  "min(calc(var(--android-viewport-height, 100dvh) - 24px), var(--radix-select-content-available-height, 100dvh))",
                overscrollBehavior: "contain",
              }
            : {}),
        }}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport
          className={cn(
            "min-w-0 p-[6px]",
            position === "popper" &&
              "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
          )}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

/** Renders the select label component. */
function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn("text-muted-foreground px-3 py-1.5 text-xs", className)}
      {...props}
    />
  );
}

/** Renders the select item component. */
function SelectItem({
  className,
  children,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "select-surface-item focus:text-foreground [&_svg:not([class*='text-'])]:text-muted-foreground relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-[7px] py-1 pr-8 pl-3 text-[13px] leading-5 outline-hidden select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 *:[span]:last:flex *:[span]:last:items-center *:[span]:last:gap-2",
        className
      )}
      {...props}
      style={{ ...style, ...(__WITH_ANDROID__ ? { minHeight: 44 } : {}) }}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

/** Renders the select separator component. */
function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        "select-surface-separator pointer-events-none -mx-[6px] my-[6px] h-px",
        className
      )}
      {...props}
    />
  );
}

/** Renders the select scroll up button component. */
function SelectScrollUpButton({
  className,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
      style={{ ...style, ...(__WITH_ANDROID__ ? { minHeight: 44 } : {}) }}
    >
      <ChevronUpIcon className="size-4" />
    </SelectPrimitive.ScrollUpButton>
  );
}

/** Renders the select scroll down button component. */
function SelectScrollDownButton({
  className,
  style,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn("flex cursor-default items-center justify-center py-1", className)}
      {...props}
      style={{ ...style, ...(__WITH_ANDROID__ ? { minHeight: 44 } : {}) }}
    >
      <ChevronDownIcon className="size-4" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
