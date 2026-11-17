import { describe, expect, test } from "bun:test";
import { sampleReceipt } from "../schema/fixtures.ts";
import { checkTaxId, selectTaxIdWindow, thaiIdCheckDigit } from "./format.ts";

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

describe("selectTaxIdWindow", () => {
	/** Invented IDs: twelve arbitrary digits plus their computed check digit. */
	const valid = (first12: string) => `${first12}${thaiIdCheckDigit(first12)}`;
	const VALID = valid("310050012345");
	const isValid = (id: string) =>
		thaiIdCheckDigit(id.slice(0, 12)) === Number(id[12]);

	test("exactly 13 digits are returned as they are", () => {
		expect(selectTaxIdWindow(VALID)).toMatchObject({
			status: "exact",
			tax_id: VALID,
		});
		const broken = `${VALID.slice(0, 12)}${(Number(VALID[12]) + 1) % 10}`;
		expect(selectTaxIdWindow(broken)).toMatchObject({
			status: "exact",
			tax_id: broken,
			valid_windows: [],
		});
	});

	test("a glued-on leading or trailing digit is removed using the check digit", () => {
		// Pick an extra digit that does not happen to make the other window valid.
		const lead = [..."0123456789"].find(
			(d) => !isValid(`${d}${VALID}`.slice(0, 13)),
		);
		const trail = [..."0123456789"].find(
			(d) => !isValid(`${VALID}${d}`.slice(1)),
		);
		expect(selectTaxIdWindow(`${lead}${VALID}`)).toMatchObject({
			status: "selected",
			tax_id: VALID,
			valid_windows: [VALID],
		});
		expect(selectTaxIdWindow(`${VALID}${trail}`)).toMatchObject({
			status: "selected",
			tax_id: VALID,
		});
	});

	test("several valid windows are flagged, not guessed", () => {
		const trail = [..."0123456789"].find((d) =>
			isValid(`${VALID}${d}`.slice(1)),
		);
		if (trail === undefined)
			throw new Error("no colliding digit for this fixture");
		const result = selectTaxIdWindow(`${VALID}${trail}`);
		expect(result.status).toBe("ambiguous");
		expect(result.tax_id).toBeNull();
		expect(result.valid_windows).toHaveLength(2);
	});

	test("no valid window is flagged", () => {
		const broken = `${VALID.slice(0, 12)}${(Number(VALID[12]) + 1) % 10}`;
		const lead = [..."0123456789"].find(
			(d) => !isValid(`${d}${broken}`.slice(0, 13)),
		);
		expect(selectTaxIdWindow(`${lead}${broken}`)).toMatchObject({
			status: "none_valid",
			tax_id: null,
			valid_windows: [],
		});
	});

	test("long digit runs and non-digit input are refused", () => {
		expect(selectTaxIdWindow(`${VALID}123`).status).toBe("too_long");
		expect(selectTaxIdWindow("123456789012").status).toBe("not_found");
		expect(selectTaxIdWindow("31005001234A5").status).toBe("not_found");
	});
});
