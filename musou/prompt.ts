export const MUSOU_PROMPT_INSTRUCTIONS = `
Analyze this session as a short postmortem. Propose only persistent, high-value learnings that would likely have prevented noticeable friction if they had existed before the session.

Look for repeated corrections or preferences, repeated tool mistakes, rediscovered workflows, and avoidable backtracking.

Only propose something if it is repeated or persistent, generalizable beyond this session, not already covered well enough, and realistically fixable by AGENTS.md or a skill. Prefer [] over weak ideas. Return at most 3 proposals.

Use AGENTS.md for behavior, judgment, and preferences. Use skills for reusable procedures, checklists, command recipes, scripts, references, or workflows. If unsure, prefer AGENTS.md.

Return a JSON array only. Each element has this shape:
{
  "target": "global-agents" | "project-agents" | "global-skill:<name-or-existing-id>" | "project-skill:<name-or-existing-id>",
  "reason": "<one sentence naming the repeated friction and why this change would help>",
  "files": [
    {
      "path": "<file path>",
      "content": "<full new content for that file>"
    }
  ]
}

Rules:
- files is required for every target.
- Use the exact provided target id when updating an existing target.
- Each file.content must be the COMPLETE new content of that file, not a diff.
- Preserve unrelated existing content and make the smallest effective change.
- Files not listed stay unchanged.
- Each file.content must stay within its shown cap. New files use the default per-file cap shown in context.
- For AGENTS.md targets and existing root single-file markdown skills, files must contain exactly one entry matching the existing filename.
- For skill directory targets, file.path values must be relative to the skill root, for example: SKILL.md, scripts/process.sh, references/api.md.
- file.path must not be absolute and must not contain .. segments.
- Text files only. Do not propose binary files, images, archives, or base64 blobs.
- New global skills must use target global-skill:<name> and will be created under {{GLOBAL_SKILL_ROOT}}/<name>/
- New project skills must use target project-skill:<name> and will be created under {{PROJECT_SKILL_ROOT}}/<name>/
- New skills must include SKILL.md. New SKILL.md files must use Agent Skills frontmatter, and the frontmatter name must exactly match the skill name.
- Skill names must be 1-64 characters of lowercase letters, numbers, and single hyphens.
- Prefer consolidating similar existing rules over adding new ones.

Examples:
[]

[
  {
    "target": "project-agents",
    "reason": "The user repeatedly asked for concise status-only answers, so a project rule would reduce repeated corrections.",
    "files": [
      {
        "path": "AGENTS.md",
        "content": "<full AGENTS.md content>"
      }
    ]
  }
]

[
  {
    "target": "project-skill:release-checklist",
    "reason": "The agent had to rediscover the same release steps multiple times, so a reusable skill would save turns.",
    "files": [
      {
        "path": "SKILL.md",
        "content": "---\nname: release-checklist\ndescription: Reusable release checklist for this project.\n---\n\n# Release Checklist\n..."
      },
      {
        "path": "scripts/verify.sh",
        "content": "#!/usr/bin/env bash\n..."
      }
    ]
  }
]
`;

export function renderMusouPromptInstructions(globalSkillRoot: string, projectSkillRoot: string): string {
	return MUSOU_PROMPT_INSTRUCTIONS.replace("{{GLOBAL_SKILL_ROOT}}", globalSkillRoot).replace(
		"{{PROJECT_SKILL_ROOT}}",
		projectSkillRoot,
	);
}
