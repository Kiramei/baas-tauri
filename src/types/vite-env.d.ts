/// <reference types="vite/client" />
declare module '*.json' {
  const value: any;
}

declare interface ImportMeta {
  readonly glob: <T = unknown>(
    pattern: string,
    options?: {
      eager?: boolean;
      import?: string;
      query?: string;
    }
  ) => Record<string, T>;
}
