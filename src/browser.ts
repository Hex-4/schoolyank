// ── browser-use session management ──

import { BrowserUse } from "browser-use-sdk/v3";

export interface SessionInfo {
  id: string;
  liveUrl: string;
}

/** create a browser-use client (picks up BROWSER_USE_API_KEY from env) */
export function createClient(): BrowserUse {
  return new BrowserUse();
}

/** spin up a new browser session, optionally tied to a linkedin profile */
export async function createSession(
  client: BrowserUse,
  options?: { profileId?: string },
): Promise<SessionInfo> {
  const session = await client.sessions.create({
    ...(options?.profileId && { profileId: options.profileId }),
  });

  return { id: session.id, liveUrl: session.liveUrl ?? "" };
}

/** run a task inside an existing session, optionally streaming messages */
export async function runTask(
  client: BrowserUse,
  sessionId: string,
  prompt: string,
  onMessage?: (msg: string) => void,
): Promise<string> {
  try {
    if (onMessage) {
      const run = client.run(prompt, { sessionId });

      for await (const msg of run) {
        onMessage(`[${msg.role}] ${msg.summary}`);
      }

      return run.result!.output;
    }

    const result = await client.run(prompt, { sessionId });
    return result.output;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`browser task failed: ${message}`);
  }
}

/** stop a session and clean up resources */
export async function stopSession(
  client: BrowserUse,
  sessionId: string,
): Promise<void> {
  await client.sessions.stop(sessionId);
}
