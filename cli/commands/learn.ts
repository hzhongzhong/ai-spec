import { Command } from "commander";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { appendDirectLesson } from "../../core/knowledge-memory";

export function registerLearn(program: Command): void {
  program
    .command("learn")
    .description("Append a lesson or engineering decision directly to constitution §9")
    .argument("[lesson]", "The lesson or decision to record (prompted if omitted)")
    .action(async (lesson: string | undefined) => {
      const currentDir = process.cwd();

      if (!lesson) {
        lesson = await input({
          message: "What lesson or engineering decision should be recorded?",
          validate: (v) => v.trim().length > 0 || "Please enter a lesson",
        });
      }

      const result = await appendDirectLesson(currentDir, lesson.trim());

      if (result.appended) {
        console.log(chalk.green(`\n  ✔ Lesson appended to constitution §9`));
        console.log(chalk.gray(`  File: .ai-spec-constitution.md`));
      } else {
        console.log(chalk.yellow(`\n  ⚠ Not appended: ${result.reason}`));
      }
    });
}
