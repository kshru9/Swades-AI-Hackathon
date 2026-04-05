import { env } from "@my-better-t-app/env/server";

const SYSTEM_PROMPT =
  "Clean up this transcript. Preserve meaning. Add punctuation and proper casing. Remove obvious filler words (um, uh) only if they do not change meaning. Do not summarize. Reply with only the cleaned transcript text, no preamble or quotes.";

export async function cleanTranscriptWithDeepseek(raw: string): Promise<string> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPSEEK_API_KEY is not configured");
  }

  const baseUrl = (env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const model = env.DEEPSEEK_MODEL ?? "deepseek-chat";

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: raw },
      ],
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`DeepSeek request failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Empty response from DeepSeek");
  }

  return content;
}
