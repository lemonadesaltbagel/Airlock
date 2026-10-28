export { canonicalIdentifier, COMMON_PARTS, identifierParts } from "./common-words.js";
export { CONSULTANT_SYSTEM_PROMPT, createConsultant, type Consultant, type ConsultantAnswer, type ConsultantOptions } from "./consultant.js";
export { FragmentIndex, isStructuralWindow, normalizeForFingerprint, stripImportLines, type FragmentMatch } from "./fragment-index.js";
export { createGate, type Gate } from "./gate.js";
export { emptyJewels, JEWELS_FILE, loadJewels, touchesJewels, type Jewels, type JewelsConfig } from "./jewels.js";
export { createJsonlConsultLog, memoryConsultLog, readConsultLog, type ConsultLog } from "./log.js";
export { renderNaive, renderPacket } from "./render.js";
export { buildRepoIndex, isDistinctiveIdentifier, type RepoIndex } from "./repo-index.js";
export { findSecrets } from "./secrets.js";
export {
  createConsultService,
  wrapAnswer,
  type AbstractionResult,
  type Abstractor,
  type ConfirmFn,
  type ConsultService,
  type ConsultServiceOptions,
  type ConsultToolResult,
} from "./service.js";
export { consultTool, serviceHandler, toReply, type ConsultRunner, type ConsultToolDetails } from "./tool.js";
export { ConsultRequestError, parseConsultRequest, remoteConsultHandler, type ConsultHandler, type ConsultReply } from "./remote.js";
export * from "./types.js";
export { getOrCreateUserId } from "./user-id.js";
