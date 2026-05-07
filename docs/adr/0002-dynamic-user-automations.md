# 0002 - Dynamic User Automations

Date: 2026-05-07

Status: Accepted

## Context

The Settings menu previously exposed a hardcoded `Daily word routine` button. That does not fit i-Journal's product shape: users are different, and their needs can range from reminders to motivation, scripture, business reviews, family prompts, health nudges, learning, and other recurring help.

Hardcoding one button per possible use case would make the app brittle and narrow.

## Decision

Settings should render user-specific automations from persisted data, not from fixed routine buttons.

The runtime gateway turns natural user requests into safe structured proposals:

- `reminder`: one-off reminder stored in `pending_reminders`
- `routine`: recurring `agent.custom_prompt` stored in `routines`

The agent gets first pass at interpreting fluid user intent. Deterministic parsing exists only as fallback and validation plumbing.

## Consequences

- Users can create different automations without new UI code for every use case.
- Settings becomes a control panel for the user's actual routines and reminders.
- The app keeps a bounded execution model: the agent can propose reminder/routine records, but not arbitrary code.
- Specific hardcoded skills like `learning.word_of_day` may still exist, but they are not the default gateway for personalization.

## Guardrails

- Do not add new hardcoded Settings buttons for individual routine ideas.
- Prefer `agent.custom_prompt` for user-specific recurring behavior.
- Keep confirmation before saving new automations.
- Treat new execution capabilities as explicit tools with structured storage and scheduler behavior.
