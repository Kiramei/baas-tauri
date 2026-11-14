const consumers = {
  windows: "src/components/layout/Header.tsx",
  macos: "src/transport/factory.ts",
  linux: "src/components/layout/WindowTitlebar.tsx",
};

/** Include both platform implementation and its real shared consumer. */
export function adapterTypecheckInputs(os) {
  if (!Object.hasOwn(consumers, os)) throw new Error(`Unknown frontend adapter: ${os}`);
  return [`src/platform/${os}/**/*`, consumers[os], "src/types/**/*.d.ts"];
}
