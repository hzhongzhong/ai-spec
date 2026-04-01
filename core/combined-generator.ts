/**
 * combined-generator.ts
 *
 * Generates Spec + Tasks in a single AI call instead of two sequential calls.
 * Avoids the circular-dependency that would arise if spec-generator.ts imported
 * from task-generator.ts (which already imports AIProvider from spec-generator).
 */

import { AIProvider } from "./spec-generator";
import { ProjectContext } from "./context-loader";
import { SpecTask, buildTaskPrompt } from "./task-generator";
import { specPrompt } from "../prompts/spec.prompt";

const TASKS_SEPARATOR = "---TASKS_JSON---";

// Appended to specPrompt so the AI outputs spec + tasks in one response.
const tasksInstruction = `

---
After outputting the complete spec above, append EXACTLY this line on its own (no extra text before or after it):
${TASKS_SEPARATOR}
Then output a valid JSON array of implementation tasks. Each element must have these exact fields:
{"id":"TASK-001","title":"...","description":"1-2 sentences, specific","layer":"data|infra|service|api|test","filesToTouch":["src/..."],"acceptanceCriteria":["behavioral condition"],"verificationSteps":["concrete runnable check → expected result"],"dependencies":[],"priority":"high|medium|low"}
verificationSteps rules: each step is a specific command or action with observable expected output (e.g. "POST /api/orders → 201 {id, status:'pending'}"). At least 2 per task, max 5. Never vague.
Layer order: data → infra → service → api → test. 4-10 tasks total. filesToTouch must use real paths from the project context.`;

export async function generateSpecWithTasks(
  provider: AIProvider,
  idea: string,
  context?: ProjectContext,
  architectureDecision?: string
): Promise<{ spec: string; tasks: SpecTask[] }> {
  // Use buildTaskPrompt to get the full verified-inventory context,
  // then prepend the idea so the spec generator also sees it.
  const contextBlock = buildTaskPrompt("", context).trim();

  const parts: string[] = [idea];
  if (architectureDecision) {
    parts.push(
      `\n=== Architecture Decision (MUST follow this approach in the spec) ===\n${architectureDecision}`
    );
  }
  if (contextBlock) parts.push(contextBlock);
  const fullPrompt = parts.join("\n\n");

  const combinedSystemPrompt = specPrompt + tasksInstruction;
  const raw = await provider.generate(fullPrompt, combinedSystemPrompt);
  return parseSpecAndTasks(raw);
}

function parseSpecAndTasks(raw: string): { spec: string; tasks: SpecTask[] } {
  const sepIdx = raw.indexOf(TASKS_SEPARATOR);

  if (sepIdx === -1) {
    // AI didn't output the separator — return full response as spec, no tasks
    return { spec: raw.trim(), tasks: [] };
  }

  const spec = raw.slice(0, sepIdx).trim();
  const tasksRaw = raw.slice(sepIdx + TASKS_SEPARATOR.length).trim();

  let tasks: SpecTask[] = [];
  try {
    const jsonMatch = tasksRaw.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      tasks = JSON.parse(jsonMatch[0]);
    }
  } catch {
    // Parse failed, return empty tasks — caller handles gracefully
  }

  return { spec, tasks };
}
