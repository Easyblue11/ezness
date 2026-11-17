import { useEffect, useState } from 'react';

/**
 * The live content width of an element, in CSS pixels.
 *
 * Charts draw in an SVG whose viewBox is the pixel width of the box they land
 * in, so text and marks keep their designed size at any card width instead of
 * being scaled up along with a fullscreen dialog.
 *
 * Returns a callback ref and the width, so it also works for boxes that mount
 * later (a result arriving, a sheet opening).
 */
export function useElementWidth<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!node) {
      setWidth(0);
      return;
    }
    const measure = () => setWidth(Math.round(node.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return [setNode, width];
}
