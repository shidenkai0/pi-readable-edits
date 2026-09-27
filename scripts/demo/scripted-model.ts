/**
 * A scripted model for end-to-end runs: each assistant turn replays the next
 * step from the JSON file named by READABLE_EDITS_SCRIPT. A step is either
 * `{ "text": "..." }` or `{ "bash": ["cmd", ...] }` (several run in parallel), or any tool calls:
 * `{ "tools": [{ "name": "exec_command", "args": { ... } }] }`. READABLE_EDITS_ACTIVATE lists extra
 * tools to activate, such as the Codex tools from an OpenAI-compatibility extension.
 */
import { readFileSync } from "node:fs";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Step = { text: string } | { bash: string[] } | { edit: { path: string; oldText: string; newText: string }; bash?: string[] }
  | { tools: Array<{ name: string; args: Parameters<typeof fauxToolCall>[1] }> };

export default function scriptedModel(pi: ExtensionAPI): void {
  const steps = JSON.parse(readFileSync(process.env.READABLE_EDITS_SCRIPT!, "utf8")) as Step[];
  const core = createFauxCore({ api: "scripted", provider: "scripted", models: [{ id: "demo" }], tokensPerSecond: 4000 });
  let call = 0;
  core.setResponses(steps.map((step) => () => {
    call++;
    if ("text" in step) return fauxAssistantMessage(fauxText(step.text));
    if ("tools" in step) {
      return fauxAssistantMessage(step.tools.map((tool, index) => fauxToolCall(tool.name, tool.args, { id: `${tool.name}-${call}-${index}` })),
        { stopReason: "toolUse" });
    }
    const calls = [
      ...("edit" in step ? [fauxToolCall("edit", step.edit, { id: `edit-${call}` })] : []),
      ...(step.bash ?? []).map((command, index) => fauxToolCall("bash", { command }, { id: `bash-${call}-${index}` })),
    ];
    return fauxAssistantMessage(calls, { stopReason: "toolUse" });
  }));
  const activate = process.env.READABLE_EDITS_ACTIVATE?.split(",").filter(Boolean) ?? [];
  if (activate.length) {
    pi.on("session_start", () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...activate])]));
  }
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
