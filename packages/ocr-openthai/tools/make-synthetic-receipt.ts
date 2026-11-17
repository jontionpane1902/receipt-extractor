/**
 * Generates the synthetic receipt image used by the opt-in OCR integration
 * test and the synthetic eval samples. Everything on it is invented — store
 * name, branch, tax ID, products, numbers (it mirrors
 * packages/core/schema/fixtures.ts). It is NOT a real receipt, and any
 * resemblance to a real store, company ID or product is unintended.
 *
 * To change the content: edit ROWS here and SAMPLE_OCR_TEXT/sampleReceipt in
 * fixtures.ts together, run this script, then `bun run test:ocr`.
 *
 *   bun packages/ocr-openthai/tools/make-synthetic-receipt.ts
 *
 * One-off developer tool: the PNG it writes is committed, so tests never
 * need to run this. It renders HTML with headless Chrome because Thai needs
 * real text shaping (stacked vowels and tone marks), and downloads the
 * Sarabun font (SIL Open Font License) into a temporary folder.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OUT_DIR = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"evals",
	"dataset",
	"synthetic",
	"images",
);
const CHROME =
	process.env.CHROME_PATH ??
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FONT_URL =
	"https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-Regular.ttf";

/** [left, right?] per printed row, top to bottom. */
const ROWS: readonly (readonly [string, string?])[] = [
	["DemoMart สาขาทดสอบ (00000)"],
	["TAX ID 9012345678902"],
	["R#0000012345 15/08/69 14:05"],
	["น้ำดื่มตราทดสอบ 600มล 2 @7.00", "14.00"],
	["ขนมข้าวพองสมมติ 48ก", "20.00"],
	["ชาเย็นหอม DEMO TEA", "35.00"],
	["ส่วนลด", "-5.00"],
	["ยอดสุทธิ 4 ชิ้น", "64.00"],
	["VAT 7%", "4.19"],
	["เงินสด", "100.00"],
	["เงินทอน", "36.00"],
	["SYNTHETIC TEST IMAGE - NOT A REAL RECEIPT"],
];

const WIDTH = 460;
const HEIGHT = 640;
const SCALE = 2;

const escapeHtml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");

const work = await mkdtemp(join(tmpdir(), "synthetic-receipt-"));
try {
	const font = await fetch(FONT_URL);
	if (!font.ok) throw new Error(`font download failed: ${font.status}`);
	await writeFile(
		join(work, "font.ttf"),
		new Uint8Array(await font.arrayBuffer()),
	);

	const html = `<!doctype html><html lang="th"><meta charset="utf-8"><style>
@font-face { font-family: Receipt; src: url("font.ttf"); }
html, body { margin: 0; background: #fff; }
body { width: ${WIDTH}px; height: ${HEIGHT}px; box-sizing: border-box; padding: 28px 30px;
  font: 21px/1.0 Receipt; color: #111; }
.row { display: flex; justify-content: space-between; height: 46px; align-items: center; white-space: pre; }
.row:last-child { font-size: 15px; }
</style><body>${ROWS.map(
		([left, right]) =>
			`<div class="row"><span>${escapeHtml(left)}</span>${right === undefined ? "" : `<span>${escapeHtml(right)}</span>`}</div>`,
	).join("")}</body></html>`;
	await writeFile(join(work, "receipt.html"), html);

	const png = join(OUT_DIR, "synthetic-receipt.png");
	const chrome = Bun.spawnSync(
		[
			CHROME,
			"--headless=new",
			"--disable-gpu",
			"--hide-scrollbars",
			`--force-device-scale-factor=${SCALE}`,
			`--window-size=${WIDTH},${HEIGHT}`,
			`--user-data-dir=${join(work, "profile")}`,
			`--screenshot=${png}`,
			`file://${join(work, "receipt.html")}`,
		],
		{ stderr: "pipe" },
	);
	if (!chrome.success) {
		throw new Error(`chrome failed: ${chrome.stderr.toString().slice(-500)}`);
	}

	await writeFile(
		join(OUT_DIR, "synthetic-receipt.expected.json"),
		`${JSON.stringify(
			{
				note: "Invented content rendered by packages/ocr-openthai/tools/make-synthetic-receipt.ts. Not a real receipt: the store name, tax ID (fictional, valid check digit only) and product names are made up; any resemblance to real ones is unintended.",
				font: "Sarabun Regular (SIL Open Font License)",
				width: WIDTH * SCALE,
				height: HEIGHT * SCALE,
				rows: ROWS.map(([left, right]) =>
					right === undefined ? left : `${left} ${right}`,
				),
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(`written: ${png}`);
} finally {
	await rm(work, { recursive: true, force: true });
}
