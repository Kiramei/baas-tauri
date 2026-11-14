import { useCallback, useLayoutEffect, useRef, useState, type SetStateAction } from "react";
import { useInput } from "ink";

export function useInputState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const latest = useRef(value);
  const update = useCallback((next: SetStateAction<T>) => {
    const value = typeof next === "function" ? (next as (previous: T) => T)(latest.current) : next;
    // Several framed keys can arrive before React commits the next input frame.
    latest.current = value;
    setValue(value);
  }, []);
  return [value, update, latest] as const;
}

export function useCurrentInput(
  handler: Parameters<typeof useInput>[0],
  options: Parameters<typeof useInput>[1]
) {
  const current = useRef(handler);
  // Ink replaces callbacks in a passive effect. Committed frames need their handler immediately.
  useLayoutEffect(() => {
    current.current = handler;
  });
  useInput(
    useCallback((text, key) => current.current(text, key), []),
    options
  );
}
