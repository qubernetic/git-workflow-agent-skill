import * as common from './common.mjs';

// Codex has no usable ask: deny only.
export const preToolUse = (input, deps = {}) => common.preToolUse(input, { ...deps, askSupported: false });
export const sessionStart = common.sessionStart;
