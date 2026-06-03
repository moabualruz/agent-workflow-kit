import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GeneratedWorkflowKind = "task" | "deep-research";

export type GeneratedWorkflow = {
  name: string;
  path: string;
};

export function saveGeneratedWorkflow(
  projectRoot: string,
  prompt: string,
  kind: GeneratedWorkflowKind = "task",
): GeneratedWorkflow {
  const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
  mkdirSync(workflowsRoot, { recursive: true });

  const source = renderGeneratedWorkflow(prompt, kind);
  const baseName = workflowNameForTask(prompt);
  // Avoid clobbering a different saved workflow that happens to share a slug: if
  // the base name is taken by DIFFERENT content, discriminate with a short hash
  // of (kind, prompt). Identical regenerations reuse the same file.
  const name = collisionSafeName(workflowsRoot, baseName, source, prompt, kind);
  const workflowPath = join(workflowsRoot, `${name}.js`);

  writeFileSync(workflowPath, source);

  return { name, path: workflowPath };
}

export function saveWorkflowSource(
  projectRoot: string,
  name: string | undefined,
  source: string,
): GeneratedWorkflow {
  const workflowsRoot = join(projectRoot, ".agent-workflow-kit", "workflows");
  mkdirSync(workflowsRoot, { recursive: true });

  const baseName = workflowNameForTask(name ?? "workflow");
  const workflowName = collisionSafeName(workflowsRoot, baseName, source, source, "task");
  const workflowPath = join(workflowsRoot, `${workflowName}.js`);
  writeFileSync(workflowPath, source);
  return { name: workflowName, path: workflowPath };
}

