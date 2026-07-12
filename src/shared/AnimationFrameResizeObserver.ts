/** Observes an element and defers layout writes until the next animation frame. */
export const observeResizeOnAnimationFrame = (
  element: Element,
  callback: () => void,
  options?: ResizeObserverOptions
) => {
  let frame = 0;
  let disposed = false;

  const schedule = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!disposed) callback();
    });
  };

  const observer = new ResizeObserver(schedule);
  observer.observe(element, options);
  schedule();

  return () => {
    disposed = true;
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
};
