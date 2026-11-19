import * as common from './common.mjs';

const NO_ASK_MODES = ['bypassPermissions', 'dontAsk'];

export const preToolUse = (input, deps = {}) =>
  common.preToolUse(input, { ...deps, askSupported: !NO_ASK_MODES.includes(input?.permission_mode) });
export const sessionStart = common.sessionStart;
