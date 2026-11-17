import type {
	Receipt,
	StructureInput,
	StructureOutput,
	Structurer,
} from "@receipt-extractor/core";

const decoder = new TextDecoder();

/**
 * Fake structurer: replays a canned receipt per fake image id (see
 * `fakeImage`). Stands in for the LLM so the runner has no network calls,
 * keys or cost.
 */
export class ReplayStructurer implements Structurer {
	readonly name: string;
	readonly #byImageId = new Map<string, Receipt>();

	constructor(name = "replay") {
		this.name = name;
	}

	set(imageId: string, receipt: Receipt): void {
		this.#byImageId.set(imageId, receipt);
	}

	async structure(input: StructureInput): Promise<StructureOutput> {
		const id = input.image ? decoder.decode(input.image.bytes) : "";
		const receipt = this.#byImageId.get(id);
		if (!receipt) {
			throw new Error(`${this.name}: no canned extraction for image "${id}"`);
		}
		return {
			receipt: structuredClone(receipt),
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
