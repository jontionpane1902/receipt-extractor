import { type Receipt, toSatang } from "../schema/receipt.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

const baht = (satang: number) => satang / 100;

/** qty × unit price = line amount, one result per item. */
export function checkLineAmounts(receipt: Receipt): CheckResult[] {
	return receipt.items.map((item, index) => {
		const path = `items[${index}].amount`;
		if (item.unit_price === null) {
			return skip("line_amount", "no unit price printed", { path });
		}
		const expected = Math.round(item.qty * item.unit_price * 100);
		const actual = toSatang(item.amount);
		return expected === actual
			? pass("line_amount", "qty × unit price matches line amount", { path })
			: fail(
					"line_amount",
					`${item.qty} × ${item.unit_price} should be ${baht(expected)}, got ${item.amount}`,
					{ path, expected: baht(expected), actual: item.amount },
				);
	});
}

/** sum of line amounts − discounts = total. */
export function checkTotal(receipt: Receipt): CheckResult {
	if (receipt.items.length === 0) {
		return fail("total_sum", "receipt has no items", { path: "items" });
	}
	const lines = receipt.items.reduce((sum, i) => sum + toSatang(i.amount), 0);
	const discounts = receipt.discounts.reduce(
		(sum, d) => sum + toSatang(d.amount),
		0,
	);
	const expected = lines - discounts;
	const actual = toSatang(receipt.total);
	return expected === actual
		? pass("total_sum", "lines − discounts matches total", { path: "total" })
		: fail(
				"total_sum",
				`lines ${baht(lines)} − discounts ${baht(discounts)} should be ${baht(expected)}, got ${receipt.total}`,
				{ path: "total", expected: baht(expected), actual: receipt.total },
			);
}

export const VAT_RATE_PERCENT = 7;

/**
 * VAT = total × 7/107 (prices are VAT-inclusive), within ±1 satang for
 * rounding. Provisional: assumes every item on the receipt is VATable.
 */
export function checkVat(receipt: Receipt): CheckResult {
	if (receipt.vat === null) {
		return skip("vat", "no VAT amount printed", { path: "vat" });
	}
	const expected = Math.round(
		(toSatang(receipt.total) * VAT_RATE_PERCENT) / (100 + VAT_RATE_PERCENT),
	);
	const actual = toSatang(receipt.vat);
	return Math.abs(expected - actual) <= 1
		? pass("vat", "VAT matches total × 7/107", { path: "vat" })
		: fail(
				"vat",
				`VAT should be about ${baht(expected)} (total × 7/107), got ${receipt.vat}`,
				{ path: "vat", expected: baht(expected), actual: receipt.vat },
			);
}

/** amount tendered − total = change. */
export function checkChange(receipt: Receipt): CheckResult {
	const { tendered } = receipt.payment;
	if (tendered === null || receipt.change === null) {
		return skip("change", "tendered amount or change not printed", {
			path: "change",
		});
	}
	const expected = toSatang(tendered) - toSatang(receipt.total);
	const actual = toSatang(receipt.change);
	if (expected < 0) {
		return fail(
			"change",
			`tendered ${tendered} is less than total ${receipt.total}`,
			{ path: "payment.tendered", actual: tendered },
		);
	}
	return expected === actual
		? pass("change", "tendered − total matches change", { path: "change" })
		: fail(
				"change",
				`${tendered} − ${receipt.total} should be ${baht(expected)}, got ${receipt.change}`,
				{ path: "change", expected: baht(expected), actual: receipt.change },
			);
}

/**
 * How the printed item count is defined. Provisional until confirmed on
 * physical receipts: "pieces" = sum of quantities, "lines" = item lines.
 */
export type ItemCountMode = "pieces" | "lines";

/** printed item count = extracted count. */
export function checkItemCount(
	receipt: Receipt,
	mode: ItemCountMode = "pieces",
): CheckResult {
	if (receipt.item_count === null) {
		return skip("item_count", "no item count printed", { path: "item_count" });
	}
	const extracted =
		mode === "lines"
			? receipt.items.length
			: receipt.items.reduce((sum, item) => sum + item.qty, 0);
	return extracted === receipt.item_count
		? pass("item_count", `printed count matches extracted ${mode}`, {
				path: "item_count",
			})
		: fail(
				"item_count",
				`receipt prints ${receipt.item_count} items but ${extracted} ${mode} were extracted`,
				{ path: "item_count", expected: receipt.item_count, actual: extracted },
			);
}
