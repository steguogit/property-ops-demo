import { env, hasLLM } from "./env";
import { recordUsage, estimateTokens } from "./usage";

// Small shared LLM chat helper. Supports the two shapes the demo already uses:
//   - Grove gateway (api-key header)
//   - OpenAI-compatible (Bearer)
// Used by RAG answering AND by the AI-assisted proposal engine. The proposal
// engine is ADVISORY only — its output is always a draft awaiting human review.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function llmChat(
  messages: ChatMessage[],
  opts: { temperature?: number; jsonMode?: boolean } = {}
): Promise<string> {
  if (!hasLLM()) throw new Error("No LLM configured");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (env.llmAuthHeader === "api-key") headers["api-key"] = env.llmApiKey;
  else headers["Authorization"] = `Bearer ${env.llmApiKey}`;

  const body: Record<string, unknown> = {
    model: env.llmModel,
    messages,
    temperature: opts.temperature ?? 0,
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${env.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: { message: { content: string } }[];
    usage?: import("./usage").RawUsage;
  };
  const content = json.choices[0]?.message?.content ?? "";
  void recordUsage({
    operation: "proposal",
    provider: "llm",
    model: env.llmModel,
    kind: "chat",
    usage: json.usage,
    fallbackTotal:
      estimateTokens(JSON.stringify(messages)) + estimateTokens(content),
  });
  return content;
}

/** Best-effort JSON extraction from a possibly-fenced LLM response. */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // try to locate the first {...} or [...] block
    const obj = candidate.match(/[[{][\s\S]*[\]}]/);
    if (obj) {
      try {
        return JSON.parse(obj[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
