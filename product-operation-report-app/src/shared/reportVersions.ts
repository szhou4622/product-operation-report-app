export const MODEL_RUNTIME_RULES_VERSION = 'runtime-rules-v1'
export const REPORT_PROMPT_VERSION = 'report-prompt-v0.3.2'
export const REPORT_TEMPLATE_VERSION = 'report-template-v0.3.2'
export const SOURCE_CLEAN_PROMPT_VERSION = 'source-clean-v9-local-structured-evidence'
export const TABLE_DIGEST_VERSION = 'table-digest-v5-all-rows-column-pruning'

// Cleaning batches must stay below this value. Batched extraction bypasses the
// legacy compactor, and the runtime assertion guards future limit changes.
export const SOURCE_TEXT_LIMIT = 70_000
