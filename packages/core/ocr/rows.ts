import type { OcrLine } from "./types.ts";

export interface OcrRow {
	/** Reading-order row number, or null when the backend gave none. */
	row: number | null;
	/** The row's lines joined with a space, left to right. */
	text: string;
	lines: OcrLine[];
}

/**
 * Groups consecutive lines that share a row. On a receipt an item name and
 * its price are separate OCR lines on one printed row.
 */
export function groupRows(lines: readonly OcrLine[]): OcrRow[] {
	const rows: OcrRow[] = [];
	for (const line of lines) {
		const last = rows.at(-1);
		if (last && line.row !== undefined && last.row === line.row) {
			last.lines.push(line);
			last.text += ` ${line.text}`;
		} else {
			rows.push({ row: line.row ?? null, text: line.text, lines: [line] });
		}
	}
	return rows;
}

/** Left edge of a line's box, or null without geometry. */
export function leftEdge(line: Pick<OcrLine, "box">): number | null {
	return line.box ? Math.min(...line.box.map((point) => point.x)) : null;
}
