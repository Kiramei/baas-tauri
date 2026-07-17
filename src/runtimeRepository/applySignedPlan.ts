import { invoke } from "@/shared/TauriInvoke";

export type RuntimeRepositoryApplyReport = {
  generation: string;
  disposition: "committed" | "not_committed" | "committed_durability_uncertain";
  backendOutcome: "python_unchanged" | "cpp_restarted";
  baseBackendAddr?: string;
  baseBackendPort?: number;
};

/**
 * Passes one publisher-signed envelope to the desktop owner. The frontend has
 * no repository URL/ref/commit/key/path/generation API by design.
 */
export async function applyRuntimeRepositorySignedPlan(
  envelope: string | Uint8Array
): Promise<RuntimeRepositoryApplyReport> {
  if (!__WITH_TAURI__ || __WITH_ANDROID__) {
    throw new Error("Runtime repository publication is available only on desktop");
  }
  const opaqueEnvelope = typeof envelope === "string" ? envelope : Array.from(envelope);
  return invoke<RuntimeRepositoryApplyReport>("runtime_repository_apply_signed_plan", {
    request: { envelope: opaqueEnvelope },
  });
}
