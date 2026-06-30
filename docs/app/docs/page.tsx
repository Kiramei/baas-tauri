import { redirect } from "next/navigation";

/** Renders the docs index page component. */
export default function DocsIndexPage() {
  redirect("/docs/zh");
}
