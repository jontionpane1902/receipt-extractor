import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "../schema/fixtures.ts";
import {
	checkDate,
	parseReceiptDateTime,
	withResolvedDatetime,
} from "./date.ts";

const NOW = new Date("2026-11-17T15:00:00+07:00");

function parsed(raw: string) {
	const result = parseReceiptDateTime(raw, NOW);
	if (!result.ok) throw new Error(result.reason);
	return result;
}

describe("parseReceiptDateTime", () => {
	test("converts a 4-digit Buddhist-era year", () => {
		const r = parsed("17/11/2569 14:05");
		expect(r.iso).toBe("2026-11-17T14:05:00+07:00");
		expect(r.era).toBe("BE");
		expect(r.era_inferred).toBe(false);
	});

	test("keeps a 4-digit Gregorian year", () => {
		const r = parsed("17/11/2026 14:05:59");
		expect(r.iso).toBe("2026-11-17T14:05:59+07:00");
		expect(r.era).toBe("CE");
	});

	test("reads 2-digit year 69 as BE 2569, since CE 2069 is in the future", () => {
		const r = parsed("17/11/69 14:05");
		expect(r.iso).toBe("2026-11-17T14:05:00+07:00");
		expect(r.era).toBe("BE");
		expect(r.era_inferred).toBe(true);
	});

	test("reads 2-digit year 26 as CE 2026, the reading closest to now", () => {
		const r = parsed("17/11/26 09:00");
		expect(r.iso).toBe("2026-11-17T09:00:00+07:00");
		expect(r.era).toBe("CE");
	});

	test("epoch is anchored to Bangkok time, not the machine's zone", () => {
		expect(parsed("17/11/2569 14:05").epoch_ms).toBe(
			Date.parse("2026-11-17T07:05:00Z"),
		);
	});

	test("handles other separators, year-first order and Thai digits", () => {
		expect(parsed("17-11-2569").iso).toBe("2026-11-17T00:00:00+07:00");
		expect(parsed("17.11.69").has_time).toBe(false);
		expect(parsed("2026-11-17 08:30").iso).toBe("2026-11-17T08:30:00+07:00");
		expect(parsed("๑๗/๑๑/๒๕๖๙ ๑๔:๐๕").iso).toBe("2026-11-17T14:05:00+07:00");
	});

	test("finds the date inside surrounding text", () => {
		expect(parsed("R#0000012345 17/11/69 14:05 POS01").iso).toBe(
			"2026-11-17T14:05:00+07:00",
		);
	});

	test("handles a BE leap day", () => {
		expect(parsed("29/02/2567").iso).toBe("2024-02-29T00:00:00+07:00");
	});

	test("rejects impossible dates and times", () => {
		expect(parseReceiptDateTime("31/02/2569", NOW).ok).toBe(false);
		expect(parseReceiptDateTime("29/02/2569", NOW).ok).toBe(false);
		expect(parseReceiptDateTime("17/13/2569", NOW).ok).toBe(false);
		expect(parseReceiptDateTime("17/11/2569 25:00", NOW).ok).toBe(false);
		expect(parseReceiptDateTime("no date here", NOW).ok).toBe(false);
	});
});

describe("checkDate", () => {
	test("passes for a past date", () => {
		const results = checkDate(sampleReceipt(), NOW);
		expect(results.map((r) => [r.check, r.status])).toEqual([
			["date_parse", "pass"],
			["date_not_future", "pass"],
		]);
		expect(results[0]?.actual).toBe("2026-11-17T14:05:00+07:00");
	});

	test("fails for a date in the future", () => {
		const results = checkDate(
			sampleReceipt({ datetime_raw: "18/11/2569 10:00" }),
			NOW,
		);
		expect(results[1]).toMatchObject({
			check: "date_not_future",
			status: "fail",
		});
	});

	test("allows a few minutes of clock skew", () => {
		const results = checkDate(
			sampleReceipt({ datetime_raw: "17/11/2569 15:05" }),
			NOW,
		);
		expect(results[1]?.status).toBe("pass");
	});

	test("fails when the date is missing or unparseable", () => {
		expect(
			checkDate(sampleReceipt({ datetime_raw: null }), NOW)[0],
		).toMatchObject({ check: "date_parse", status: "fail" });
		const results = checkDate(sampleReceipt({ datetime_raw: "??/??/??" }), NOW);
		expect(results.map((r) => r.status)).toEqual(["fail", "skip"]);
	});
});

describe("withResolvedDatetime", () => {
	test("fills datetime from datetime_raw without touching the raw text", () => {
		const receipt = withResolvedDatetime(
			sampleReceipt({ datetime_raw: "01/01/2569 00:30", datetime: null }),
			NOW,
		);
		expect(receipt.datetime).toBe("2026-01-01T00:30:00+07:00");
		expect(receipt.datetime_raw).toBe("01/01/2569 00:30");
	});

	test("sets null when the raw date does not parse", () => {
		const receipt = withResolvedDatetime(
			sampleReceipt({ datetime_raw: "garbled" }),
			NOW,
		);
		expect(receipt.datetime).toBeNull();
	});
});
