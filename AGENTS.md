# Musou project guidance

- When changing Musou's dream/analyzer prompt, skill-generation behavior, or target-path rules, first verify the current pi docs/examples for actual discovery and format constraints, then align the prompt text and code with those constraints.
- Treat prompt strings as review-sensitive code: prefer keeping large prompt constants in dedicated files/helpers instead of embedding long instruction blocks inline.
- For skill-related changes, distinguish clearly between:
  - AGENTS.md content for behavioral guidance, preferences, and judgment rules
  - skill content for reusable procedures, checklists, command recipes, and workflows
- Do not encourage formats the runtime will not discover. If the prompt restricts allowed skill paths or templates, make runtime validation match those rules as closely as practical.
- When the user asks for a concise explanation or status update, answer only the requested question and do not append raw prompt text, large file contents, or unrelated generated material.
- After editing prompt-building code, quickly verify both the prompt source file and the call site so the final behavior matches the intended wording.
