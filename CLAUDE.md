@AGENTS.md

<!--
  This file exists only as a bridge for tools that read CLAUDE.md but not
  AGENTS.md — Claude Code reads CLAUDE.md natively and AGENTS.md only via an
  `@path` import.

  Keep it to the import. Everything else belongs in AGENTS.md, which is the
  single source of truth and is read directly by pi, omp, Codex, Cursor, Copilot
  and ~20 other agents.

  Do not copy content here. Duplicating it means two files to keep in step, and
  the copies drift. Note that pi reads only the *first* match in
  AGENTS.override.md → AGENTS.md → AGENTS.MD → CLAUDE.md order, so when both
  exist AGENTS.md wins and this file is not even loaded there.
-->
