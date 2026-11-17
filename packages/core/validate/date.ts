import type { Receipt } from "../schema/receipt.ts";
import { type CheckResult, fail, pass, skip } from "./types.ts";

/** Buddhist era = Gregorian + 543. */
export const BUDDHIST_ERA_OFFSET = 543;
/** Thailand is UTC+7 all year (no daylight saving). */
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
/** Tolerated clock skew between the till and our clock. */
const FUTURE_SLACK_MS = 10 * 60 * 1000;

export type Era = "BE" | "CE";

export type ParsedDateTime =
	| {
			ok: true;
			/** Gregorian ISO 8601 with +07:00, e.g. 2026-11-17T14:05:00+07:00. */
			iso: string;
			epoch_ms: number;
			/** Era the printed year was read as. */
			era: Era;
			/** True when a 2-digit year forced a guess between BE and CE. */
			era_inferred: boolean;
			has_time: boolean;
	  }
	| { ok: false; reason: string };

const DMY =
	/(?<!\d)(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})(?!\d)(?:\D{1,4}(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/;
const YMD =
	/(?<!\d)(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})(?!\d)(?:\D{1,4}(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?/;

const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

export function thaiDigitsToAscii(text: string): string {
	return text.replace(/[๐-๙]/g, (d) => String(THAI_DIGITS.indexOf(d)));
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function bangkokEpoch(
	y: number,
	mo: number,
	d: number,
	h: number,
	mi: number,
	s: number,
): number | null {
	const utc = Date.UTC(y, mo - 1, d, h, mi, s);
	const check = new Date(utc);
	const valid =
		check.getUTCFullYear() === y &&
		check.getUTCMonth() === mo - 1 &&
		check.getUTCDate() === d &&
		h < 24 &&
		mi < 60 &&
		s < 60;
	return valid ? utc - BANGKOK_OFFSET_MS : null;
}

/**
 * Parses a printed receipt date (day/month/year or year-month-day, optional
 * time) and converts Buddhist-era years to Gregorian.
 *
 * - 4-digit year ≥ 2400 is Buddhist era (2569 → 2026).
 * - 2-digit year is ambiguous ("69" = BE 2569 or CE 2069; "26" = CE 2026 or
 *   BE 2526). The reading that is not in the future and is closest to `now`
 *   wins, and `era_inferred` is set.
 *
 * Provisional: Thai month names (e.g. "17 พ.ย. 69") are not handled yet.
 */
export function parseReceiptDateTime(raw: string, now: Date): ParsedDateTime {
	const text = thaiDigitsToAscii(raw);
	let day: number;
	let month: number;
	let yearText: string;
	let time: (string | undefined)[];

	const ymd = YMD.exec(text);
	const dmy = ymd ? null : DMY.exec(text);
	if (ymd) {
		yearText = ymd[1] ?? "";
		month = Number(ymd[2]);
		day = Number(ymd[3]);
		time = [ymd[4], ymd[5], ymd[6]];
	} else if (dmy) {
		day = Number(dmy[1]);
		month = Number(dmy[2]);
		yearText = dmy[3] ?? "";
		time = [dmy[4], dmy[5], dmy[6]];
	} else {
		return { ok: false, reason: `no date found in "${raw}"` };
	}

	const hasTime = time[0] !== undefined;
	const hour = Number(time[0] ?? 0);
	const minute = Number(time[1] ?? 0);
	const second = Number(time[2] ?? 0);
	const printedYear = Number(yearText);

	const candidates: { year: number; era: Era }[] =
		yearText.length === 4
			? printedYear >= 2400
				? [{ year: printedYear - BUDDHIST_ERA_OFFSET, era: "BE" }]
				: [{ year: printedYear, era: "CE" }]
			: [
					{ year: 2000 + printedYear, era: "CE" },
					{ year: 2500 + printedYear - BUDDHIST_ERA_OFFSET, era: "BE" },
				];

	const resolved = candidates
		.map((c) => ({
			...c,
			epoch: bangkokEpoch(c.year, month, day, hour, minute, second),
		}))
		.filter((c): c is typeof c & { epoch: number } => c.epoch !== null);
	if (resolved.length === 0) {
		return { ok: false, reason: `"${raw}" is not a real calendar date/time` };
	}

	const limit = now.getTime() + FUTURE_SLACK_MS;
	const notFuture = resolved.filter((c) => c.epoch <= limit);
	// Latest non-future reading is the one closest to now; if every reading
	// is in the future, keep the earliest so the future check reports it.
	const best =
		notFuture.sort((a, b) => b.epoch - a.epoch)[0] ??
		resolved.sort((a, b) => a.epoch - b.epoch)[0];
	if (!best) return { ok: false, reason: `"${raw}" could not be resolved` };

	return {
		ok: true,
		iso: `${pad(best.year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+07:00`,
		epoch_ms: best.epoch,
		era: best.era,
		era_inferred: yearText.length === 2,
		has_time: hasTime,
	};
}

/** Date parses (with BE conversion) and is not in the future. */
export function checkDate(receipt: Receipt, now: Date): CheckResult[] {
	const path = "datetime_raw";
	if (receipt.datetime_raw === null) {
		return [
			fail("date_parse", "no date was extracted", { path }),
			skip("date_not_future", "no date to compare", { path }),
		];
	}
	const parsed = parseReceiptDateTime(receipt.datetime_raw, now);
	if (!parsed.ok) {
		return [
			fail("date_parse", parsed.reason, { path, actual: receipt.datetime_raw }),
			skip("date_not_future", "date did not parse", { path }),
		];
	}
	const era = `${parsed.era}${parsed.era_inferred ? ", inferred from 2-digit year" : ""}`;
	const parseResult = pass("date_parse", `parsed as ${parsed.iso} (${era})`, {
		path,
		actual: parsed.iso,
	});
	const future = parsed.epoch_ms > now.getTime() + FUTURE_SLACK_MS;
	return [
		parseResult,
		future
			? fail("date_not_future", `${parsed.iso} is in the future`, {
					path,
					actual: parsed.iso,
				})
			: pass("date_not_future", "date is not in the future", { path }),
	];
}

/**
 * Returns a copy with `datetime` filled from `datetime_raw` (null when it
 * does not parse). The LLM never writes `datetime` itself.
 */
export function withResolvedDatetime(receipt: Receipt, now: Date): Receipt {
	const parsed =
		receipt.datetime_raw === null
			? null
			: parseReceiptDateTime(receipt.datetime_raw, now);
	return { ...receipt, datetime: parsed?.ok ? parsed.iso : null };
}
