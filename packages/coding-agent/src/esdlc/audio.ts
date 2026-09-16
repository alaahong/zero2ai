/**
 * Recording → text for the requirements phase.
 *
 * PCM WAV is decoded in-process; every other container goes through `ffmpeg`
 * (16 kHz mono) first. Transcription itself reuses the bundled STT pipeline, so
 * the model, worker lifecycle and warm-reuse behaviour are shared with the rest
 * of the product.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { $which } from "@zero2ai/utils";
import { DEFAULT_STT_MODEL_KEY } from "../stt/models";
import { sttClient } from "../stt/asr-client";

const TARGET_SAMPLE_RATE = 16_000;
const WAV_EXTENSIONS: Readonly<Record<string, true>> = { ".wav": true, ".wave": true };
const TO_TEXT_EXTENSIONS: Readonly<Record<string, true>> = {
	".md": true, ".markdown": true, ".txt": true, ".vtt": true, ".srt": true, ".json": true,
};

export interface TranscriptionResult {
	readonly text: string;
	readonly source: string;
}

export function looksLikeTextTranscript(filePath: string): boolean {
	return TO_TEXT_EXTENSIONS[path.extname(filePath).toLowerCase()] === true;
}

/** Decode a PCM WAV file into mono float samples at 16 kHz. */
export function decodeWav(bytes: Uint8Array): Float32Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const riff = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
	if (riff !== "RIFF") throw new Error("not a RIFF/WAV file");
	let offset = 12;
	let channels = 1;
	let sampleRate = TARGET_SAMPLE_RATE;
	let bitsPerSample = 16;
	let format = 1;
	let dataOffset = -1;
	let dataLength = 0;
	while (offset + 8 <= bytes.length) {
		const id = String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0);
		const size = view.getUint32(offset + 4, true);
		const body = offset + 8;
		if (id === "fmt ") {
			format = view.getUint16(body, true);
			channels = Math.max(1, view.getUint16(body + 2, true));
			sampleRate = view.getUint16(body + 4, true) || TARGET_SAMPLE_RATE;
			bitsPerSample = view.getUint16(body + 14, true) || 16;
		} else if (id === "data") {
			dataOffset = body;
			dataLength = Math.min(size, bytes.length - body);
		}
		offset = body + size + (size % 2);
	}
	if (dataOffset < 0) throw new Error("WAV file has no data chunk");
	if (format !== 1 && format !== 3) throw new Error(`unsupported WAV encoding (format ${format}); use 16-bit PCM or float`);
	const bytesPerSample = Math.max(1, bitsPerSample / 8);
	const frames = Math.floor(dataLength / (bytesPerSample * channels));
	const mono = new Float32Array(frames);
	for (let frame = 0; frame < frames; frame++) {
		let sum = 0;
		for (let channel = 0; channel < channels; channel++) {
			const at = dataOffset + (frame * channels + channel) * bytesPerSample;
			if (format === 3 && bitsPerSample === 32) sum += view.getFloat32(at, true);
			else if (bitsPerSample === 16) sum += view.getInt16(at, true) / 32_768;
			else sum += ((bytes[at] ?? 128) - 128) / 128;
		}
		mono[frame] = sum / channels;
	}
	if (sampleRate === TARGET_SAMPLE_RATE) return mono;
	// Linear resample: adequate for speech and free of extra dependencies.
	const ratio = sampleRate / TARGET_SAMPLE_RATE;
	const outLength = Math.floor(mono.length / ratio);
	const resampled = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const position = i * ratio;
		const left = Math.floor(position);
		const right = Math.min(left + 1, mono.length - 1);
		const weight = position - left;
		resampled[i] = mono[left]! * (1 - weight) + mono[right]! * weight;
	}
	return resampled;
}

async function toSixteenKhzWav(sourcePath: string): Promise<{ wav: Uint8Array; cleanup: () => Promise<void> }> {
	if (WAV_EXTENSIONS[path.extname(sourcePath).toLowerCase()] === true) {
		return { wav: await fs.readFile(sourcePath), cleanup: async () => {} };
	}
	const ffmpeg = $which("ffmpeg");
	if (!ffmpeg) {
		throw new Error(
			`Converting ${path.extname(sourcePath) || "this format"} needs ffmpeg, which was not found on PATH.\n` +
				`Either install ffmpeg, or export a text transcript (any .md/.txt/.vtt/.srt) and pass it with --input.`,
		);
	}
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zero2ai-esdlc-audio-"));
	const target = path.join(dir, "audio.wav");
	const child = Bun.spawn([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", sourcePath, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", target], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(child.stderr as ReadableStream).text(), child.exited]);
	if (exitCode !== 0) {
		await fs.rm(dir, { recursive: true, force: true });
		throw new Error(`ffmpeg failed to convert ${path.basename(sourcePath)}: ${stderr.trim() || `exit ${exitCode}`}`);
	}
	return { wav: await fs.readFile(target), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** Transcribe a recording into plain text. */
export async function transcribeRecording(
	filePath: string,
	options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<TranscriptionResult> {
	const absolute = path.resolve(filePath);
	let stat: Stats;
	try {
		stat = await fs.stat(absolute);
	} catch {
		throw new Error(`input not found: ${absolute}`);
	}
	if (stat.isDirectory()) throw new Error(`input is a directory: ${absolute}`);

	if (looksLikeTextTranscript(absolute)) {
		options.onProgress?.(`Reading transcript ${path.basename(absolute)}`);
		return { text: (await fs.readFile(absolute, "utf-8")).trim(), source: path.basename(absolute) };
	}

	options.onProgress?.(`Decoding ${path.basename(absolute)}`);
	const { wav, cleanup } = await toSixteenKhzWav(absolute);
	try {
		options.onProgress?.("Transcribing (bundled STT model)");
		const samples = decodeWav(wav);
		const text = await sttClient.transcribe(DEFAULT_STT_MODEL_KEY, samples, options.signal ? { signal: options.signal } : {});
		return { text: text.trim(), source: path.basename(absolute) };
	} catch (error) {
		throw new Error(
			`Transcription failed: ${(error as Error).message}\n` +
				`The bundled STT model must be available (see \`zero2ai tiny-models\` / \`zero2ai setup speech\`); ` +
				`alternatively export a text transcript and pass it with --input.`,
		);
	} finally {
		await cleanup();
	}
}
