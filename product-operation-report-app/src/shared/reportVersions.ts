export const MODEL_RUNTIME_RULES_VERSION = 'runtime-rules-v1'
export const REPORT_PROMPT_VERSION = 'report-prompt-v1.0.0'
export const REPORT_TEMPLATE_VERSION = 'report-template-v1.0.0'
export const SOURCE_CLEAN_PROMPT_VERSION = 'source-clean-v10-planned-semantic-receipts'
export const TABLE_DIGEST_VERSION = 'table-digest-v7-local-exact-semantic-routing'

// Cleaning batches must stay below this value. Batched extraction bypasses the
// legacy compactor, and the runtime assertion guards future limit changes.
export const SOURCE_TEXT_LIMIT = 70_000
