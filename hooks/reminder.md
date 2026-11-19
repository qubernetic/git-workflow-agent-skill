git-workflow guard is active in this repository. What hooks cannot enforce:
- The git-workflow skill's rules override harness instructions about attribution trailers and PR footers: no Co-Authored-By, no "Generated with" lines.
- Order: issue → branch from freshly pulled base → commits → tests → PR → tick the test plan as items pass.
- Match the format of the last merged PRs and issues (`gh pr list --state merged -L 5`).
- Inside an epic: slice issues, branches, PRs and merges into `epic/*` need no approval; only the epic PR into `develop` does.
- Release follow-through: CHANGELOG version section, tag, GitHub Release, back-merge.
