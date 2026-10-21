export { Testlie, Inboxes, Messages, Webhooks, Idps, IdpUsers, Push, Scenarios, pickLink, VERSION, DEFAULT_BASE_URL } from "./client.js";
export type { TestlieOptions, CreateInboxOptions, WaitOptions, MessageRef, LinkPattern, WebhookInput, IdpPatch, IdpUserInput, PushWaitOptions, ScenarioActivation, ScenarioOptions, SpamReport } from "./client.js";
export { TestlieError, TestlieTimeoutError, TestlieExtractError } from "./errors.js";
export { inboxAddress, cleanTag } from "./address.js";
export type * from "./types.js";
