---
name: write-an-agent
description: Writes or refines concise pi subagent definitions for this repo, keeping each agent under 100 lines with a sharp role, family, tool policy, and output contract. Use when creating, rewriting, or tightening agent prompts in `.pi/prompts/` or `prompts/`.
---

# Write an Agent

Goal: produce a high-signal agent file in fewer than 100 lines.

## Use this for
- new repo-local agent prompts in `.pi/prompts/`
- bundled package agent prompts in `prompts/`
- tightening bloated prompts into a crisp reusable worker

## Design rules
1. One job only. If the agent does two unrelated things, split it.
2. One tool policy. Give the minimum tools needed.
3. One output contract. Tell the next agent exactly what comes back.
4. Keep the whole file under 100 lines.
5. If the prompt needs more than 100 lines, write a skill instead.

## Agent families
- `scout` — read-only reconnaissance or evidence. Produces a compressed handoff; never edits files.
- `consult` — read-only planning, design, or judgment. Produces a recommendation or specification; never edits files.
- `worker` — code or proof-artifact production. May receive edit/write tools and must report changed files plus validation.

Choose the family from the artifact the agent produces, not its title. Missing or unknown families appear as ungrouped in `list_agents`.

## File shape
```md
---
name: agent-name
description: What it does. Use when ...
family: scout
tools: read, grep, find, ls
model: openai/gpt-5.4-mini
thinking: medium
---

You are the <agent-name>.

Mission:
- outcome

Rules:
1. boundary
2. boundary

Output:
## Section
- exact shape
```

## Authoring workflow
1. Name the role and classify its output as `scout`, `consult`, or `worker`.
2. Write a one-sentence description with trigger language: "Use when ...".
3. Pick the smallest tool list: scouts and consults stay read-only; only workers receive edit/write tools.
4. Pick a cheap reader model for scouts, a strong judgment model for consults, or a builder model for workers.
5. Write 3–6 rules, define the handoff sections, then trim anything decorative.

## Repo conventions
- Repo-local overrides belong in `.pi/prompts/`; bundled reusable prompts belong in `prompts/`.
- Every bundled prompt declares `family`; project/user prompts may omit it and remain ungrouped.
- Default scouts are `scout`, `docs-scout`, and `validator`; default consults are `planner`, `advisor`, and `ux-designer`; default workers are `worker` and `bug-prover`.
- Prefer local pi docs before external docs when writing `docs-scout`.
- Put concrete verification commands in planner handoffs and worker validation output when package behavior changes.

## Prompt hygiene (anti-rot)

Prompts are code: unmaintained instructions become technical debt. Apply the
same doctrine a project applies to its AGENTS.md — durable facts and
invariants, not narration.

- **Invariants, not incidents.** A rule earned from a field bug must state
  the durable invariant, never the story ("fixes relocate gaps more often
  than they close them" — not "remember that PR"). References to tools,
  tickets, or model quirks of the moment rot first.
- **One owner per fact.** Anything that drifts (model ids, tool lists,
  paths) lives in frontmatter or arrives in the caller's task — never
  restated in the body. A block repeated across prompts is the same fact
  with N owners: compress it to one convention line per prompt.
- **Every line changes behavior.** If deleting a line would not change what
  the agent does, delete it.
- **Output contracts are APIs.** Downstream agents parse the sections;
  renaming or reshaping them is a breaking change — evolve additively.
- **Update on every miss.** When an agent fails in the field, amend the rule
  that should have caught it — as an invariant, in the same change as the
  fix. A prompt that never absorbs its misses is rotting silently.

## Review checklist
- Is the role narrower than a general engineer, with the correct family for its output?
- Would another agent know exactly when to use it, and are its tools minimal for that family?
- Is the handoff structured, and is the file under 100 lines?
- Does any line narrate an incident instead of stating its invariant?
- Is any fact stated here also owned somewhere else?
