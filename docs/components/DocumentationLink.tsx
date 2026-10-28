"use client";

import Link, { type LinkProps } from "fumadocs-core/link";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export function publicAssetHref(href: string, prefix: string): string | undefined {
  if (!href.startsWith("/") || href.startsWith("//")) return;
  const target = new URL(href, "https://docs.invalid");
  if (
    target.pathname === "/" ||
    target.pathname === "/docs" ||
    target.pathname.startsWith("/docs/")
  )
    return;
  return `${prefix}${target.pathname}${target.search}${target.hash}`;
}

export function DocumentationLink({ href = "#", external, prefetch, ...props }: LinkProps) {
  const asset = publicAssetHref(href, basePath);
  if (asset && !external) return <a {...props} href={asset} />;
  return <Link {...props} href={asset ?? href} external={external} prefetch={prefetch} />;
}
