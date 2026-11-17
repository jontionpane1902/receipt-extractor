import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "../schema/fixtures.ts";
import { checkTaxId, thaiIdCheckDigit } from "./format.ts";

describe("checkTaxId", () => {
	test("passes format and checksum for a valid 13-digit ID", () => {
		const results = checkTaxId(sampleReceipt());
		expect(results.map((r) => [r.check, r.status])).toEqual([
			["tax_id_format", "pass"],
			["tax_id_checksum", "pass"],
		]);
	});

	test("fails format for wrong length or non-digits", () => {
		for (const tax_id of [
			"901234567890",
			"90123456789021",
			"9-0123-45678-90-2",
		]) {
			const [format, checksum] = checkTaxId(sampleReceipt({ tax_id }));
			expect(format).toMatchObject({ status: "fail", severity: "error" });
			expect(checksum?.status).toBe("skip");
		}
	});

	test("fails when missing", () => {
		expect(checkTaxId(sampleReceipt({ tax_id: null }))[0]?.status).toBe("fail");
	});

	test("flags a misread digit as a checksum warning, not an error", () => {
		const [format, checksum] = checkTaxId(
			sampleReceipt({ tax_id: "9012345678907" }),
		);
		expect(format?.status).toBe("pass");
		expect(checksum).toMatchObject({
			status: "fail",
			severity: "warning",
			expected: 2,
			actual: 7,
		});
	});
});

describe("thaiIdCheckDigit", () => {
	test("computes the mod-11 check digit", () => {
		expect(thaiIdCheckDigit("901234567890")).toBe(2);
	});
});
