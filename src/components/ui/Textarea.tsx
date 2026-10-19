import * as React from "react";
import { cn } from "@/shared/cn";

/** Renders the textarea component. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      wrap="soft"
      className={cn(
        "border-input placeholder:text-muted-foreground aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content min-h-16 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none disabled:cursor-not-allowed disabled:opacity-40",
        "whitespace-pre-wrap break-keep break-normal overflow-x-auto hyphens-none",
        className
      )}
      style={{
        wordBreak: "keep-all",
        overflowWrap: "normal",
        whiteSpace: "pre-wrap",
      }}
      {...props}
    />
  );
}

export { Textarea };