function collisionSafeName(
  workflowsRoot: string,
  baseName: string,
  source: string,
  prompt: string,
  kind: GeneratedWorkflowKind,
): string {
  const basePath = join(workflowsRoot, `${baseName}.js`);
  // Free slug, or the existing file is the same content — reuse the base name.
  if (!existsSync(basePath) || safeRead(basePath) === source) return baseName;
  // Slug taken by different content — append a stable discriminator.
  const suffix = createHash("sha256").update(`${kind}\0${prompt}`).digest("hex").slice(0, 8);
  return `${baseName}-${suffix}`;
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

export function workflowNameForTask(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  return slug || "workflow";
}

function renderGeneratedWorkflow(prompt: string, kind: GeneratedWorkflowKind): string {
  if (kind === "deep-research") return renderDeepResearchWorkflow(prompt);
  return renderTaskWorkflow(prompt);
}

function renderTaskWorkflow(task: string): string {
  // A real orchestration: plan → parallel fan-out over subtasks → synthesize.
  // Emitted as a Claude-style body (meta + top-level statements) so it runs in
  // the deterministic vm sandbox. It tolerates the structural default agent
  // (empty plan → empty fan-out → still synthesizes) so it runs deterministically
  // in tests, and produces real work with a live agent.
  return `export const meta = {
  name: ${JSON.stringify(workflowNameForTask(task))},
  description: ${JSON.stringify(`Orchestrate: ${task}`)},
  phases: [
    { title: "Plan" },
    { title: "Work" },
    { title: "Synthesize" }
  ]
};

const task = ${JSON.stringify(task)};
const PLAN_SCHEMA = {
  type: "object",
  required: ["subtasks"],
  properties: { subtasks: { type: "array", items: { type: "string" } } }
};

const goal = (args && args.task) || task;

phase("Plan");
log("planning: " + goal);
const plan = await agent(
  'Break this task into 2-5 independent subtasks. Return JSON {"subtasks": string[]}.\\n\\nTask: ' + goal,
  { schema: PLAN_SCHEMA }
);
const subtasks = (plan && Array.isArray(plan.subtasks) ? plan.subtasks : []).filter(Boolean);

phase("Work");
const findings = await parallel(
  subtasks.map((subtask) => () => agent('Work this subtask of "' + goal + '":\\n' + subtask))
);

phase("Synthesize");
const synthesis = await agent(
  'Synthesize a single consolidated answer for "' + goal + '" from these findings:\\n' + JSON.stringify(findings.filter(Boolean))
);

return { ok: true, task: goal, subtasks, synthesis };
`;
}

function renderDeepResearchWorkflow(question: string): string {
  // Adversarial-verify-until-dry: each round gathers NEW claims per angle (the
  // gather prompt is told which claims are already known so it surfaces fresh
  // ones), a panel refutes and votes, survivors are kept, and the loop continues
  // until DRY_ROUNDS consecutive rounds yield no new claims (or a max-round cap).
  // Emitted as a Claude-style body (vm sandbox). Degrades gracefully under the
  // structural default agent (no claims → dries out immediately).
  return `export const meta = {
  name: ${JSON.stringify(workflowNameForTask(question))},
  description: ${JSON.stringify(`Deep research: ${question}`)},
  phases: [
    { title: "Angles" },
    { title: "Gather" },
    { title: "Refute" },
    { title: "Synthesize" }
  ]
};

const question = ${JSON.stringify(question)};
const ANGLES_SCHEMA = { type: "object", required: ["angles"], properties: { angles: { type: "array", items: { type: "string" } } } };
const CLAIMS_SCHEMA = { type: "object", required: ["claims"], properties: { claims: { type: "array", items: { type: "object", required: ["claim"], properties: { claim: { type: "string" }, source: { type: "string" } } } } } };
const VERDICT_SCHEMA = { type: "object", required: ["refuted"], properties: { refuted: { type: "boolean" }, reason: { type: "string" } } };
const REPORT_SCHEMA = {
  type: "object",
  required: ["answer", "sourceLedger", "claimLedger", "contradictionChecks", "claimConfidenceTable", "rejectedClaims"],
  properties: {
    answer: { type: "string" },
    sourceLedger: { type: "array", items: { type: "object", required: ["source", "claims"], properties: { source: { type: "string" }, claims: { type: "array", items: { type: "string" } } } } },
    claimLedger: { type: "array", items: { type: "object", required: ["claim", "source", "status"], properties: { claim: { type: "string" }, source: { type: "string" }, status: { type: "string" } } } },
    contradictionChecks: { type: "array", items: { type: "object", required: ["claim", "result"], properties: { claim: { type: "string" }, result: { type: "string" } } } },
    claimConfidenceTable: { type: "array", items: { type: "object", required: ["claim", "confidence", "source"], properties: { claim: { type: "string" }, confidence: { type: "string" }, source: { type: "string" } } } },
    rejectedClaims: { type: "array", items: { type: "object", required: ["claim", "reason"], properties: { claim: { type: "string" }, source: { type: "string" }, reason: { type: "string" } } } }
  }
};
const MAX_ROUNDS = 5;
const DRY_ROUNDS = 2;
const REFUTERS = 3;

const topic = (args && args.question) || question;

phase("Angles");
const anglesResult = await agent('List 2-4 distinct research angles for: ' + topic + '. Return JSON {"angles": string[]}.', { schema: ANGLES_SCHEMA });
const angles = (anglesResult && Array.isArray(anglesResult.angles) ? anglesResult.angles : []).filter(Boolean);

const confirmed = [];
const rejected = [];
const seen = new Set();
let round = 0;
let dry = 0;

while (round < MAX_ROUNDS && dry < DRY_ROUNDS) {
  round += 1;
  phase("Gather");
  const knownList = Array.from(seen);
  const knownNote = knownList.length ? ' Do NOT repeat these already-known claims; surface only NEW ones: ' + JSON.stringify(knownList.slice(0, 50)) + '.' : '';
  const gathered = await parallel(
    (angles.length ? angles : [topic]).map((angle) => () =>
      agent('Research "' + topic + '" from this angle: ' + angle + '.' + knownNote + ' Return JSON {"claims":[{"claim","source"}]}', { schema: CLAIMS_SCHEMA }))
  );
  const fresh = gathered
    .filter(Boolean)
    .flatMap((g) => (Array.isArray(g.claims) ? g.claims : []))
    .filter((c) => c && c.claim && !seen.has(c.claim));
  if (!fresh.length) { dry += 1; continue; }
  dry = 0;

  phase("Refute");
  const judged = await parallel(
    fresh.map((c) => () =>
      parallel(
        Array.from({ length: REFUTERS }, (_unused, i) => () =>
          agent('Try to REFUTE this claim about "' + topic + '". Default refuted=true if unsure.\\nClaim: ' + c.claim + '\\nSource: ' + (c.source || "n/a") + ' (reviewer ' + (i + 1) + ')', { schema: VERDICT_SCHEMA }))
      ).then((votes) => {
        seen.add(c.claim);
        const refutingVotes = votes.filter(Boolean).filter((v) => v.refuted);
        const refutes = refutingVotes.length;
        const confidence = refutes === 0 ? "high" : "medium";
        const reason = refutingVotes.find((v) => v.reason)?.reason || "refuted by reviewer panel";
        return { claim: c, survives: refutes < Math.ceil(REFUTERS / 2), confidence, reason };
      }))
  );
  confirmed.push(...judged.filter(Boolean).filter((j) => j.survives).map((j) => ({ ...j.claim, confidence: j.confidence })));
  rejected.push(...judged.filter(Boolean).filter((j) => !j.survives).map((j) => ({ claim: j.claim.claim, source: j.claim.source || "n/a", reason: j.reason })));
}

phase("Synthesize");
const sourceLedger = confirmed.map((c) => ({ source: c.source || "n/a", claims: [c.claim] }));
const claimLedger = confirmed.map((c) => ({ claim: c.claim, source: c.source || "n/a", status: "confirmed" }));
const contradictionChecks = rejected.map((c) => ({ claim: c.claim, result: c.reason || "rejected" }));
const claimConfidenceTable = confirmed.map((c) => ({ claim: c.claim, confidence: c.confidence || "medium", source: c.source || "n/a" }));
const reportDraft = await agent(
  'Write a cited answer to "' + topic + '" using only verified claims. Omit or explicitly mark rejected/unsupported claims. Return JSON {"answer","sourceLedger","claimLedger","contradictionChecks","claimConfidenceTable","rejectedClaims"}.\\nVerified claims:\\n' + JSON.stringify(confirmed) + '\\nRejected claims:\\n' + JSON.stringify(rejected),
  { schema: REPORT_SCHEMA }
);
const report = {
  ...reportDraft,
  sourceLedger: reportDraft && Array.isArray(reportDraft.sourceLedger) && reportDraft.sourceLedger.length ? reportDraft.sourceLedger : sourceLedger,
  claimLedger: reportDraft && Array.isArray(reportDraft.claimLedger) && reportDraft.claimLedger.length ? reportDraft.claimLedger : claimLedger,
  contradictionChecks: reportDraft && Array.isArray(reportDraft.contradictionChecks) && reportDraft.contradictionChecks.length ? reportDraft.contradictionChecks : contradictionChecks,
  claimConfidenceTable: reportDraft && Array.isArray(reportDraft.claimConfidenceTable) && reportDraft.claimConfidenceTable.length ? reportDraft.claimConfidenceTable : claimConfidenceTable,
  rejectedClaims: reportDraft && Array.isArray(reportDraft.rejectedClaims) && reportDraft.rejectedClaims.length ? reportDraft.rejectedClaims : rejected
};

return { ok: true, question: topic, angles, confirmedClaims: confirmed, rejectedClaims: rejected, report, rounds: round };
`;
}
