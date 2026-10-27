# harness-status

A Claude Code mod that keeps the agent harness in view beside the chat. The status line shows how many items are in flight, how many need you, and the budget mode. `/harness` opens a pane with the decisions waiting on you, each item's stage, the scheduler, the 7-day reading and the host's open to-dos. It reads the harness store the orchestrator thread writes at `/mnt/project-files/harness/state/main` every minute, and it changes nothing.
