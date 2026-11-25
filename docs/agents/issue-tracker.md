# Local Markdown Issue Tracker

Keep specs and tickets in `.scratch/<feature-slug>/`.

- Save the spec as `spec.md`.
- Save each implementation ticket as `issues/<NN>-<slug>.md`, starting at `01`.
- Set the ticket's `Status:` line near the top using the
  [triage labels](triage-labels.md).
- Append comments under `## Comments`.

To publish a spec or ticket, create its file and parent directories as needed.
To fetch a ticket, read the supplied path or look up its number in the feature's
`issues/` directory.

## Wayfinding

- Keep the map in `.scratch/<effort>/map.md`. Record notes, decisions, and open
  questions there.
- Keep tickets in the map's `issues/` directory using the same numbering
  convention. Record the ticket type on a `Type:` line using `research`,
  `prototype`, `grilling`, or `task`.
- Record blockers on a `Blocked by: NN, NN` line. A ticket is unblocked when all
  listed tickets have `Status: resolved`.
- Pick the lowest-numbered open, unblocked, unclaimed ticket. Set
  `Status: claimed` and save before starting.
- To resolve a ticket, append an `## Answer` section, set `Status: resolved`,
  and add a summary and link to the map's decisions.
