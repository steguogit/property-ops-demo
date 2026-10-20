import { getUsageEventsCollection, UsageEventDoc } from "./mongo";

/**
 * The `usage` shape returned by OpenAI-compatible and Voyage APIs. Field names
 * vary slightly across providers, so we accept the common aliases.
 */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
}

/**
 * Record a single model-usage event (best-effort — never throws, so a logging
 * failure can't break a user-facing request). Powers the Dashboard token
 * metrics. Fire-and-forget: callers may `void recordUsage(...)`.
 */
export async function recordUsage(input: {
  operation: string;
  provider: string;
  model: string;
  kind: string;
  usage?: RawUsage | null;
  /** Fallback token count when the API returns no usage object. */
  fallbackTotal?: number;
  datasetId?: string;
}): Promise<void> {
  try {
    const u = input.usage ?? {};
    const prompt = u.prompt_tokens ?? u.input_tokens;
    const completion = u.completion_tokens ?? u.output_tokens;
    const total =
      u.total_tokens ??
      (prompt != null || completion != null
        ? (prompt ?? 0) + (completion ?? 0)
        : input.fallbackTotal ?? 0);

    // Nothing meaningful to record.
    if (!total && prompt == null && completion == null) return;

    const doc: UsageEventDoc = {
      operation: input.operation,
      provider: input.provider,
      model: input.model,
      kind: input.kind,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      datasetId: input.datasetId,
      createdAt: new Date().toISOString(),
    };
    const col = await getUsageEventsCollection();
    await col.insertOne(doc as never);
  } catch {
    /* best-effort telemetry — ignore */
  }
}

/**
 * Rough token estimate (~4 chars/token) for providers/paths that don't return a
 * usage object, so the Dashboard still reflects activity.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
