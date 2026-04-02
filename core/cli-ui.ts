import chalk from "chalk";

// ─── Spinner ──────────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  /** Update the text shown after the spinner. */
  update(text: string): void;
  /** Stop the spinner and show a final message. */
  stop(finalText?: string): void;
  /** Stop with a success (✔) mark. */
  succeed(text: string): void;
  /** Stop with a failure (✘) mark. */
  fail(text: string): void;
}

/**
 * Start a CLI spinner that renders on a single line.
 * Works in any TTY; silently degrades to static text in non-TTY (CI).
 */
export function startSpinner(text: string): Spinner {
  const isTTY = process.stderr.isTTY;
  let frame = 0;
  let currentText = text;
  let stopped = false;

  function render() {
    if (stopped) return;
    const symbol = chalk.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length]);
    if (isTTY) {
      process.stderr.write(`\r  ${symbol} ${currentText}${" ".repeat(10)}`);
    }
    frame++;
  }

  // Print initial line for non-TTY
  if (!isTTY) {
    process.stderr.write(`  … ${currentText}\n`);
  }

  const timer = setInterval(render, 80);
  render();

  return {
    update(newText: string) {
      currentText = newText;
    },
    stop(finalText?: string) {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (isTTY) {
        process.stderr.write(`\r${" ".repeat(currentText.length + 20)}\r`);
      }
      if (finalText) {
        process.stderr.write(`  ${finalText}\n`);
      }
    },
    succeed(successText: string) {
      this.stop(chalk.green(`✔ ${successText}`));
    },
    fail(failText: string) {
      this.stop(chalk.red(`✘ ${failText}`));
    },
  };
}

// ─── Retry Countdown ──────────────────────────────────────────────────────────

/**
 * Show an animated countdown during retry wait.
 * Displays error details + a live seconds countdown.
 */
export async function retryCountdown(opts: {
  attempt: number;
  maxAttempts: number;
  waitMs: number;
  errorMessage: string;
  label: string;
}): Promise<void> {
  const { attempt, maxAttempts, waitMs, errorMessage, label } = opts;
  const isTTY = process.stderr.isTTY;

  // Error box
  const shortErr = errorMessage.length > 120
    ? errorMessage.slice(0, 117) + "..."
    : errorMessage;

  process.stderr.write("\n");
  process.stderr.write(chalk.yellow(`  ┌─ Retry ${attempt}/${maxAttempts} `) + chalk.gray(`[${label}]`) + chalk.yellow(` ${"─".repeat(Math.max(1, 40 - label.length))}\n`));
  process.stderr.write(chalk.yellow(`  │ `) + chalk.white(shortErr) + "\n");
  process.stderr.write(chalk.yellow(`  │ `) + chalk.gray(`Waiting before retry...`) + "\n");

  // Animated countdown
  const totalSeconds = Math.ceil(waitMs / 1000);
  for (let s = totalSeconds; s > 0; s--) {
    const bar = chalk.green("█".repeat(totalSeconds - s)) + chalk.gray("░".repeat(s));
    const line = chalk.yellow(`  │ `) + `${bar} ${chalk.bold.white(`${s}s`)}`;
    if (isTTY) {
      process.stderr.write(`\r${line}${" ".repeat(10)}`);
    }
    await new Promise<void>((r) => setTimeout(r, 1000));
  }

  if (isTTY) {
    process.stderr.write(`\r${" ".repeat(70)}\r`);
  }
  process.stderr.write(chalk.yellow(`  └─ `) + chalk.cyan(`Retrying now...`) + "\n\n");
}

// ─── Stage Progress ───────────────────────────────────────────────────────────

const STAGE_ICONS: Record<string, string> = {
  context_load: "📂",
  design_dialogue: "💬",
  spec_gen: "📝",
  spec_refine: "✏️ ",
  spec_assess: "📊",
  dsl_extract: "🔗",
  dsl_gap_feedback: "🔍",
  codegen: "⚙️ ",
  test_gen: "🧪",
  error_feedback: "🔧",
  review: "🔎",
  self_eval: "📈",
};

/**
 * Start a pipeline stage with a spinner.
 * Returns a handle to succeed/fail/update the stage display.
 */
export function startStage(stageKey: string, label: string): Spinner {
  const icon = STAGE_ICONS[stageKey] ?? "▸";
  return startSpinner(`${icon}  ${label}`);
}
