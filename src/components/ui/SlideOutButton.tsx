import React, { useState } from "react";
import { Settings } from "lucide-react";

type SlideOutButtonProps = {
  icon?: React.ReactNode;
  width?: number;
  className?: string;
  children: React.ReactNode;
};

/** Renders the slide out button component. */
export const SlideOutButton: React.FC<SlideOutButtonProps> = ({
  icon,
  width = 256,
  className,
  children,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <div className={`flex items-center ${className ?? ""}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="z-10 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        {icon ?? <Settings className="h-5 w-5" />}
      </button>

      <div
        className="overflow-hidden text-foreground transition-all duration-200 ease-out"
        style={{
          width: open ? width : 0,
          opacity: open ? 1 : 0,
        }}
      >
        <div style={{ width }} className="text-sm">
          {children}
        </div>
      </div>
    </div>
  );
};
