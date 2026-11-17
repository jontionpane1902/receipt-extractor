import type {
	Receipt,
	StructureInput,
	StructureOutput,
	Structurer,
} from "@receipt-extractor/core";

/**
 * Fake structurer: always returns the same canned receipt, whatever the
 * OCR text. Stands in for the LLM so the runner has no network calls, keys
 * or cost.
 */
export class CannedStructurer implements Structurer {
	readonly name: string;
	readonly #receipt: Receipt;

	constructor(receipt: Receipt, name = "canned") {
		this.name = name;
		this.#receipt = receipt;
	}

	async structure(_input: StructureInput): Promise<StructureOutput> {
		return {
			receipt: structuredClone(this.#receipt),
			usage: {
				model: `fake-${this.name}`,
				prompt_version: "none",
				input_tokens: 0,
				output_tokens: 0,
				cost_usd: 0,
				duration_ms: 0,
			},
		};
	}
}
