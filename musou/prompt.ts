export const MUSOU_PROMPT_INSTRUCTIONS = `## Output schema and instructions

Return a JSON array. Each element has this shape:
{
  "target": "global-agents" | "project-agents" | "global-skill:<name>" | "project-skill:<name>",
  "reason": "<one sentence: what pattern in the session motivated this>",
  "proposed_content": "<full new content of the file>"
}

Rules:
- proposed_content must be the COMPLETE new file content, not a diff.
- proposed_content must not exceed the character cap for that file.
- You MAY target an existing skill file or propose a NEW skill file, but only for reusable action-oriented procedures, workflows, or task-specific actions.
- New global skills must use target form global-skill:<name> and will be created under {{GLOBAL_SKILL_ROOT}}/<name>/SKILL.md
- New project skills must use target form project-skill:<name> and will be created under {{PROJECT_SKILL_ROOT}}/<name>/SKILL.md
- For NEW skills, return only the skill name in the target, not a filename or path. Example: project-skill:code-review
- Do not return .md, SKILL.md, nested paths, directories, slashes, or absolute paths in the target.
- New skills should be concise and directly usable.
- New skills should follow this minimal template:
  ---
  name: lowercase-hyphenated-name
  description: One sentence saying what the skill does and when to use it.
  ---

  # Skill Title

  Short actionable instructions.
- The skill name should be lowercase letters/numbers/hyphens and should match the target name exactly.
- Prefer AGENTS.md for behavioral guidance, preferences, judgment, and "when X, do/avoid Y" rules.
- Prefer skills for repeatable procedures, command recipes, checklists, or workflows.
- If unsure whether something belongs in a skill or AGENTS.md, prefer AGENTS.md.
- If the cap would be exceeded, consolidate or remove existing content to make room.
- If you have nothing meaningful to add or improve, return an empty array [].
- Do not propose changes that are too specific to this session to be generally useful.
- Prefer consolidating similar existing rules over adding new ones.
- Return [] rather than making low-confidence proposals.
`;

export function renderMusouPromptInstructions(globalSkillRoot: string, projectSkillRoot: string): string {
  return MUSOU_PROMPT_INSTRUCTIONS
    .replace("{{GLOBAL_SKILL_ROOT}}", globalSkillRoot)
    .replace("{{PROJECT_SKILL_ROOT}}", projectSkillRoot);
}
