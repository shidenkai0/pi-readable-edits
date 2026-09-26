/**
 * A scripted model for end-to-end runs: each assistant turn replays the next
 * step from the JSON file named by READABLE_EDITS_SCRIPT. A step is either
 * `{ "text": "..." }` or `{ "bash": ["cmd", ...] }` (several run in parallel).
 */
import { readFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { text: string } | { bash: string[] } | { edit: { path: string; oldText: string; newText: string }; bash?: string[] };

export default function scriptedModel(pi: ExtensionAPI): void {
  const steps = JSON.parse(readFileSync(process.env.READABLE_EDITS_SCRIPT!, "utf8")) as Step[];
  const core = createFauxCore({ api: "scripted", provider: "scripted", models: [{ id: "demo" }], tokensPerSecond: 4000 });
  let call = 0;
  core.setResponses(steps.map((step) => () => {
    call++;
    if ("text" in step) return fauxAssistantMessage(fauxText(step.text));
    const calls = [
      ...("edit" in step ? [fauxToolCall("edit", step.edit, { id: `edit-${call}` })] : []),
      ...(step.bash ?? []).map((command, index) => fauxToolCall("bash", { command }, { id: `bash-${call}-${index}` })),
    ];
    return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  }));
  pi.registerProvider("scripted", {
    baseUrl: "http://localhost",
    apiKey: "scripted",
    api: "scripted",
    streamSimple: core.streamSimple,
    models: [{
      id: "demo", name: "Scripted demo", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 8192,
    }],
  });
}
