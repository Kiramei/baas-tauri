import React, { useState } from "react";
import { Settings } from "lucide-react";

type SlideOutButtonProps = {
  icon?: React.ReactNode;
  width?: number;
  className?: string;
  children: React.ReactNode;
};

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
        className="z-10 flex h-8 w-8 items-center justify-center rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-white shadow-md hover:bg-slate-300 dark:hover:bg-slate-700 transition"
      >
        {icon ?? <Settings className="h-5 w-5" />}
      </button>

      <div
        className="overflow-hidden text-white transition-all duration-300 ease-out"
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
