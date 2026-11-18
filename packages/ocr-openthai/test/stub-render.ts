/**
 * Stub for python/render_pdf.py: echoes its arguments back in the result
 * and writes a placeholder PNG, so tests need neither Python nor pdfium.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const value = (flag: string) =>
	args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const pdf = args[0] ?? "";
const page = Number(value("--page") ?? 1);

if (pdf.includes("broken")) {
	console.log(JSON.stringify({ ok: false, error: "cannot open PDF: stub" }));
	process.exit(1);
}
if (pdf.includes("crash")) {
	process.stderr.write("Traceback: stub crash\n");
	process.exit(3);
}
if (page > 2) {
	console.log(
		JSON.stringify({
			ok: false,
			error: `page ${page} does not exist: the PDF has 2 page(s)`,
		}),
	);
	process.exit(1);
}

const info = {
	ok: true,
	page_count: 2,
	page,
	page_size_pt: [100, 200],
	images: [{ width: 300, height: 600, page_share: 1 }],
	native_scale: 3,
	native_dpi: 216,
};
if (args.includes("--info")) {
	console.log(JSON.stringify(info));
	process.exit(0);
}
const dpi = value("--dpi");
const scale = dpi ? Number(dpi) / 72 : 3 * Number(value("--scale") ?? 1);
const width = Math.round(100 * scale);
const height = Math.round(200 * scale);
const outDir = value("--out-dir") ?? ".";
mkdirSync(outDir, { recursive: true });
const png = join(outDir, `stubhash-p${page}-${width}x${height}.png`);
// The content encodes the render settings, like a real render would differ.
writeFileSync(png, `fake png page=${page} ${width}x${height}`);
console.log(
	JSON.stringify({
		...info,
		render: {
			png,
			width,
			height,
			scale,
			dpi: scale * 72,
			mode: dpi
				? "dpi"
				: value("--scale")
					? `native_x${value("--scale")}`
					: "native",
		},
	}),
);
