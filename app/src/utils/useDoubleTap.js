import { useRef, useCallback } from 'react';

export function useDoubleTap(onDoubleTap, delay = 300) {
  const lastTap = useRef(null);

  const onTouchEnd = useCallback((e) => {
    const now = Date.now();
    if (lastTap.current && now - lastTap.current < delay) {
      lastTap.current = null;
      onDoubleTap(e);
    } else {
      lastTap.current = now;
    }
  }, [onDoubleTap, delay]);

  return { onTouchEnd };
}
