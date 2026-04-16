// ── thin wrapper around an openai-compatible local endpoint ──

import OpenAI from "openai";

const BASE_URL = process.env.AI_BASE_URL ?? "http://localhost:20128/v1";
const MODEL = process.env.AI_MODEL ?? "kr/claude-sonnet-4.5";

// singleton client — reused across the entire pipeline
export const ai = new OpenAI({
  baseURL: BASE_URL,
  apiKey: "not-needed",
});

// send a system + user prompt and return the raw text reply
export async function ask(system: string, user: string): Promise<string> {
  const res = await ai.chat.completions.create({
    model: MODEL,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  return res.choices[0]?.message?.content ?? "";
}

// same as ask() but parses the response as JSON
export async function askJson<T>(system: string, user: string): Promise<T> {
  const text = await ask(
    system + "\n\nRespond with valid JSON only. No markdown, no commentary.",
    user,
  );

  // strip markdown fences if the model wraps its output
  const cleaned = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(cleaned) as T;
}
