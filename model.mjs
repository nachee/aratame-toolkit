import { z } from "zod";

export const modelSchema = z
  .object({
    provider: z.enum(["openai", "openrouter", "anthropic"]),
    model: z.string().trim().min(1).max(200),
    apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  })
  .strict();
const argumentsSchema = z.record(z.string(), z.unknown());
const callSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().regex(/^[\w-]{1,64}$/),
  arguments: argumentsSchema,
});

// Same normalized tool-call contract as the Cloud runner, with no Cloud dependency.
export function createModelClient(input) {
  const profile = modelSchema.parse(input);
  const key = process.env[profile.apiKeyEnv];
  if (!key?.trim())
    throw new Error(
      `Set ${profile.apiKeyEnv} to your ${profile.provider} API key before using AI.`,
    );
  const redact = (text) =>
    String(text)
      .replaceAll(key, "[REDACTED]")
      .replaceAll(JSON.stringify(key).slice(1, -1), "[REDACTED]");
  const invoke = async (messages, tools, signal) => {
    const serialized = JSON.stringify({ messages, tools });
    if (Buffer.byteLength(serialized) > 500_000)
      throw new Error(
        "Model context exceeds 500 KB; reduce the requirements or browser context.",
      );
    ({ messages, tools } = JSON.parse(redact(serialized)));
    let endpoint, headers, body;
    if (profile.provider === "anthropic") {
      const conversation = [];
      for (const message of messages) {
        if (message.role === "system") continue;
        const content = [];
        if (message.role === "tool") {
          if (!message.tool_call_id)
            throw new Error("Tool result is missing its originating call ID.");
          content.push({
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: message.content,
          });
        } else {
          if (message.content)
            content.push({ type: "text", text: message.content });
          for (const call of message.tool_calls || [])
            content.push({
              type: "tool_use",
              id: call.id,
              name: call.function.name,
              input: argumentsSchema.parse(JSON.parse(call.function.arguments)),
            });
        }
        if (!content.length) continue;
        const role = message.role === "assistant" ? "assistant" : "user";
        if (conversation.at(-1)?.role === role)
          conversation.at(-1).content.push(...content);
        else conversation.push({ role, content });
      }
      endpoint = "https://api.anthropic.com/v1/messages";
      headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = {
        model: profile.model,
        max_tokens: 8192,
        system: messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n\n"),
        messages: conversation,
        ...(tools?.length
          ? {
              tools: tools.map(({ function: tool }) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
            }
          : {}),
      };
    } else {
      endpoint =
        profile.provider === "openrouter"
          ? "https://openrouter.ai/api/v1/chat/completions"
          : "https://api.openai.com/v1/chat/completions";
      headers = { Authorization: `Bearer ${key}` };
      body = {
        model: profile.model,
        messages,
        ...(tools?.length ? { tools } : {}),
        ...(profile.provider === "openrouter"
          ? { max_tokens: 8192 }
          : { max_completion_tokens: 8192 }),
      };
    }
    const deadline = AbortSignal.timeout(90_000);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    let response, raw;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const reason =
          response.status === 401 || response.status === 403
            ? "check API credentials and model access"
            : response.status === 429
              ? "check provider rate limits and account credits"
              : "check provider availability and model configuration";
        throw new Error(
          `${profile.provider} returned HTTP ${response.status}; ${reason}.`,
        );
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 4_000_000)
          throw new Error("Provider response exceeds 4 MB.");
        chunks.push(chunk);
      }
      raw = JSON.parse(redact(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (signal?.aborted) throw new Error("Model request cancelled.");
      if (deadline.aborted)
        throw new Error("Model request timed out after 90 seconds.");
      if (error instanceof SyntaxError)
        throw new Error("Provider returned invalid JSON.");
      throw new Error(redact(error.message));
    }
    let result;
    if (profile.provider === "anthropic") {
      if (raw.stop_reason === "max_tokens")
        throw new Error(
          "Model output was truncated; reduce the request scope.",
        );
      if (raw.stop_reason === "refusal")
        throw new Error("Model declined the request.");
      if (
        !["end_turn", "tool_use", "stop_sequence"].includes(raw.stop_reason) ||
        !Array.isArray(raw.content)
      )
        throw new Error(
          "Anthropic returned an unsupported response; use a model supporting text and tool use.",
        );
      result = { text: "", toolCalls: [] };
      for (const block of raw.content) {
        if (block.type === "text" && typeof block.text === "string")
          result.text += block.text;
        else if (block.type === "tool_use")
          result.toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input,
          });
        else
          throw new Error("Anthropic returned an unsupported content block.");
      }
    } else {
      const choice = raw.choices?.[0];
      if (!choice?.message || choice.error || raw.error)
        throw new Error(
          "Provider returned no valid completion; check model availability and account credits.",
        );
      if (choice.finish_reason === "length")
        throw new Error(
          "Model output was truncated; reduce the request scope.",
        );
      if (choice.finish_reason === "content_filter" || choice.message.refusal)
        throw new Error("Model declined the request.");
      if (!["stop", "tool_calls"].includes(choice.finish_reason))
        throw new Error(
          "Provider returned an incomplete or unsupported completion.",
        );
      if (
        choice.message.content != null &&
        typeof choice.message.content !== "string"
      )
        throw new Error("Provider returned invalid text content.");
      if (
        choice.message.tool_calls != null &&
        !Array.isArray(choice.message.tool_calls)
      )
        throw new Error("Provider returned invalid tool calls.");
      result = { text: choice.message.content || "", toolCalls: [] };
      for (const call of choice.message.tool_calls || []) {
        try {
          if (call.type !== "function") throw new Error();
          result.toolCalls.push({
            id: call.id,
            name: call.function.name,
            arguments: JSON.parse(call.function.arguments),
          });
        } catch {
          throw new Error("Provider returned malformed tool arguments.");
        }
      }
    }
    const validated = z.array(callSchema).max(20).safeParse(result.toolCalls);
    if (
      !validated.success ||
      new Set(result.toolCalls.map((call) => call.id)).size !==
        result.toolCalls.length
    )
      throw new Error("Provider returned invalid or duplicate tool calls.");
    if (!result.text && !result.toolCalls.length)
      throw new Error("Provider returned an empty completion.");
    return result;
  };
  return { invoke, redact };
}
