import { useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/Popover";
import { IconTooltip } from "@/components/ui/Tooltip";
import { useAppTranslation } from "@/shared/useAppTranslation";

export default function WorkspaceSwitcher() {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const currentRef = useRef<HTMLButtonElement>(null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="BAAS"
          aria-haspopup="menu"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
            }
          }}
          className="-ml-2 inline-flex min-w-0 items-center gap-1.5 rounded-[10px] bg-transparent px-2 py-0.5 text-[16px] font-semibold leading-7 tracking-[-0.01em] text-foreground outline-none hover:bg-sidebar-accent"
        >
          <span>BAAS</span>
          <ChevronDown className="size-3.5 text-muted-foreground" strokeWidth={1.6} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        role="menu"
        aria-label="BAAS"
        align="start"
        sideOffset={5}
        className="w-64 rounded-[14px] bg-popover p-1.5 backdrop-blur-none backdrop-saturate-100"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          currentRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            currentRef.current?.focus();
          }
        }}
      >
        <button
          ref={currentRef}
          type="button"
          role="menuitemradio"
          aria-checked="true"
          onClick={() => setOpen(false)}
          className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left outline-none hover:bg-secondary focus-visible:bg-secondary"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">BAAS</span>
            <span className="mt-0.5 block text-xs leading-[18px] text-muted-foreground">
              {t("app.modeBaasDescription")}
            </span>
          </span>
          <Check className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.8} />
        </button>
        <div className="relative">
          <button
            type="button"
            role="menuitemradio"
            aria-checked="false"
            disabled
            className="flex w-full items-center gap-3 rounded-[10px] py-2.5 pl-3 pr-10 text-left text-muted-foreground opacity-45 disabled:cursor-not-allowed"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold">BAAS Raid</span>
              <span className="mt-0.5 block text-xs leading-[18px]">
                {t("app.modeRaidDescription")}
              </span>
            </span>
          </button>
          <IconTooltip content={t("app.modeInDevelopment")} side="right">
            <span
              role="img"
              aria-label={t("app.modeInDevelopment")}
              tabIndex={0}
              className="absolute right-3 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center text-muted-foreground outline-none"
            >
              <CircleAlert className="size-3.5" strokeWidth={1.6} />
            </span>
          </IconTooltip>
        </div>
      </PopoverContent>
    </Popover>
  );
}
