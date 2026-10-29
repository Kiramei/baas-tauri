export type ReleaseKind = "stable" | "rc" | "post";
export interface ReleaseVersion {
  canonical: string;
  base: string;
  major: number;
  minor: number;
  patch: number;
  kind: ReleaseKind;
  serial: number;
  semver: string;
}
export interface ReleaseVersionOptions {
  allowLegacy?: boolean;
}
export function parseReleaseVersion(
  value: unknown,
  options?: ReleaseVersionOptions
): ReleaseVersion | null;
export function normalizeReleaseVersion(
  value: unknown,
  options?: ReleaseVersionOptions
): string | null;
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1;
export function releaseVersionFromPackage(metadata: {
  version?: unknown;
  releaseVersion?: unknown;
}): ReleaseVersion;
export function androidVersionCode(value: string, override?: string | number): number;
