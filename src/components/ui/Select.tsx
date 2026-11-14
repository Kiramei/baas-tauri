import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { cn } from "@/shared/cn";
import "./select-surface.css";

const SelectOpenContext = React.createContext(false);
const SelectScrollContext = React.createContext<{
  viewport: HTMLDivElement | null;
  up: boolean;
  down: boolean;
}>({ viewport: null, up: false, down: false });

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
  const [viewport, setViewport] = React.useState<HTMLDivElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const attachViewport = React.useCallback((node: HTMLDivElement | null) => {
    viewportRef.current = node;
    setViewport(node);
  }, []);
  const [overflow, setOverflow] = React.useState({ up: false, down: false });
  const pointerType = React.useRef("mouse");
  React.useLayoutEffect(() => {
    const node = viewportRef.current;
    if (!open || !node) {
      setOverflow({ up: false, down: false });
      return;
    }
    let interacted = false;
    const rememberInteraction = () => {
      interacted = true;
    };
    const update = () => {
      // Popper can constrain the height after Radix focuses the selected item.
      // Finish that initial alignment, then leave every user pan untouched.
      const selected = node.querySelector<HTMLElement>(
        "[data-state='checked'][data-slot='select-item']"
      );
      if (!interacted && selected && selected === document.activeElement) {
        const inset =
          parseFloat(getComputedStyle(node).getPropertyValue("--select-scroll-indicator-height")) ||
          0;
        if (selected.offsetTop < node.scrollTop + inset) {
          node.scrollTop = Math.max(0, selected.offsetTop - inset);
        } else if (
          selected.offsetTop + selected.offsetHeight >
          node.scrollTop + node.clientHeight - inset
        ) {
          node.scrollTop = selected.offsetTop + selected.offsetHeight - node.clientHeight + inset;
        }
      }
      const up = node.scrollTop > 1;
      const down = node.scrollHeight - node.clientHeight - node.scrollTop > 1;
      setOverflow((previous) =>
        previous.up === up && previous.down === down ? previous : { up, down }
      );
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(node);
    const items = node.querySelector("[data-slot='select-items']");
    if (items) observer?.observe(items);
    node.addEventListener("scroll", update, { passive: true });
    node.addEventListener("focusin", update);
    node.addEventListener("pointerdown", rememberInteraction, { capture: true, passive: true });
    node.addEventListener("wheel", rememberInteraction, { passive: true });
    node.addEventListener("keydown", rememberInteraction, { capture: true });
    return () => {
      observer?.disconnect();
      node.removeEventListener("scroll", update);
      node.removeEventListener("focusin", update);
      node.removeEventListener("pointerdown", rememberInteraction, true);
      node.removeEventListener("wheel", rememberInteraction);
      node.removeEventListener("keydown", rememberInteraction, true);
    };
  }, [open, viewport]);

  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        data-android-select={__WITH_ANDROID__ ? "" : undefined}
        data-native-preview-blocker={__WITH_ANDROID__ && open ? "" : undefined}
        className={cn(
          "select-surface text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-100 relative z-[1300] max-h-(--radix-select-content-available-height) max-w-[min(calc(100vw-24px),var(--radix-select-content-available-width))] min-w-[8rem] origin-(--radix-select-content-transform-origin) overflow-hidden border-none",
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
        <SelectScrollContext.Provider value={{ viewport, ...overflow }}>
          <SelectPrimitive.Viewport
            ref={attachViewport}
            data-slot="select-viewport"
            onPointerDownCapture={(event) => {
              pointerType.current = event.pointerType;
            }}
            onClickCapture={(event) => {
              if (pointerType.current === "mouse" || event.detail === 0) return;
              // Touch pans pass through hints without selecting an obscured row.
              const node = event.currentTarget;
              const bounds = node.getBoundingClientRect();
              const inset =
                (parseFloat(
                  getComputedStyle(node).getPropertyValue("--select-scroll-indicator-height")
                ) *
                  bounds.height) /
                node.clientHeight;
              if (
                (overflow.up && event.clientY < bounds.top + inset) ||
                (overflow.down && event.clientY > bounds.bottom - inset)
              ) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
            className={cn(
              "min-h-0 min-w-0 p-[6px]",
              position === "popper" &&
                "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1"
            )}
          >
            <SelectScrollUpButton />
            <div data-slot="select-items">{children}</div>
            <SelectScrollDownButton />
          </SelectPrimitive.Viewport>
        </SelectScrollContext.Provider>
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

/** Overflow hints never resize the viewport or refocus an item during a touch pan. */
function SelectScrollButton({
  direction,
  className,
  style,
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onPointerCancel,
  ...props
}: React.ComponentProps<"div"> & { direction: "up" | "down" }) {
  const scroll = React.useContext(SelectScrollContext);
  const timer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const visible = scroll[direction];
  const stop = React.useCallback(() => {
    if (timer.current !== null) clearInterval(timer.current);
    timer.current = null;
  }, []);
  React.useEffect(() => stop, [stop, scroll.viewport, visible]);
  const start = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.pointerType !== "mouse" || !scroll.viewport) return;
    const viewport = scroll.viewport;
    viewport.closest<HTMLElement>("[data-slot='select-content']")?.focus({ preventScroll: true });
    if (timer.current !== null) return;
    timer.current = setInterval(() => {
      const row = viewport.querySelector<HTMLElement>("[data-slot='select-item']");
      viewport.scrollTop += (direction === "up" ? -1 : 1) * (row?.offsetHeight || 28);
    }, 50);
  };
  if (!visible) return null;
  return (
    <div className={`select-surface-scroll-anchor select-surface-scroll-anchor-${direction}`}>
      <div
        {...props}
        data-slot={`select-scroll-${direction}-button`}
        aria-hidden="true"
        className={cn(
          `select-surface-scroll-indicator select-surface-scroll-${direction} flex cursor-default items-center justify-center py-1`,
          className
        )}
        style={{ ...style, ...(__WITH_ANDROID__ ? { minHeight: 44 } : {}) }}
        onPointerDown={(event) => {
          onPointerDown?.(event);
          start(event);
        }}
        onPointerMove={(event) => {
          onPointerMove?.(event);
          start(event);
        }}
        onPointerLeave={(event) => {
          onPointerLeave?.(event);
          stop();
        }}
        onPointerCancel={(event) => {
          onPointerCancel?.(event);
          stop();
        }}
      >
        {direction === "up" ? (
          <ChevronUpIcon className="size-4" />
        ) : (
          <ChevronDownIcon className="size-4" />
        )}
      </div>
    </div>
  );
}

/** Renders the upper overflow indicator. */
function SelectScrollUpButton(props: React.ComponentProps<"div">) {
  return <SelectScrollButton {...props} direction="up" />;
}

/** Renders the select scroll down button component. */
function SelectScrollDownButton(props: React.ComponentProps<"div">) {
  return <SelectScrollButton {...props} direction="down" />;
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
