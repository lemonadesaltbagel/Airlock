import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Workspace } from "../workspace.js";
import { bashTool } from "./bash.js";
import { editTool, readTool, writeTool } from "./file-tools.js";
import { grepTool } from "./grep.js";

export { bashTool, OutputCapture, truncateMiddle } from "./bash.js";
export { editTool, readTool, writeTool } from "./file-tools.js";
export { globToRegExp, grepTool } from "./grep.js";

export function createCodingTools(ws: Workspace): AgentTool<any>[] {
  return [readTool(ws), writeTool(ws), editTool(ws), grepTool(ws), bashTool(ws)];
}
