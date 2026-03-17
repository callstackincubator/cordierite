import { toQR } from "toqr";

export type QrTerminalRenderOptions = {
  /** Quiet zone in modules (default 0). */
  margin?: number;
  /**
   * `toqr` error-correction index: M=0, L=1, H=2, Q=3 (default 1 = L).
   */
  ecLevel?: number;
};

const HALF_UPPER = "\u2580"; // ▀
const HALF_LOWER = "\u2584"; // ▄
const FULL = "\u2588"; // █

/**
 * Renders a QR payload as compact half-block terminal art (two modules per character row).
 */
export const renderQrToTerminal = (
  content: string,
  options?: QrTerminalRenderOptions,
): string => {
  const margin = options?.margin ?? 0;
  const ecLevel = options?.ecLevel ?? 1;
  const modules = toQR(content, ecLevel);
  const side = Math.sqrt(modules.length);
  if (!Number.isInteger(side)) {
    throw new Error("Invalid QR matrix size");
  }

  const dim = side + 2 * margin;
  const isDark = (row: number, col: number): boolean => {
    if (
      row < margin ||
      col < margin ||
      row >= margin + side ||
      col >= margin + side
    ) {
      return false;
    }
    const mr = row - margin;
    const mc = col - margin;
    return modules[mr * side + mc] === 1;
  };

  const lines: string[] = [];
  for (let row = 0; row < dim; row += 2) {
    let line = "";
    for (let col = 0; col < dim; col++) {
      const top = isDark(row, col);
      const bottom = row + 1 < dim ? isDark(row + 1, col) : false;
      line += top
        ? bottom
          ? FULL
          : HALF_UPPER
        : bottom
          ? HALF_LOWER
          : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
};
