declare global {
  interface Window {
    __BAAS_ALLOW_RELOAD__?: boolean;
  }
}

export const reloadWithoutPrompt = () => {
  window.__BAAS_ALLOW_RELOAD__ = true;
  window.location.reload();
};
