#!/usr/bin/env node
import { Command } from "commander";
import * as dotenv from "dotenv";

dotenv.config();

import { registerCreate } from "./commands/create";
import { registerReview } from "./commands/review";
import { registerInit } from "./commands/init";
import { registerConfig } from "./commands/config";
import { registerUpdate } from "./commands/update";
import { registerExport } from "./commands/export";
import { registerMock } from "./commands/mock";
import { registerLearn } from "./commands/learn";
import { registerRestore } from "./commands/restore";
import { registerTrend } from "./commands/trend";
import { registerLogs } from "./commands/logs";
import { registerTypes } from "./commands/types";
import { registerDashboard } from "./commands/dashboard";
import { registerVcr } from "./commands/vcr";
import { registerFixHistory } from "./commands/fix-history";

const program = new Command();

program
  .name("ai-spec")
  .description("AI-driven Development Orchestrator — spec, generate, review")
  .version(require("../package.json").version);

registerCreate(program);
registerReview(program);
registerInit(program);
registerConfig(program);
registerUpdate(program);
registerExport(program);
registerMock(program);
registerLearn(program);
registerRestore(program);
registerTrend(program);
registerLogs(program);
registerTypes(program);
registerDashboard(program);
registerVcr(program);
registerFixHistory(program);

program.parse();
