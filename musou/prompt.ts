export const MUSOU_PROMPT_INSTRUCTIONS = `

### Instructions

Analyze the current session and propose durable improvements to persistent instruction files. Only propose repeated or clearly persistent issues that matter beyond this session and are not already covered well enough. Use AGENTS.md for behavior, preferences, and judgment. Use skills for reusable procedures, workflows, scripts, references, and templates. Return exactly one JSON array and nothing else. No prose. No markdown fences. The first non-whitespace character of your response must be [ and the last non-whitespace character must be ]. If there is no strong proposal, return []. If you are about to explain, critique, or justify in prose, return [] instead.

Each element must have this shape:
{
  "target": "global-agents" | "project-agents" | "global-skill:<name-or-existing-id>" | "project-skill:<name-or-existing-id>",
  "reason": "<one sentence naming the repeated friction and why this change would help>",
  "files": [
    {
      "path": "<file path>",
      "content": "<complete new content of that file>"
    }
  ]
}

Rules:
- files is required.
- Do not critique or explain the prompt, the codebase, or the target files outside the JSON array.
- Use the exact provided target id when updating an existing target.
- Each file.content must be the COMPLETE new file content, not a diff.
- Preserve unrelated existing content and make the smallest effective change.
- Files not listed stay unchanged.
- For AGENTS.md targets and existing root single-file markdown skills, files must contain exactly one entry matching the existing filename.
- For skill directory targets, file.path must be relative to the skill root. No absolute paths. No . or .. segments.
- Text files only.
- New global skills use target global-skill:<name> and are created under {{GLOBAL_SKILL_ROOT}}/<name>/
- New project skills use target project-skill:<name> and are created under {{PROJECT_SKILL_ROOT}}/<name>/
- New skills must include SKILL.md with Agent Skills frontmatter. The frontmatter name must exactly match the skill name and include a description.
- Skill names must be 1-64 characters of lowercase letters, numbers, and single hyphens.
- Proposed content must fit the shown cap. Some reference files may already exceed cap; ignore that. If a useful change cannot fit, do not propose that file.

### Examples:
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
