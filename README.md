# Traffic

Repository traffic recorded by the `Traffic` workflow. GitHub keeps only the
last 14 days, so the workflow runs weekly and merges each window into these files.

- `views.json`, `clones.json`: one row per day with `date`, `count`, and `uniques`.
- `referrers.json`, `paths.json`: one 14-day snapshot per run, dated by the fetch.

Written by `.github/scripts/traffic.mjs` on `main`; do not edit by hand.
