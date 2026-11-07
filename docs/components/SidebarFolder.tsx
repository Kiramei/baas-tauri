"use client";

import { useEffect, type ReactNode } from "react";
import type { Folder } from "fumadocs-core/page-tree";
import { usePathname } from "fumadocs-core/framework";
import { useTreePath } from "fumadocs-ui/contexts/tree";
import {
  SidebarFolder as FolderRoot,
  SidebarFolderContent,
  SidebarFolderLink,
  SidebarFolderTrigger,
  useFolder,
  useFolderDepth,
} from "fumadocs-ui/components/sidebar/base";

const itemClassName =
  "relative flex flex-row items-center gap-2 rounded-lg p-2 text-start text-fd-muted-foreground wrap-anywhere [&_svg]:size-4 [&_svg]:shrink-0 w-full";
const expandedFolders = new Map<string, boolean>();

function FolderContents({
  item,
  children,
  folderKey,
  active,
  paddingInlineStart,
  depth,
}: {
  item: Folder;
  children: ReactNode;
  folderKey: string;
  active: boolean;
  paddingInlineStart: string;
  depth: number;
}) {
  const folder = useFolder();
  const pathname = usePathname();
  const open = folder?.open ?? false;
  const setOpen = folder?.setOpen;
  const indexActive = item.index?.url.replace(/\/$/, "") === pathname.replace(/\/$/, "");

  useEffect(() => {
    if (!active && !expandedFolders.get(folderKey) && open) setOpen?.(false);
  }, [active, folderKey, open, setOpen]);

  return (
    <>
      {item.index ? (
        <SidebarFolderLink
          href={item.index.url}
          external={item.index.external}
          active={indexActive}
          onClickCapture={() => expandedFolders.set(folderKey, indexActive ? !open : true)}
          className={`${itemClassName} transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80 data-[active=true]:bg-fd-primary/10 data-[active=true]:text-fd-primary`}
          style={{ paddingInlineStart }}
        >
          {item.icon}
          {item.name}
        </SidebarFolderLink>
      ) : (
        <SidebarFolderTrigger
          onClick={() => expandedFolders.set(folderKey, !open)}
          className={`${itemClassName} transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground/80`}
          style={{ paddingInlineStart }}
        >
          {item.icon}
          {item.name}
        </SidebarFolderTrigger>
      )}
      <SidebarFolderContent
        className={
          depth === 0
            ? "relative before:content-[''] before:absolute before:w-px before:inset-y-1 before:bg-fd-border before:inset-s-2.5"
            : "relative"
        }
      >
        <div className="flex flex-col gap-0.5 pt-0.5">{children}</div>
      </SidebarFolderContent>
    </>
  );
}

export function SidebarFolder({ item, children }: { item: Folder; children: ReactNode }) {
  const path = useTreePath();
  const depth = useFolderDepth();
  const active = path.includes(item);
  const folderKey = item.$ref?.folder ?? item.$id ?? item.index?.url ?? String(item.name);
  const paddingInlineStart = `calc(${2 + 3 * depth} * var(--spacing))`;

  return (
    <FolderRoot
      collapsible={item.collapsible}
      active={active}
      defaultOpen={expandedFolders.get(folderKey) ?? false}
    >
      <FolderContents
        item={item}
        folderKey={folderKey}
        active={active}
        paddingInlineStart={paddingInlineStart}
        depth={depth}
      >
        {children}
      </FolderContents>
    </FolderRoot>
  );
}
