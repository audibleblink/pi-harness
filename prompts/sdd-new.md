---
description: Start a new change 
---

Create a PRD to implement the following feature

**Request**

$ARGUMENTS

**Output**

A PRD outlining the requirements of the requested feature. 
Interview the requester for anything you, the LLM, feel is missing. 
Also hammer out technology stack choices with the user.

Once a complete PRD is finalized, write it out as:
- if there's a ./spec/ directory with existing prds/plans, follow that convention
- otherwise write ./prd.md

Remind the user to start a new session with `/new` before creating the execution plan

**Guardrails**
- Do NOT create any other artifacts yet 
- Do NOT advance beyond writing the PRD
