import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  SessionManager,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { structuredPatch } from "diff";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { renderMusouPromptInstructions } from "./prompt";

type ProposalTarget =
  | "global-agents"
  | "project-agents"
  | `global-skill:${string}`
  | `project-skill:${string}`;

type ReviewAction = "accept" | "discard" | "quit";

type MusouRunSource = "auto" | "manual";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type MusouMessage = { role?: string; content?: unknown };

interface Proposal {
  target: ProposalTarget;
  reason: string;
  proposed_content: string;
  originalPath: string;
  originalContent: string;
}

interface ActiveMusouRun {
  tempDir: string;
  startedAt: number;
  source: MusouRunSource;
}

interface MusouState {
  entryCount: number;
  lastMusouAt: number | null;
  pendingProposals: Proposal[] | null;
  lastError: string | null;
  lastSessionFingerprint: string | null;
  activeRun: ActiveMusouRun | null;
}

interface MusouConfig {
  musouEvery: number;
  maxFileLengthChars: number;
  timeoutMs: number;
  thinkingLevel: ThinkingLevel;
}

interface MusouTargetFile {
  target: ProposalTarget;
  path: string;
  label: string;
  content: string;
  cap: number;
}

interface ParsedProposal {
  target: string;
  reason: string;
  proposed_content: string;
}

interface MusouRunFiles {
  tempDir: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  markerPath: string;
  targetsPath: string;
  configPath: string;
}

interface MusouRunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

const MUSOU_STATE_TYPE = "musou-state";
const MUSOU_NO_RECURSE_ENV = "MUSOU_NO_RECURSE";
const REVIEW_VIEWPORT_LINES = 28;
const REVIEW_DIFF_CONTEXT_LINES = 3;
const RUNNER_POLL_MS = 2000;
const PROGRESS_WIDGET_DELAY_MS = 5000;

const DEFAULT_STATE: MusouState = {
  entryCount: 0,
  lastMusouAt: null,
  pendingProposals: null,
  lastError: null,
  lastSessionFingerprint: null,
  activeRun: null,
};

const DEFAULT_CONFIG: MusouConfig = {
  musouEvery: 50,
  maxFileLengthChars: 4000,
  timeoutMs: 120_000,
  thinkingLevel: "medium",
};

