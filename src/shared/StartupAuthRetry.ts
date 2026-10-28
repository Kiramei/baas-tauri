import { transportRecoveryDelay } from "./ServiceTransportEvents";

/** The first connection is immediate; failed browser starts back off until ready. */
export function createStartupAuthRetry(webui: boolean) {
  let attempts = 0;
  return {
    schedule(connect: () => void): () => void {
      const delay = webui && attempts > 0 ? transportRecoveryDelay(attempts - 1) : 0;
      const timer = setTimeout(() => {
        attempts += 1;
        connect();
      }, delay);
      return () => clearTimeout(timer);
    },
    reset() {
      attempts = 0;
    },
  };
}
