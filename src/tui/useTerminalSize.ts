import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  columns: number;
  rows: number;
}

/**
 * Terminal dimensions, kept current across resizes.
 *
 * `||` rather than `??` throughout: some terminals and pty wrappers report 0, which
 * nullish coalescing would pass through as a genuine size.
 */
export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const read = (): TerminalSize => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  const [size, setSize] = useState<TerminalSize>(read);

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    // Catch a resize that landed between the first read and this subscription.
    onResize();
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
