/**
 * vcr.ts — Pipeline response recording & replay for zero-cost harness iteration.
 *
 * Inspired by Claude Code's VCR pattern for token counting tests.
 *
 * Design:
 *  - VcrRecordingProvider wraps any AIProvider and intercepts every generate()
 *    call, capturing (prompt, systemInstruction, response) in order.
 *  - VcrReplayProvider implements AIProvider by returning pre-recorded responses
 *    in sequence — zero API calls, zero tokens, deterministic output.
 *  - Recordings are stored in .ai-spec-vcr/{runId}.json alongside RunLogs.
 *
 * Use cases:
 *  - Iterating on harness scoring weights without burning tokens
 *  - Testing prompt format changes against known pipelines
 *  - Debugging pipeline stage logic offline
 *
 * CLI:
 *  ai-spec create --vcr-record           → record this run
 *  ai-spec create --vcr-replay <runId>   → replay with zero API calls
 *  ai-spec vcr list                      → list available recordings
 *  ai-spec vcr show <runId>              → inspect call details
 */

import { createHash } from "crypto";
import * as fs from "fs-extra";
import * as path from "path";
import { AIProvider } from "./spec-generator";

import { DEFAULT_VCR_DIR } from "./config-defaults";

export const VCR_DIR = DEFAULT_VCR_DIR;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VcrEntry {
  /** Sequential call index within this recording */
  index: number;
  /** First 200 chars of prompt — for human inspection only */
  promptPreview: string;
  /** SHA-256[:8] of (prompt + "\x00" + systemInstruction) — stable identity */
  callHash: string;
  systemInstruction?: string;
  /** Complete AI response — what replay will return */
  response: string;
  providerName: string;
  modelName: string;
  ts: string;
  durationMs: number;
}

export interface VcrRecording {
  runId: string;
  recordedAt: string;
  /** Total number of AI calls captured */
  entryCount: number;
  /** Unique provider/model strings seen across all calls */
  providers: string[];
  entries: VcrEntry[];
}

// ─── Recording Provider ───────────────────────────────────────────────────────

/**
 * Wraps a real AIProvider, transparently passing through all calls while
 * recording each (prompt, response) pair in order.
 * After the pipeline completes, call `save()` to persist the recording.
 */
export class VcrRecordingProvider implements AIProvider {
  private entries: VcrEntry[] = [];

  constructor(private readonly inner: AIProvider) {}

  get providerName() { return this.inner.providerName; }
  get modelName()    { return this.inner.modelName; }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    const start = Date.now();
    const response = await this.inner.generate(prompt, systemInstruction);
    const callHash = createHash("sha256")
      .update(prompt + "\x00" + (systemInstruction ?? ""))
      .digest("hex")
      .slice(0, 8);
    this.entries.push({
      index: this.entries.length,
      promptPreview: prompt.slice(0, 200).replace(/\n/g, " "),
      callHash,
      ...(systemInstruction ? { systemInstruction } : {}),
      response,
      providerName: this.inner.providerName,
      modelName: this.inner.modelName,
      ts: new Date().toISOString(),
      durationMs: Date.now() - start,
    });
    return response;
  }

  get callCount() { return this.entries.length; }

  /**
   * Persist the recording to .ai-spec-vcr/{runId}.json.
   * Merges entries from an optional second recorder (e.g. codegenProvider),
   * sorted by timestamp so replay order matches real execution order.
   */
  async save(
    workingDir: string,
    runId: string,
    secondRecorder?: VcrRecordingProvider
  ): Promise<string> {
    const allEntries = secondRecorder
      ? [...this.entries, ...secondRecorder.entries].sort((a, b) => a.ts.localeCompare(b.ts))
      : this.entries;

    // Re-index after merge
    allEntries.forEach((e, i) => { e.index = i; });

    const recording: VcrRecording = {
      runId,
      recordedAt: new Date().toISOString(),
      entryCount: allEntries.length,
      providers: [...new Set(allEntries.map((e) => `${e.providerName}/${e.modelName}`))],
      entries: allEntries,
    };

    const vcrDir = path.join(workingDir, VCR_DIR);
    await fs.ensureDir(vcrDir);
    const filePath = path.join(vcrDir, `${runId}.json`);
    await fs.writeJson(filePath, recording, { spaces: 2 });
    return filePath;
  }
}

// ─── Replay Provider ──────────────────────────────────────────────────────────

/**
 * Implements AIProvider by replaying pre-recorded responses in sequence.
 * Every generate() call pops the next entry from the recording — no API call,
 * no tokens, deterministic output.
 *
 * Note: responses are returned in strict index order, regardless of the prompt
 * content. This works correctly as long as the pipeline makes calls in the same
 * structural order as the recording.
 */
export class VcrReplayProvider implements AIProvider {
  private index = 0;
  private _mismatches: Array<{ index: number; expected: string; actual: string }> = [];

  constructor(private readonly recording: VcrRecording) {}

  get providerName() { return "vcr-replay"; }
  get modelName()    { return this.recording.runId; }

  async generate(prompt: string, systemInstruction?: string): Promise<string> {
    const entry = this.recording.entries[this.index++];
    if (!entry) {
      throw new Error(
        `VCR replay exhausted: all ${this.recording.entries.length} recorded ` +
        `responses have been consumed. The pipeline made more AI calls than the recording has.`
      );
    }

    // Validate prompt hash to detect pipeline drift
    const actualHash = createHash("sha256")
      .update(prompt + "\x00" + (systemInstruction ?? ""))
      .digest("hex")
      .slice(0, 8);
    if (actualHash !== entry.callHash) {
      this._mismatches.push({
        index: entry.index,
        expected: entry.callHash,
        actual: actualHash,
      });
    }

    return entry.response;
  }

  get remaining() { return this.recording.entries.length - this.index; }
  get consumed()  { return this.index; }

  /** Returns prompt hash mismatches detected during replay. */
  get mismatches() { return this._mismatches; }
  get hasMismatches() { return this._mismatches.length > 0; }
}

// ─── Loader helpers ───────────────────────────────────────────────────────────

export async function loadVcrRecording(
  workingDir: string,
  runId: string
): Promise<VcrRecording | null> {
  const filePath = path.join(workingDir, VCR_DIR, `${runId}.json`);
  try {
    return await fs.readJson(filePath);
  } catch {
    return null;
  }
}

export interface VcrSummary {
  runId: string;
  recordedAt: string;
  entryCount: number;
  providers: string[];
}

export async function listVcrRecordings(workingDir: string): Promise<VcrSummary[]> {
  const vcrDir = path.join(workingDir, VCR_DIR);
  if (!(await fs.pathExists(vcrDir))) return [];

  const files = (await fs.readdir(vcrDir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const results: VcrSummary[] = [];
  for (const file of files) {
    try {
      const rec: VcrRecording = await fs.readJson(path.join(vcrDir, file));
      results.push({
        runId: rec.runId,
        recordedAt: rec.recordedAt,
        entryCount: rec.entryCount,
        providers: rec.providers,
      });
    } catch {
      // skip corrupt files
    }
  }
  return results;
}
