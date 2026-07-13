declare global {
  interface Window {
    __BAAS_ALLOW_RELOAD__?: boolean;
  }
}

/** Handles the reload without prompt workflow. */
export const reloadWithoutPrompt = () => {
  window.__BAAS_ALLOW_RELOAD__ = true;
  window.location.reload();
};
