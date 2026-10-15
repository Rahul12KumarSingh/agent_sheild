# AgentShield

A policy checkpoint for AI coding agents. It checks every prompt and every action through the agent app's own hooks, blocks the dangerous ones with a safe alternative, and asks a human on judgement calls.

> **Status: Phase 0 (spikes).** The engine is a stub that blocks anything containing `AGENTSHIELD_TEST`. Real rules arrive in Phase 1. See [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) and [docs/TEAM-GUIDE.md](docs/TEAM-GUIDE.md).

| Decision | Value |
|---|---|
| Track | _to decide_ |
| Problem statement | _to decide_ |
| Product name | AgentShield (_name check pending_) |
| Google Cloud project | _to decide_ |

## Requirements

- macOS, Windows or Linux. There is one build: the same `dist/` files run everywhere, and CI tests all three
- Node 22 or 24
- Claude Code (the primary supported agent)
- To deploy: the Google Cloud CLI (`gcloud`). Docker is not needed

## Build and test

```bash
npm install
npm run build      # dist/cli.js (the hook program) and dist/server.js
npm test
npm run typecheck
```

## Try the hook in Claude Code

Add this to `.claude/settings.json` in any project, using the absolute path to your clone. On Windows use forward slashes, for example `node C:/code/agentshield/dist/cli.js hook claude`:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node /path/to/agentshield/dist/cli.js hook claude" }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/agentshield/dist/cli.js hook claude" }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node /path/to/agentshield/dist/cli.js hook claude" }] }]
  }
}
```

Then, in Claude Code, ask it to run `echo AGENTSHIELD_` followed by `TEST`. The command is blocked with a reason. A prompt that contains the marker is blocked before it reaches the model. `agentshield init` will write this for you in Phase 4.

Check a single prompt or command without an agent:

```bash
node dist/cli.js check "echo AGENTSHIELD_TEST"
```

### Capture real hook payloads

Add `--capture <dir>` to the hook command, for example `node /path/to/agentshield/dist/cli.js hook claude --capture /path/to/agentshield/captures`. The flag works in every shell (the `AGENTSHIELD_CAPTURE_DIR` environment variable also works). Each payload is saved with the home folder and username scrubbed. Review the files before copying them into `test/fixtures/<agent>/`, where contract tests parse every one.

## Run the server

```bash
npm start          # http://localhost:8080, health check at /healthz
```

## Deploy to Cloud Run

```bash
gcloud auth login
npm run deploy -- --project <your-project>       # --region defaults to asia-south1
```

The same command works in Terminal, PowerShell and cmd.

The script builds from source with Cloud Build, deploys one always-on instance with public access, and fails unless `/healthz` returns `ok`.

## Behaviour notes

- **Fail closed:** malformed input or an internal error denies the action with an explanation (exit code 2).
- **Headless:** set `AGENTSHIELD_HEADLESS=1` (or `CI=true`) and every "ask" becomes a deny.
- **Never approves:** AgentShield only blocks, asks or stays silent. Silence leaves Claude Code's own permission rules in charge.
