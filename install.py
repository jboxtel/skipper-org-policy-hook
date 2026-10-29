#!/usr/bin/env python3
"""Install or update the Skipper org policy hook for Claude Code.

Copies sf-org-guard.py into <config dir>/hooks/ and registers it in <config dir>/settings.json
(SessionStart + PreToolUse hooks, plus deny rules so the agent cannot edit the hook or settings).
The config dir is $CLAUDE_CONFIG_DIR if set, else ~/.claude; override with --config-dir DIR.
Safe to run again: it replaces the hook file and skips settings that are already there.
"""

import json
import os
import shutil
import sys
from pathlib import Path

HOOK_NAME = "sf-org-guard.py"
SOURCE = Path(__file__).resolve().parent / HOOK_NAME


def config_dir(argv):
    if "--config-dir" in argv:
        return Path(argv[argv.index("--config-dir") + 1]).expanduser().resolve()
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or Path.home() / ".claude").expanduser().resolve()


def shell_path(path):
    """$HOME/... when possible, so the settings file reads the same on every machine."""
    home = Path.home()
    return f"$HOME/{path.relative_to(home)}" if path.is_relative_to(home) else str(path)


def tilde_path(path):
    home = Path.home()
    return f"~/{path.relative_to(home)}" if path.is_relative_to(home) else str(path)


def rule_path(path):
    """Permission rules read /x as relative to the settings file; absolute paths need //x."""
    p = tilde_path(path)
    return p if p.startswith("~") else "/" + p


def has_guard(entries):
    return any(HOOK_NAME in h.get("command", "") for e in entries for h in e.get("hooks", []))


def main(argv):
    if sys.version_info < (3, 9):
        sys.exit("Python 3.9 or newer is required")
    cfg = config_dir(argv)
    hook = cfg / "hooks" / HOOK_NAME
    settings_path = cfg / "settings.json"

    hook.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SOURCE, hook)
    print(f"hook installed: {hook}")

    settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
    if settings_path.exists():
        shutil.copyfile(settings_path, settings_path.with_suffix(".json.bak"))

    command = f'python3 "{shell_path(hook)}"'
    hooks = settings.setdefault("hooks", {})
    session_start = hooks.setdefault("SessionStart", [])
    if not has_guard(session_start):
        session_start.append({"hooks": [{"type": "command", "command": f"{command} --session-start"}]})
    pre_tool_use = hooks.setdefault("PreToolUse", [])
    if not has_guard(pre_tool_use):
        pre_tool_use.append({"matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit",
                             "hooks": [{"type": "command", "command": command}]})

    deny = settings.setdefault("permissions", {}).setdefault("deny", [])
    for tool in ("Edit", "Write"):
        for target in (f"{rule_path(hook.parent)}/**", rule_path(settings_path), ".claude/org-policy.json"):
            rule = f"{tool}({target})"
            if rule not in deny:
                deny.append(rule)

    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"settings updated: {settings_path}")
    print(f"\nRestart Claude Code. Then, in each Salesforce project:\n"
          f"  python3 {tilde_path(hook)} --init\n"
          f"  python3 {tilde_path(hook)} --set <alias> read=allow validate=allow deploy=ask")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