export default function musouExtension(pi: ExtensionAPI): void {
  let state: MusouState = { ...DEFAULT_STATE };
  let config: MusouConfig = { ...DEFAULT_CONFIG };
  let targets: MusouTargetFile[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRunStartedAt: number | null = null;

  function persistState(): void {
    pi.appendEntry(MUSOU_STATE_TYPE, state);
  }

  async function refreshConfig(ctx: ExtensionContext): Promise<void> {
    config = await loadConfig(ctx);
  }

  async function refreshTargets(ctx: ExtensionContext): Promise<void> {
    await refreshConfig(ctx);
    targets = await discoverTargetFiles(ctx, config);
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);
  }

  function clearProgressWidget(ctx: ExtensionContext): void {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    ctx.ui.setWidget("musou", undefined);
  }

  function armProgressWidget(ctx: ExtensionContext): void {
    clearProgressWidget(ctx);
    progressTimer = setTimeout(() => {
      const lines = [
        "💭 Musou analyzing session in the background...",
        `Source: ${state.activeRun?.source ?? "manual"}`,
        `Target files: ${targets.length}`,
      ];
      ctx.ui.setWidget("musou", lines, { placement: "aboveEditor" });
    }, PROGRESS_WIDGET_DELAY_MS);
  }

  function incrementCount(): void {
    state.entryCount += 1;
  }

  function updatePendingStatus(ctx: ExtensionContext): void {
    const count = state.pendingProposals?.length ?? 0;
    ctx.ui.setStatus("musou-pending", count > 0 ? `💭 ${count} proposals pending (/musou-review)` : undefined);
  }

  function updateMusouStatus(ctx: ExtensionContext): void {
    if (state.activeRun) {
      const elapsedMs = Date.now() - (currentRunStartedAt ?? state.activeRun.startedAt);
      ctx.ui.setStatus("musou", `💭 Musou running ${formatDuration(elapsedMs)}`);
      return;
    }

    const base = `💭 Musou ${state.entryCount}/${config.musouEvery}`;
    const suffix = state.lastMusouAt ? ` · last ${formatAge(state.lastMusouAt)} ago` : " · never run";
    ctx.ui.setStatus("musou", `${base}${suffix}`);
  }

  async function maybeRunAutoMusou(ctx: ExtensionContext): Promise<void> {
    if (state.entryCount < config.musouEvery) {
      updateMusouStatus(ctx);
      return;
    }
    await runMusou(ctx, "auto", false);
  }

  async function runMusou(ctx: ExtensionContext, source: MusouRunSource, force: boolean): Promise<void> {
    await refreshConfig(ctx);

    if (process.env[MUSOU_NO_RECURSE_ENV]) {
      if (source === "manual") ctx.ui.notify("💭 Musou is disabled inside Musou subprocesses.", "info");
      return;
    }
    if (state.activeRun) {
      if (source === "manual") ctx.ui.notify("💭 Musou already in progress.", "info");
      return;
    }
    if ((state.pendingProposals?.length ?? 0) > 0) {
      if (source === "manual") ctx.ui.notify("💭 Review pending proposals first with /musou-review.", "info");
      return;
    }

    await refreshTargets(ctx);
    if (targets.length === 0) {
      ctx.ui.notify("💭 No existing AGENTS.md or skill files found to improve.", "info");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) {
      ctx.ui.notify("💭 Musou needs a persisted session file. Restart without --no-session.", "error");
      return;
    }

    const fingerprint = await getSessionFingerprint(sessionFile);
    if (!fingerprint) {
      ctx.ui.notify("💭 Musou could not inspect the current session file.", "error");
      return;
    }

    if (!force && source === "auto" && state.lastSessionFingerprint === fingerprint) {
      state.entryCount = 0;
      state.lastError = null;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou skipped — session has not changed since the last analysis.", "info");
      return;
    }

    try {
      const run = await spawnMusouRun(ctx, sessionFile, fingerprint, targets, config);
      state.activeRun = { tempDir: run.tempDir, startedAt: Date.now(), source };
      state.lastError = null;
      if (source === "auto") state.entryCount = 0;
      persistState();
      currentRunStartedAt = state.activeRun.startedAt;
      armProgressWidget(ctx);
      updateMusouStatus(ctx);
      startPollingRun(ctx);
      if (source === "manual") ctx.ui.notify("💭 Musou started in the background.", "info");
    } catch (error) {
      state.lastError = `Failed to start Musou: ${String(error)}`;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou failed to start. Check /musou-status for details.", "error");
    }
  }

  function startPollingRun(ctx: ExtensionContext): void {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      if (!state.activeRun) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        clearProgressWidget(ctx);
        updateMusouStatus(ctx);
        return;
      }

      currentRunStartedAt = state.activeRun.startedAt;
      updateMusouStatus(ctx);

      const files = getRunFiles(state.activeRun.tempDir);
      try {
        await access(files.markerPath);
      } catch {
        return;
      }

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      await completeRun(ctx, state.activeRun, files);
    }, RUNNER_POLL_MS);
  }

  async function completeRun(ctx: ExtensionContext, activeRun: ActiveMusouRun, files: MusouRunFiles): Promise<void> {
    clearProgressWidget(ctx);

    try {
      const [rawResult, rawStdout, rawStderr, rawTargets, rawConfig] = await Promise.all([
        readTextIfExists(files.resultPath),
        readTextIfExists(files.stdoutPath),
        readTextIfExists(files.stderrPath),
        readTextIfExists(files.targetsPath),
        readTextIfExists(files.configPath),
      ]);

      const result = parseRunResult(rawResult);
      const runTargets = parseRunTargets(rawTargets);
      const runConfig = parseRunConfig(rawConfig);
      if (!runTargets || !runConfig) {
        throw new Error("Musou run metadata was missing or invalid.");
      }

      state.activeRun = null;
      currentRunStartedAt = null;

      if (result.timedOut) {
        state.lastError = `Musou subprocess timed out after ${runConfig.timeoutMs}ms.`;
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — subprocess timeout. Check /musou-status for details.", "error");
        return;
      }

      if (result.code !== 0) {
        state.lastError = truncate(rawStderr || rawStdout || `Exit code ${result.code}`, 600);
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — subprocess error. Check /musou-status for details.", "error");
        return;
      }

      const raw = (rawStdout ?? "").trim();
      const parsed = parseProposalArray(raw);
      if (parsed.ok === false) {
        state.lastError = parsed.error;
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — invalid JSON. Check /musou-status for details.", "error");
        return;
      }

      const proposals = parsed.proposals
        .map((proposal): Proposal | null => normalizeProposal(proposal, runTargets, runConfig, ctx.cwd))
        .filter((proposal): proposal is Proposal => proposal !== null);

      state.lastError = null;
      state.lastMusouAt = Date.now();
      state.lastSessionFingerprint = await readRunFingerprint(activeRun.tempDir);

      if (proposals.length === 0) {
        state.pendingProposals = null;
        persistState();
        updatePendingStatus(ctx);
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou complete — nothing to learn from this session.", "info");
        return;
      }

      state.pendingProposals = proposals;
      persistState();
      updatePendingStatus(ctx);
      updateMusouStatus(ctx);
      ctx.ui.notify(
        `💭 Musou complete — ${proposals.length} improvement${proposals.length === 1 ? "" : "s"} proposed. Run /musou-review to inspect.`,
        "info",
      );
    } catch (error) {
      state.activeRun = null;
      currentRunStartedAt = null;
      state.lastError = `Failed to finish Musou run: ${String(error)}`;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou failed while collecting results. Check /musou-status for details.", "error");
    } finally {
      try {
        await rm(activeRun.tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }

  async function openReview(ctx: ExtensionCommandContext): Promise<void> {
    const proposals = state.pendingProposals ?? [];
    if (proposals.length === 0) {
      ctx.ui.notify("💭 No pending musou proposals.", "info");
      updatePendingStatus(ctx);
      updateMusouStatus(ctx);
      return;
    }

    const result = await reviewPendingProposals(pi, ctx, proposals);
    state.pendingProposals = result.remaining.length > 0 ? result.remaining : null;
    persistState();
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);

    if (result.quit) {
      ctx.ui.notify(
        `Review paused — ${result.accepted} accepted, ${result.discarded} discarded, ${result.remaining.length} still pending.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(`Review complete — ${result.accepted} accepted, ${result.discarded} discarded.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    state = { ...restoreMusouState(ctx), entryCount: 0 };
    await refreshTargets(ctx);
    if (process.env[MUSOU_NO_RECURSE_ENV]) {
      ctx.ui.setStatus("musou", "💭 Musou subprocess");
      return;
    }
    if (state.activeRun) {
      currentRunStartedAt = state.activeRun.startedAt;
      armProgressWidget(ctx);
      startPollingRun(ctx);
    }
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);
  });

  pi.on("resources_discover", async (_event, ctx) => {
    if (process.env[MUSOU_NO_RECURSE_ENV]) return;
    await refreshTargets(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = (event as { message?: MusouMessage }).message;
    if (!message) return;
    if (message.role === "user" || message.role === "assistant") {
      incrementCount();
      persistState();
      updateMusouStatus(ctx);
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    incrementCount();
    persistState();
    updateMusouStatus(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    incrementCount();
    persistState();
    updateMusouStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (process.env[MUSOU_NO_RECURSE_ENV]) return;
    await maybeRunAutoMusou(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    clearProgressWidget(ctx);
    ctx.ui.setStatus("musou", undefined);
    ctx.ui.setStatus("musou-pending", undefined);
  });

  pi.registerCommand("musou", {
    description: "Run musou analysis now",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await runMusou(ctx, "manual", true);
    },
  });

  pi.registerCommand("musou-review", {
    description: "Review pending musou proposals",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await openReview(ctx);
    },
  });

  pi.registerCommand("musou-status", {
    description: "Show musou state",
    handler: async (_args, ctx) => {
      await refreshConfig(ctx);
      const lines = [
        "Musou status",
        `  Entry count: ${state.entryCount} / ${config.musouEvery}`,
        `  Thinking level: ${config.thinkingLevel}`,
        `  Last musou: ${state.lastMusouAt ? new Date(state.lastMusouAt).toLocaleString() : "never"}`,
        `  Pending: ${state.pendingProposals?.length ?? 0}`,
        `  Target files: ${targets.length}`,
        `  Last session fingerprint: ${state.lastSessionFingerprint ?? "none"}`,
        `  Active run: ${state.activeRun ? `${state.activeRun.source} (${state.activeRun.tempDir})` : "none"}`,
        ...targets.map((target) => `    ${target.path} (${target.content.length} / ${target.cap} chars)`),
      ];
      if (state.lastError) lines.push(`  Last error: ${state.lastError}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function restoreMusouState(ctx: ExtensionContext): MusouState {
  const branch = ctx.sessionManager.getBranch();
  const last = [...branch]
    .reverse()
    .find((entry: any) => entry.type === "custom" && entry.customType === MUSOU_STATE_TYPE) as
    | { data?: Partial<MusouState> }
    | undefined;

  return {
    ...DEFAULT_STATE,
    ...(last?.data ?? {}),
  };
}

async function loadConfig(ctx: ExtensionContext): Promise<MusouConfig> {
  const globalConfig = await readJsonIfExists(resolve(getAgentDir(), "musou.json"));
  const projectConfig = await readJsonIfExists(resolve(ctx.cwd, ".pi/musou.json"));
  const merged = {
    ...DEFAULT_CONFIG,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {}),
  } as Record<string, unknown>;

  return {
    musouEvery: normalizePositiveInt(merged.musouEvery, DEFAULT_CONFIG.musouEvery),
    maxFileLengthChars: normalizePositiveInt(merged.maxFileLengthChars, DEFAULT_CONFIG.maxFileLengthChars),
    timeoutMs: normalizePositiveInt(merged.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    thinkingLevel: normalizeThinkingLevel(merged.thinkingLevel, DEFAULT_CONFIG.thinkingLevel),
  };
}

async function discoverTargetFiles(ctx: ExtensionContext, config: MusouConfig): Promise<MusouTargetFile[]> {
  const targets: MusouTargetFile[] = [];
  const agentDir = getAgentDir();

  await maybeAddTarget(targets, resolve(agentDir, "AGENTS.md"), "global-agents", "Global AGENTS.md", config);
  await maybeAddTarget(targets, resolve(ctx.cwd, "AGENTS.md"), "project-agents", "Project AGENTS.md", config);
  await addSkillTargets(targets, resolve(agentDir, "skills"), "global", config);
  await addSkillTargets(targets, resolve(ctx.cwd, ".pi/skills"), "project", config);

  return targets;
}

async function maybeAddTarget(
  targets: MusouTargetFile[],
  path: string,
  target: ProposalTarget,
  label: string,
  config: MusouConfig,
): Promise<void> {
  try {
    await access(path);
    const content = await readFile(path, "utf8");
    const cap = await readMusouCap(path, config.maxFileLengthChars, content);
    targets.push({ target, path, label, content, cap });
  } catch {
    // ignore missing files
  }
}

async function addSkillTargets(
  targets: MusouTargetFile[],
  root: string,
  scope: "global" | "project",
  config: MusouConfig,
): Promise<void> {
  try {
    await access(root);
  } catch {
    return;
  }

  for (const relativePath of await walkSkillFiles(root, root)) {
    const path = resolve(root, relativePath);
    const content = await readFile(path, "utf8");
    const cap = await readMusouCap(path, config.maxFileLengthChars, content);
    const fileName = relativePath.replace(/\\/g, "/");
    targets.push({
      target: `${scope}-skill:${fileName}` as ProposalTarget,
      path,
      label: `${scope === "global" ? "Global" : "Project"} skill: ${fileName}`,
      content,
      cap,
    });
  }
}

async function walkSkillFiles(root: string, current: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const skillFile = join(fullPath, "SKILL.md");
      try {
        await access(skillFile);
        results.push(skillFile.slice(root.length + 1));
        continue;
      } catch {
        results.push(...(await walkSkillFiles(root, fullPath)));
      }
      continue;
    }

    if (current === root && entry.isFile() && entry.name.endsWith(".md")) {
      results.push(entry.name);
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

function buildMusouPrompt(targets: MusouTargetFile[], cwd: string): string {
  const sections: string[] = [
    "You are analyzing the current pi session already loaded in this subprocess to identify improvements to persistent instruction files.",
    "Use the session history available in context to detect repeated mistakes, requests, workflows, or preferences worth capturing.",
    "Your output must be a JSON array of proposals and nothing else — no preamble, no explanation, no markdown fences.",
    "\n## Current file contents\n",
  ];

  const globalSkillRoot = resolve(getAgentDir(), "skills");
  const projectSkillRoot = resolve(cwd, ".pi/skills");

  for (const target of targets) {
    sections.push(
      `=== ${target.label.toUpperCase()} ===\nPath: ${target.path}\nCurrent length: ${target.content.length} / ${target.cap} characters (cap)\n---\n${target.content}\n---\n`,
    );
  }

  sections.push(renderMusouPromptInstructions(globalSkillRoot, projectSkillRoot));
  return sections.join("\n");
}

async function spawnMusouRun(
  ctx: ExtensionContext,
  sessionFile: string,
  fingerprint: string,
  targets: MusouTargetFile[],
  config: MusouConfig,
): Promise<MusouRunFiles> {
  const tempDir = await mkdtemp(join(tmpdir(), "musou-run-"));
  const files = getRunFiles(tempDir);
  const promptPath = join(tempDir, "prompt.txt");
  const requestPath = join(tempDir, "request.json");
  const runnerPath = join(tempDir, "runner.cjs");
  const fingerprintPath = join(tempDir, "fingerprint.txt");

  try {
    const forkedManager = SessionManager.forkFrom(sessionFile, ctx.cwd, tempDir);
    const forkedFile = forkedManager.getSessionFile();
    if (!forkedFile) throw new Error("Forked session file was not created.");

    await writeFile(promptPath, buildMusouPrompt(targets, ctx.cwd), "utf8");
    await writeFile(files.targetsPath, JSON.stringify(targets), "utf8");
    await writeFile(files.configPath, JSON.stringify(config), "utf8");
    await writeFile(fingerprintPath, fingerprint, "utf8");

    const request = {
      command: "pi",
      args: [
        "--session",
        forkedFile,
        "--print",
        "--no-context-files",
        "--no-skills",
        "--thinking",
        config.thinkingLevel,
        `@${promptPath}`,
      ],
      cwd: ctx.cwd,
      timeoutMs: config.timeoutMs,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      resultPath: files.resultPath,
      markerPath: files.markerPath,
      env: { ...process.env, [MUSOU_NO_RECURSE_ENV]: "1" },
    };

    await writeFile(requestPath, JSON.stringify(request), "utf8");
    await writeFile(runnerPath, MUSOU_RUNNER_SCRIPT, "utf8");

    const proc = spawn(process.execPath, [runnerPath, requestPath], {
      cwd: ctx.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [MUSOU_NO_RECURSE_ENV]: "1" },
    });
    proc.unref();

    return files;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function getRunFiles(tempDir: string): MusouRunFiles {
  return {
    tempDir,
    stdoutPath: join(tempDir, "stdout.txt"),
    stderrPath: join(tempDir, "stderr.txt"),
    resultPath: join(tempDir, "result.json"),
    markerPath: join(tempDir, "done.json"),
    targetsPath: join(tempDir, "targets.json"),
    configPath: join(tempDir, "config.json"),
  };
}

function parseProposalArray(raw: string): { ok: true; proposals: ParsedProposal[] } | { ok: false; error: string } {
  const candidates = [raw, stripOuterMarkdownFence(raw)].filter((value, index, array) => array.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: `Musou subprocess returned non-array JSON: ${truncate(candidate, 600)}` };
      }
      return { ok: true, proposals: parsed as ParsedProposal[] };
    } catch {
      // try next candidate
    }
  }

  return { ok: false, error: `Failed to parse musou JSON: ${truncate(raw, 600)}` };
}

function stripOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function normalizeProposal(proposal: ParsedProposal, targets: MusouTargetFile[], config: MusouConfig, cwd: string): Proposal | null {
  if (typeof proposal.reason !== "string" || typeof proposal.proposed_content !== "string") return null;

  const existingTarget = targets.find((item) => item.target === proposal.target);
  const target = existingTarget ?? createNewSkillTarget(proposal.target, targets, config, cwd);
  if (!target) return null;
  if (proposal.proposed_content.length > target.cap) return null;
  if (proposal.proposed_content === target.content) return null;

  return {
    target: target.target,
    reason: proposal.reason,
    proposed_content: proposal.proposed_content,
    originalPath: target.path,
    originalContent: target.content,
  };
}

async function reviewPendingProposals(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  proposals: Proposal[],
): Promise<{ accepted: number; discarded: number; remaining: Proposal[]; quit: boolean }> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Musou review requires interactive mode.", "error");
    return { accepted: 0, discarded: 0, remaining: proposals, quit: true };
  }

  const remaining = [...proposals];
  let accepted = 0;
  let discarded = 0;
  let quit = false;

  while (remaining.length > 0) {
    const proposal = remaining[0]!;
    const action = await reviewProposalUi(ctx, proposal, accepted + discarded + 1, proposals.length);

    if (action === "quit") {
      quit = true;
      break;
    }

    if (action === "accept") {
      const applied = await applyProposal(pi, ctx, proposal);
      if (applied) accepted += 1;
    } else {
      discarded += 1;
    }

    remaining.shift();
  }

  return { accepted, discarded, remaining, quit };
}

async function applyProposal(pi: ExtensionAPI, ctx: ExtensionCommandContext, proposal: Proposal): Promise<boolean> {
  try {
    await withFileMutationQueue(proposal.originalPath, async () => {
      await mkdir(dirname(proposal.originalPath), { recursive: true });
      await writeFile(proposal.originalPath, proposal.proposed_content, "utf8");
    });

    pi.sendMessage(
      {
        customType: "musou-applied",
        content: `✓ Applied musou improvement to ${proposal.originalPath}`,
        display: true,
        details: { path: proposal.originalPath, reason: proposal.reason, target: proposal.target },
      },
      { deliverAs: "nextTurn" },
    );
    return true;
  } catch (error) {
    ctx.ui.notify(`Musou write failed: ${String(error)}`, "error");
    return false;
  }
}

async function reviewProposalUi(
  ctx: ExtensionCommandContext,
  proposal: Proposal,
  index: number,
  total: number,
): Promise<ReviewAction> {
  const diffLines = buildDiffLines(proposal.originalContent, proposal.proposed_content);

  return ctx.ui.custom<ReviewAction>((tui, theme, _kb, done) => {
    let scroll = 0;

    return {
      render: (width: number) => {
        const rule = theme.fg("dim", "─".repeat(Math.max(width, 1)));
        const section = (label: string) => theme.fg("dim", `── ${label} ${"─".repeat(Math.max(0, width - label.length - 4))}`);

        const header = [
          rule,
          theme.fg("accent", theme.bold(`Musou Proposal ${index} of ${total}`)),
          rule,
          section("Target"),
          `${proposal.originalPath}`,
          section("Reason"),
          `${proposal.reason}`,
          section("Controls"),
          theme.fg("dim", "[A] Accept   [D] Discard   [Q] Quit   [↑↓/j/k] Scroll"),
          theme.fg(
            "dim",
            `Showing lines ${Math.min(scroll + 1, diffLines.length)}-${Math.min(scroll + REVIEW_VIEWPORT_LINES, diffLines.length)} of ${diffLines.length}`,
          ),
          rule,
          section("Diff"),
        ];

        const viewport = diffLines.slice(scroll, scroll + REVIEW_VIEWPORT_LINES).map((line) => {
          if (line.startsWith("+ ")) return theme.fg("success", line);
          if (line.startsWith("- ")) return theme.fg("error", line);
          if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return theme.fg("accent", line);
          return line;
        });

        const wrapped: string[] = [];
        for (const line of [...header, ...viewport, rule]) {
          const segments = wrapTextWithAnsi(line, Math.max(width, 1));
          wrapped.push(...(segments.length > 0 ? segments.map((segment) => truncateToWidth(segment, width)) : [""]));
        }
        return wrapped;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (matchesKey(data, Key.up) || data === "k") {
          scroll = Math.max(0, scroll - 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          scroll = Math.min(Math.max(0, diffLines.length - REVIEW_VIEWPORT_LINES), scroll + 1);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.pageUp)) {
          scroll = Math.max(0, scroll - REVIEW_VIEWPORT_LINES);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.pageDown)) {
          scroll = Math.min(Math.max(0, diffLines.length - REVIEW_VIEWPORT_LINES), scroll + REVIEW_VIEWPORT_LINES);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter) || data.toLowerCase() === "a") {
          done("accept");
          return;
        }
        if (data.toLowerCase() === "d") {
          done("discard");
          return;
        }
        if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
          done("quit");
        }
      },
    };
  });
}

function buildDiffLines(original: string, proposed: string): string[] {
  const patch = structuredPatch("current", "proposed", original, proposed, "", "", { context: REVIEW_DIFF_CONTEXT_LINES });
  const lines = ["--- current", "+++ proposed"];

  if (patch.hunks.length === 0) {
    return [...lines, "@@", "  (no visible line changes)"];
  }

  for (const hunk of patch.hunks) {
    lines.push(`@@ ${formatUnifiedRange("-", hunk.oldStart, hunk.oldLines)} ${formatUnifiedRange("+", hunk.newStart, hunk.newLines)} @@`);
    lines.push(...hunk.lines.map(formatDiffDisplayLine));
  }

  return lines;
}

function formatUnifiedRange(prefix: "-" | "+", start: number, count: number): string {
  if (count === 0) return `${prefix}${start},0`;
  if (count === 1) return `${prefix}${start}`;
  return `${prefix}${start},${count}`;
}

function formatDiffDisplayLine(line: string): string {
  if (line.startsWith("+")) return `+ ${line.slice(1)}`;
  if (line.startsWith("-")) return `- ${line.slice(1)}`;
  if (line.startsWith(" ")) return `  ${line.slice(1)}`;
  if (line.startsWith("\\")) return `  ${line}`;
  return line;
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readMusouCap(path: string, fallback: number, content?: string): Promise<number> {
  try {
    const text = content ?? (await readFile(path, "utf8"));
    const match = text.match(/^<!--\s*musou-cap:\s*(\d+)\s*-->\s*(?:\r?\n)?/);
    const parsed = match ? Number.parseInt(match[1]!, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function createNewSkillTarget(targetId: string, targets: MusouTargetFile[], config: MusouConfig, cwd: string): MusouTargetFile | null {
  if (!isProposalTarget(targetId)) return null;
  if (!targetId.startsWith("global-skill:") && !targetId.startsWith("project-skill:")) return null;

  const [scope, skillName] = targetId.split(":", 2) as ["global-skill" | "project-skill", string | undefined];
  if (!skillName || !isSafeSkillName(skillName)) return null;

  const skillRoot = scope === "global-skill" ? resolve(getAgentDir(), "skills") : resolve(cwd, ".pi/skills");
  const path = resolve(skillRoot, skillName, "SKILL.md");
  if (!path.startsWith(skillRoot)) return null;

  const existingScopeTarget = targets.find((item) => item.target === targetId);
  if (existingScopeTarget) return existingScopeTarget;

  return {
    target: targetId,
    path,
    label: `${scope === "global-skill" ? "Global" : "Project"} skill: ${skillName}`,
    content: "",
    cap: config.maxFileLengthChars,
  };
}

function isProposalTarget(value: string): value is ProposalTarget {
  return value === "global-agents" || value === "project-agents" || value.startsWith("global-skill:") || value.startsWith("project-skill:");
}

function isSafeSkillName(skillName: string): boolean {
  if (skillName.trim() === "") return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName);
}

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME;
  return home ? join(home, ".pi/agent") : resolve(".pi/agent");
}

async function getSessionFingerprint(sessionFile: string): Promise<string | null> {
  try {
    const info = await stat(sessionFile);
    return `${info.size}:${Math.floor(info.mtimeMs)}`;
  } catch {
    return null;
  }
}

async function readRunFingerprint(tempDir: string): Promise<string | null> {
  try {
    return (await readFile(join(tempDir, "fingerprint.txt"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function parseRunResult(raw: string): MusouRunResult {
  try {
    const parsed = JSON.parse(raw) as Partial<MusouRunResult>;
    return {
      code: typeof parsed.code === "number" || parsed.code === null ? parsed.code : 1,
      signal: typeof parsed.signal === "string" || parsed.signal === null ? parsed.signal : null,
      timedOut: parsed.timedOut === true,
    };
  } catch {
    return { code: 1, signal: null, timedOut: false };
  }
}

function parseRunTargets(raw: string): MusouTargetFile[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MusouTargetFile[]) : null;
  } catch {
    return null;
  }
}

function parseRunConfig(raw: string): MusouConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MusouConfig>;
    return {
      musouEvery: normalizePositiveInt(parsed.musouEvery, DEFAULT_CONFIG.musouEvery),
      maxFileLengthChars: normalizePositiveInt(parsed.maxFileLengthChars, DEFAULT_CONFIG.maxFileLengthChars),
      timeoutMs: normalizePositiveInt(parsed.timeoutMs, DEFAULT_CONFIG.timeoutMs),
      thinkingLevel: normalizeThinkingLevel(parsed.thinkingLevel, DEFAULT_CONFIG.thinkingLevel),
    };
  } catch {
    return null;
  }
}

function formatAge(timestamp: number): string {
  return formatDuration(Date.now() - timestamp);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const MUSOU_RUNNER_SCRIPT = String.raw`const fs = require("node:fs");
const { spawn } = require("node:child_process");

const requestPath = process.argv[2];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));

const stdoutFd = fs.openSync(request.stdoutPath, "w");
const stderrFd = fs.openSync(request.stderrPath, "w");

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  try {
    fs.writeFileSync(request.resultPath, JSON.stringify(result));
  } catch {}
  try {
    fs.writeFileSync(request.markerPath, JSON.stringify({ done: true, at: Date.now() }));
  } catch {}
  try {
    fs.closeSync(stdoutFd);
  } catch {}
  try {
    fs.closeSync(stderrFd);
  } catch {}
}

let child;
try {
  child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
} catch (error) {
  finish({ code: 1, signal: null, timedOut: false, spawnError: String(error) });
  process.exit(0);
}

const timeoutHandle = setTimeout(() => {
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 5000).unref();
}, request.timeoutMs);
timeoutHandle.unref();

child.on("error", (error) => {
  clearTimeout(timeoutHandle);
  try {
    fs.appendFileSync(request.stderrPath, "\nSpawn error: " + String(error) + "\n");
  } catch {}
  finish({ code: 1, signal: null, timedOut: false });
  process.exit(0);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeoutHandle);
  finish({ code, signal, timedOut: signal === "SIGTERM" || signal === "SIGKILL" });
  process.exit(0);
});
`;
