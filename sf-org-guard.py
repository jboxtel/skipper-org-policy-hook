#!/usr/bin/env python3
"""Skipper org policy hook: deterministic Salesforce org guard for AI agents (global Claude Code hook,
one copy for all projects).

Every Bash command is scanned for `sf` / `sfdx` invocations (also inside `bash -c`, `eval`, `$(...)`,
`npx`, `env`, ...) and for the project scripts listed in the project's .claude/org-policy.json. Each
invocation is classified into a category (read, validate, deploy, data, execute, agent, admin, or local)
and its target org is resolved the same way the sf CLI does: --target-org / -o flag, SF_TARGET_ORG,
project .sf/config.json, global config. The alias is resolved to a username, and the username's policy
decides: allow, ask, or deny. Anything it cannot classify or resolve is denied (fail closed).

The policy is per project: <project>/.claude/org-policy.json. A project without one cannot reach any
org; the human creates it with --init. In a Salesforce project (sfdx-project.json) without a policy,
the SessionStart hook tells the agent to ask for that first.

The hook also refuses agent edits to the policy, to the guard itself, and to the Claude settings files
that register it. A project that registers its own copy of this guard keeps it; this global copy then
only protects files.

Usage:
  (hook)  reads the PreToolUse JSON on stdin
  python3 sf-org-guard.py --session-start                      SessionStart hook: ask for a missing policy
  python3 sf-org-guard.py --init [<alias|username> ...]        create the project policy, all deny (human only)
  python3 sf-org-guard.py --set <alias|username> <category>=<allow|ask|deny> [...]   (human only)
  python3 sf-org-guard.py --show                               print the project policy per org
  python3 sf-org-guard.py --check "<command>" [--cwd DIR]      print the decision for a command
"""

import json
import os
import re
import shlex
import sys
from pathlib import Path

HOOK_PATH = Path(__file__).resolve()
HOME = Path.home()
HOOK_DISPLAY = f"~/{HOOK_PATH.relative_to(HOME)}" if HOOK_PATH.is_relative_to(HOME) else str(HOOK_PATH)

# set by set_project() before anything else runs
PROJECT_ROOT = Path.cwd()
POLICY_PATH = PROJECT_ROOT / ".claude" / "org-policy.json"

CATEGORIES = ["read", "validate", "deploy", "data", "execute", "agent", "admin"]
DECISIONS = ["allow", "ask", "deny"]
RANK = {"allow": 0, "ask": 1, "deny": 2}

# Written into every policy file by --init and refreshed by --set, so keep it in sync with COMMANDS.
README = [
    "Which Salesforce orgs an AI agent may touch in this project, and how. Enforced by the Skipper",
    f"org policy hook ({HOOK_DISPLAY}), not by the model. The agent cannot edit",
    "this file; a human edits it or runs:",
    f"  python3 {HOOK_DISPLAY} --set <alias|username> <category>=<allow|ask|deny>",
    f"  python3 {HOOK_DISPLAY} --show            (table of the policy below)",
    f"  python3 {HOOK_DISPLAY} --check \"<cmd>\"   (what the guard would decide)",
    "",
    "DECISIONS (one per org per category)",
    "  allow  the guard steps aside; Claude Code's normal permission rules still apply",
    "  ask    the human is prompted for every such command, even if it is allow-listed",
    "  deny   blocked; the agent is told not to work around it",
    "  A missing category or an unknown value counts as deny. When one command line touches several",
    "  orgs or categories, the strictest decision wins.",
    "",
    "CATEGORIES: what each one lets the agent do, the worst case, and a typical setting.",
    "Every sf command maps to exactly one; the longest matching command prefix wins.",
    "",
    "  read      Look, don't touch: see metadata, query records, pull source into the project.",
    "            Worst case: sees data it shouldn't (data export can dump whole objects), and",
    "            org display --verbose / org open hand out a logged-in session.",
    "            Typical: allow on sandboxes and dev orgs; ask on production.",
    "            Commands: data query/get/search/export, project retrieve, org display/open/list,",
    "            sobject describe, apex list/get/tail log, agent list/validate/generate,",
    "            package list, api request rest (GET)",
    "",
    "  validate  Dry-run a deploy: the org compiles the metadata and may run tests, then rolls",
    "            everything back. Worst case: long test runs; nothing is saved.",
    "            Typical: allow wherever deploy is allow or ask, production included.",
    "            Commands: project deploy validate, project deploy start --dry-run",
    "",
    "  deploy    Change the org's configuration and code: objects, fields, flows, Apex, layouts,",
    "            permission sets as metadata. project delete source removes components.",
    "            Worst case: breaks automation, or deletes a field and with it its data.",
    "            Typical: allow on dev and scratch orgs; ask on shared sandboxes; deny on production.",
    "            Commands: project deploy start/quick/resume, project delete source,",
    "            force source push/deploy/delete, force mdapi deploy",
    "",
    "  data      Create, change or delete records (Accounts, Cases, ...), including bulk imports.",
    "            Worst case: mass update or delete of business data; redeploying does not undo it.",
    "            Typical: allow on demo and scratch orgs; ask on sandboxes with real data;",
    "            deny on production.",
    "            Commands: data create/update/delete/upsert/import/bulk/tree,",
    "            api request rest (non-GET), api request graphql, sfdmu",
    "",
    "  execute   Run code in the org. Anonymous Apex runs as the org user and can do anything",
    "            they can, including changing records, so execute=allow is at least as powerful",
    "            as data=allow. Apex tests roll back their own data. Agent previews and test runs",
    "            talk to the agent in the org and may run its actions for real.",
    "            Typical: ask, unless the org's data is disposable.",
    "            Commands: apex run, apex run test, agent preview, agent test run",
    "",
    "  agent     Build and switch Agentforce agents: create one, publish a new version, activate",
    "            or deactivate it. Activating changes what real users or customers talk to.",
    "            Typical: allow on dev orgs; ask or deny where an agent is live.",
    "            Commands: agent create/publish/activate/deactivate, agent test create",
    "",
    "  admin     Who can get in and which orgs exist: assign permission sets, create users, reset",
    "            passwords, install packages, create/delete/refresh sandboxes and scratch orgs,",
    "            publish Experience Cloud sites. Scratch orgs and package versions are checked",
    "            against the Dev Hub org, not the target org.",
    "            Worst case: grants someone access, or deletes or refreshes (wipes) a sandbox.",
    "            Typical: deny; ask on the Dev Hub if the agent should create scratch orgs.",
    "            Commands: org assign permset, org create user/sandbox/scratch, org delete,",
    "            org refresh/resume, org generate password, package install/create/version,",
    "            community create/publish",
    "",
    "  (local)   Never touches an org, so never checked: help, config, alias, org login/logout,",
    "            org list, project generate/convert, apex generate, ...",
    "",
    "SECTIONS",
    "  orgs              per org, keyed by USERNAME (not alias, so re-pointing an alias cannot widen",
    "                    access). \"alias\" and \"note\" are labels only.",
    "  defaultOrgPolicy  applies to any org not listed under orgs",
    "  commands          classify an sf command the guard does not know (otherwise it is denied):",
    "                      \"myplugin run\": \"execute\"",
    "  scripts           project scripts that call sf, with the categories they need:",
    "                      \"scripts/foo.sh\": {\"categories\": [\"read\"], \"orgFlag\": \"-o\", \"defaultOrg\": \"myAlias\"}",
    "",
    "The target org is resolved like the sf CLI does (-o / --target-org, SF_TARGET_ORG, .sf/config.json,",
    "global config). If the guard cannot work out the org or the command, it denies.",
]

# Longest matching prefix wins. "local" means the command never talks to an org.
COMMANDS = {
    # no org involved
    "help": "local", "version": "local", "update": "local", "doctor": "local", "plugins": "local",
    "autocomplete": "local", "commands": "local", "which": "local", "search": "local",
    "info": "local", "whatsnew": "local", "config": "local", "alias": "local", "env list": "local",
    "org login": "local", "org logout": "local", "org list": "local", "org list auth": "local",
    "org enable tracking": "local", "org disable tracking": "local",
    "project generate": "local", "project convert": "local", "project list ignored": "local",
    "apex generate": "local", "lightning generate": "local", "visualforce generate": "local",
    "static-resource generate": "local", "analytics generate": "local", "schema generate": "local",
    "agent generate test-spec": "local", "template": "local", "dev": "local",
    "code-analyzer": "local", "scanner": "local",
    # read
    "org display": "read", "org open": "read", "org list metadata": "read",
    "org list metadata-types": "read", "org list users": "read", "org list limits": "read",
    "org list sobject": "read", "limits": "read", "sobject": "read",
    "project retrieve": "read", "project deploy preview": "read", "project deploy report": "read",
    "project reset tracking": "read", "project delete tracking": "read",
    "data query": "read", "data get": "read", "data export": "read", "data search": "read",
    "data resume": "read", "data bulk results": "read",
    "apex get": "read", "apex list": "read", "apex tail": "read",
    "agent generate": "read", "agent validate": "read", "agent list": "read",
    "agent test list": "read", "agent test results": "read", "agent test resume": "read",
    "package list": "read", "package installed list": "read", "package version list": "read",
    "community list": "read", "lightning dev": "read",
    "retrieve metadata": "read",
    # validate (check-only)
    "project deploy validate": "validate",
    # deploy
    "project deploy": "deploy", "project delete source": "deploy", "deploy metadata": "deploy",
    # data
    "data": "data", "api request graphql": "data", "sfdmu": "data",
    # execute
    "apex run": "execute", "agent preview": "execute", "agent test": "execute",
    # agent
    "agent publish": "agent", "agent activate": "agent", "agent deactivate": "agent",
    "agent create": "agent", "agent test create": "agent",
    # admin
    "org assign": "admin", "org create": "admin", "org delete": "admin", "org resume": "admin",
    "org refresh": "admin", "org generate password": "admin", "package": "admin",
    "community": "admin",
    # legacy sfdx (force:...)
    "force source deploy": "deploy", "force source push": "deploy", "force source delete": "deploy",
    "force mdapi deploy": "deploy", "force source retrieve": "read", "force source pull": "read",
    "force mdapi retrieve": "read", "force data soql": "read", "force data record get": "read",
    "force data": "data", "force apex execute": "execute", "force apex test run": "execute",
    "force org open": "read", "force org display": "read", "force org list": "local",
    "force auth": "local", "force config": "local", "force alias": "local",
}

# commands whose org is the Dev Hub, not the target org
DEV_HUB_COMMANDS = ["org create scratch", "package create", "package version"]

TARGET_FLAGS = {"-o", "--target-org", "--targetusername", "--target-username"}
DEV_HUB_FLAGS = {"-v", "--target-dev-hub", "--targetdevhubusername"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
INTERPRETERS = {"python", "python3", "node", "ruby", "perl", "deno", "bun"}
WRAPPERS = {"time", "nohup", "command", "exec", "nice", "caffeinate", "builtin", "noglob"}
READ_ONLY = {"cat", "head", "tail", "less", "more", "grep", "egrep", "rg", "jq", "ls", "wc",
             "diff", "file", "stat", "bat", "code", "open"}
SF_HINT = re.compile(r"\bsf(dx)?\b|@salesforce/cli")


class Blocked(Exception):
    """Raised for anything the guard cannot verify; always results in deny."""


# ---------------------------------------------------------------- project


def find_project_root(cwd):
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return Path(env).resolve()
    d = Path(cwd).resolve()
    for folder in [d, *d.parents]:
        if (folder / "sfdx-project.json").exists() or (folder / ".claude" / "org-policy.json").exists():
            return folder
    return d


def set_project(root):
    global PROJECT_ROOT, POLICY_PATH
    PROJECT_ROOT = Path(root).resolve()
    POLICY_PATH = PROJECT_ROOT / ".claude" / "org-policy.json"


def project_has_own_guard():
    """A project that registers its own copy of the guard keeps it; this copy then only protects files."""
    own = PROJECT_ROOT / ".claude" / "hooks" / HOOK_PATH.name
    if not own.exists() or own.resolve() == HOOK_PATH:
        return False
    for name in ("settings.json", "settings.local.json"):
        try:
            if HOOK_PATH.name in (PROJECT_ROOT / ".claude" / name).read_text():
                return True
        except OSError:
            pass
    return False


def init_command():
    return f"! python3 {HOOK_PATH} --init"


# ---------------------------------------------------------------- policy


def empty_policy():
    return {"orgs": {}, "defaultOrgPolicy": {}, "scripts": {}, "commands": {}}


def load_policy():
    """Returns the project policy, or None when the project has none."""
    if not POLICY_PATH.exists():
        return None
    try:
        policy = json.loads(POLICY_PATH.read_text())
    except Exception as e:  # broken policy: nothing is allowed
        raise Blocked(f"org policy {POLICY_PATH} is invalid JSON ({e})")
    for k, v in empty_policy().items():
        policy.setdefault(k, v)
    return policy


def load_aliases():
    aliases = {}
    for p in (HOME / ".sfdx" / "alias.json", HOME / ".sf" / "alias.json"):
        try:
            aliases.update(json.loads(p.read_text()).get("orgs", {}))
        except Exception:
            pass
    return aliases


def to_username(org, aliases):
    if "@" in org:
        return org.lower()
    if org in aliases:
        return aliases[org].lower()
    raise Blocked(f"org '{org}' is not a known alias or username, so its policy cannot be checked")


def org_label(username, policy):
    entry = policy["orgs"].get(username) or {}
    return f"{entry['alias']} ({username})" if entry.get("alias") else username


def decide(username, category, policy):
    entry = policy["orgs"].get(username)
    if entry is None:
        entry = policy["defaultOrgPolicy"]
    d = entry.get(category, "deny")
    return d if d in RANK else "deny"


# ---------------------------------------------------------------- org resolution


def read_json_key(path, key):
    try:
        return json.loads(Path(path).read_text()).get(key)
    except Exception:
        return None


def configured_org(cwd, dev_hub=False):
    key_sf, key_sfdx = ("target-dev-hub", "defaultdevhubusername") if dev_hub else ("target-org", "defaultusername")
    d = Path(cwd).resolve()
    for folder in [d, *d.parents]:
        for path, key in ((folder / ".sf" / "config.json", key_sf), (folder / ".sfdx" / "sfdx-config.json", key_sfdx)):
            v = read_json_key(path, key)
            if v:
                return v, str(path)
    for path, key in ((HOME / ".sf" / "config.json", key_sf), (HOME / ".sfdx" / "sfdx-config.json", key_sfdx)):
        v = read_json_key(path, key)
        if v:
            return v, str(path)
    return None, None


def expand(value, env):
    """Expand $VAR / ${VAR} from variables set earlier in the same command; refuse anything else dynamic."""
    def sub(m):
        name = m.group(1) or m.group(2)
        if name in env:
            return env[name]
        raise Blocked(f"org comes from ${name}, which the guard cannot resolve; pass a literal alias")
    out = re.sub(r"\$\{(\w+)\}|\$(\w+)", sub, value)
    if "$" in out or "`" in out:
        raise Blocked(f"org value '{value}' is dynamic; pass a literal alias")
    return out


def flag_value(args, flags, allow_u):
    for i, a in enumerate(args):
        if a in flags or (allow_u and a == "-u"):
            if i + 1 < len(args):
                return args[i + 1]
            raise Blocked(f"{a} given without a value")
        for f in flags:
            if f.startswith("--") and a.startswith(f + "="):
                return a.split("=", 1)[1]
    return None


# ---------------------------------------------------------------- shell parsing


def strip_heredocs(command, ctx, findings):
    """Remove heredoc bodies; bodies fed to a shell are analysed as commands, bodies fed to an
    interpreter that mention sf are refused."""
    lines = command.split("\n")
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        m = re.search(r"<<-?\s*(['\"]?)([A-Za-z_]\w*)\1", line)
        if not m:
            i += 1
            continue
        delim, body, i = m.group(2), [], i + 1
        while i < len(lines) and lines[i].strip() != delim:
            body.append(lines[i])
            i += 1
        i += 1
        text = "\n".join(body)
        consumer = re.split(r"[;&|(]", line[: m.start()])[-1].split()
        consumer = os.path.basename(consumer[0]) if consumer else ""
        if consumer in SHELLS:
            analyse(text, ctx, findings)
        elif consumer in INTERPRETERS and SF_HINT.search(text):
            raise Blocked(f"a {consumer} heredoc calls sf; the guard cannot check indirect calls")
    return "\n".join(out)


def split_simple_commands(command):
    command = command.replace("\\\n", " ").replace("`", " ; ")
    lex = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError as e:
        raise Blocked(f"could not parse the shell command ({e})")
    cmds, cur, skip_next = [], [], False
    for t in tokens:
        if skip_next:
            skip_next = False
            cur.append(("REDIR", t))
            continue
        if t and set(t) <= set("();|&\n"):
            if cur:
                cmds.append(cur)
            cur = []
        elif t and set(t) <= set("<>&") and ("<" in t or ">" in t):
            skip_next = True
        else:
            cur.append(t)
    if cur:
        cmds.append(cur)
    return cmds


# ---------------------------------------------------------------- analysis


def is_assignment(w):
    return re.match(r"^[A-Za-z_]\w*=", w) is not None


def protected_paths():
    return [str(POLICY_PATH), str(HOOK_PATH.parent) + os.sep, str(PROJECT_ROOT / ".claude" / "hooks") + os.sep,
            str(PROJECT_ROOT / ".claude" / "settings.json"), str(PROJECT_ROOT / ".claude" / "settings.local.json")]


def is_protected(path, cwd):
    p = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))
    if any(p == x or (x.endswith(os.sep) and p.startswith(x)) for x in protected_paths()):
        return True
    return bool(re.search(r"/\.claude[\w-]*/settings(\.local)?\.json$|managed-settings\.json$"
                          r"|/\.claude/org-policy\.json$", p))


def mentions_protected(word, cwd):
    return any(k in word for k in ("org-policy.json", "sf-org-guard", "settings.json", "settings.local.json",
                                   "hooks")) and is_protected(word, cwd)


def analyse(command, ctx, findings):
    if not SF_HINT.search(command) and not any(k in command for k in (
            "org-policy", "sf-org-guard", "settings", ".claude", "hooks", *ctx["policy"]["scripts"].keys())):
        return
    command = strip_heredocs(command, ctx, findings)
    for raw in split_simple_commands(command):
        redirect_targets = [t[1] for t in raw if isinstance(t, tuple)]
        words = [t for t in raw if not isinstance(t, tuple)]
        for target in redirect_targets:
            if is_protected(target, ctx["cwd"]):
                raise Blocked(f"writing to {target} is reserved for a human")
        analyse_simple(words, ctx, findings)


def analyse_simple(words, ctx, findings):
    local_env = {}
    while words and is_assignment(words[0]):
        k, v = words[0].split("=", 1)
        local_env[k] = v
        words = words[1:]
    if not words:
        ctx["vars"].update(local_env)  # plain `ORG=myAlias`
        return
    cmd = os.path.basename(words[0])
    args = words[1:]

    if cmd == "export":
        for a in args:
            if is_assignment(a):
                k, v = a.split("=", 1)
                ctx["vars"][k] = v
                ctx["exported"][k] = v
        return
    if cmd == "cd":
        target = args[0] if args else str(HOME)
        if "$" in target or target == "-":
            ctx["cwd_unknown"] = True
        else:
            ctx["cwd"] = os.path.realpath(os.path.join(ctx["cwd"], os.path.expanduser(target)))
        return
    if cmd in WRAPPERS or cmd == "sudo":
        return analyse_simple([*[f"{k}={v}" for k, v in local_env.items()], *args], ctx, findings)
    if cmd == "timeout":
        rest = [a for a in args if not a.startswith("-")]
        return analyse_simple(rest[1:], ctx, findings)
    if cmd == "env":
        rest = list(args)
        while rest and (rest[0].startswith("-") or is_assignment(rest[0])):
            if rest[0] in ("-u", "-C", "-S"):
                raise Blocked(f"env {rest[0]} is not supported by the guard")
            if is_assignment(rest[0]):
                k, v = rest[0].split("=", 1)
                local_env[k] = v
            rest = rest[1:]
        return analyse_simple([*[f"{k}={v}" for k, v in local_env.items()], *rest], ctx, findings)
    if cmd == "xargs":
        rest = [a for a in args if not a.startswith("-")]
        if any(SF_HINT.search(a) for a in args):
            raise Blocked("sf behind xargs cannot be checked; run the sf commands directly")
        return analyse_simple(rest, ctx, findings)
    if cmd == "eval":
        return analyse(" ".join(args), ctx, findings)
    if cmd in SHELLS:
        if "-c" in args:
            i = args.index("-c")
            if i + 1 < len(args):
                return analyse(args[i + 1], ctx, findings)
        script = next((a for a in args if not a.startswith("-")), None)
        if script:
            return analyse_script(script, args[args.index(script) + 1:], local_env, ctx, findings)
        return
    if cmd in (".", "source") and args:
        return analyse_script(args[0], args[1:], local_env, ctx, findings)
    if cmd in INTERPRETERS or re.match(r"python3?\.\d+$", cmd):
        if any(a in ("-c", "-e", "--eval", "-p") for a in args) and SF_HINT.search(" ".join(args)):
            raise Blocked(f"inline {cmd} code calls sf; the guard cannot check indirect calls")
        if cmd.startswith("python") and args[:2] == ["-m", "json.tool"]:
            return
        script = next((a for a in args if not a.startswith("-")), None)
        if script and mentions_protected(script, ctx["cwd"]) and HOOK_PATH.name in script:
            if set(args[1:2]) <= {"--show", "--check"} and args[1:2]:
                return  # read-only modes of this guard
            raise Blocked("changing the org policy is reserved for a human")
        if script:
            return analyse_script(script, args[args.index(script) + 1:], local_env, ctx, findings)
        return
    if cmd in ("npx", "pnpx", "bunx") or (cmd in ("npm", "pnpm", "yarn") and args[:1] == ["exec"]):
        rest = args[1:] if cmd in ("npm", "pnpm", "yarn") else args
        while rest and rest[0].startswith("-"):
            rest = rest[1:]
        if rest and (rest[0] in ("sf", "sfdx") or rest[0].startswith("@salesforce/cli")):
            return analyse_sf("sfdx" if rest[0] == "sfdx" else "sf", rest[1:], local_env, ctx, findings)
        return
    if cmd in ("sf", "sfdx"):
        return analyse_sf(cmd, args, local_env, ctx, findings)

    # anything else: guard protected files, then check known scripts
    for w in words:
        if mentions_protected(w, ctx["cwd"]):
            if cmd in READ_ONLY or (cmd == "git" and args[:1] and args[0] in (
                    "add", "commit", "diff", "log", "show", "status", "blame")):
                continue
            raise Blocked(f"'{cmd}' on {w} is reserved for a human")
    if "/" in words[0]:
        analyse_script(words[0], args, local_env, ctx, findings)


def analyse_script(script, args, local_env, ctx, findings):
    if mentions_protected(script, ctx["cwd"]):
        raise Blocked(f"running {script} is reserved for a human")
    if not ctx["check_orgs"]:
        return
    real = os.path.realpath(os.path.join(ctx["cwd"], script))
    for rel, rule in ctx["policy"]["scripts"].items():
        if real != str((PROJECT_ROOT / rel).resolve()):
            continue
        org = flag_value(args, {rule["orgFlag"]}, False) or rule.get("defaultOrg")
        if not org:
            raise Blocked(f"{rel} has no org flag or defaultOrg in the policy")
        org = expand(org, {**ctx["vars"], **local_env})
        for cat in rule.get("categories", ["admin"]):
            findings.append({"what": rel, "category": cat, "org": org, "source": rule["orgFlag"] + " / script default"})


def classify(words, flags, overrides):
    table = {**COMMANDS, **overrides}
    key = " ".join(words)
    best = None
    for prefix in table:
        if key == prefix or key.startswith(prefix + " "):
            if best is None or len(prefix) > len(best):
                best = prefix
    if best is None:
        return None, key
    cat = table[best]
    if best == "project deploy" and words[:3] == ["project", "deploy", "start"] and "--dry-run" in flags:
        cat = "validate"
    return cat, key


def analyse_sf(cmd, args, local_env, ctx, findings):
    if not ctx["check_orgs"]:
        return
    words, i = [], 0
    while i < len(args) and not args[i].startswith("-"):
        words.extend(p for p in args[i].split(":") if p)
        i += 1
    flags = args[i:]
    words = [w.lower() for w in words]
    if not words or any(f in ("-h", "--help") for f in flags):
        return
    if words[0] == "api" and words[1:3] == ["request", "rest"]:
        method = (flag_value(flags, {"-X", "--method"}, False) or "GET").upper()
        category, key = ("read" if method == "GET" else "data"), " ".join(words)
    else:
        category, key = classify(words, flags, ctx["policy"]["commands"])
    what = f"{cmd} {key}"
    if category is None:
        raise Blocked(f"'{what}' is not a known sf command; a human can classify it under \"commands\" "
                      f"in .claude/org-policy.json")
    if category == "local":
        return
    if category not in CATEGORIES:
        raise Blocked(f"'{what}' is mapped to unknown category '{category}'")

    dev_hub = any(key == p or key.startswith(p + " ") for p in DEV_HUB_COMMANDS)
    legacy_u = cmd == "sfdx" or words[0] == "force" or words[0] != "agent"
    env = {**ctx["exported"], **local_env}
    if dev_hub:
        org, source = flag_value(flags, DEV_HUB_FLAGS, False), "--target-dev-hub"
        if org is None:
            org = env.get("SF_TARGET_DEV_HUB") or env.get("SFDX_DEFAULTDEVHUBUSERNAME")
            source = "environment"
    else:
        org, source = flag_value(flags, TARGET_FLAGS, legacy_u), "--target-org"
        if org is None:
            org = env.get("SF_TARGET_ORG") or env.get("SFDX_DEFAULTUSERNAME")
            source = "environment"
    if org is None:
        name = "SF_TARGET_DEV_HUB" if dev_hub else "SF_TARGET_ORG"
        if os.environ.get(name):
            org, source = os.environ[name], f"${name}"
    if org is None:
        if ctx["cwd_unknown"]:
            raise Blocked("the command changes to a directory the guard cannot resolve, so the default org is unknown")
        org, source = configured_org(ctx["cwd"], dev_hub)
        if org is None:
            raise Blocked(f"'{what}' has no target org and no default is configured")
        source = f"default from {source}"
    org = expand(org, {**ctx["vars"], **local_env})
    findings.append({"what": what, "category": category, "org": org, "source": source})


# ---------------------------------------------------------------- entry points


def evaluate(command, cwd):
    """Returns (decision, reason)."""
    problem = None
    try:
        policy = load_policy()
        if policy is None:
            problem = (f"this project has no org policy ({POLICY_PATH}), so no sf command may touch an org. "
                       f"Do not work around this; ask the human to run:  {init_command()}")
    except Blocked as e:
        policy, problem = None, f"{e}. Ask the human to fix it."
    ctx = {"policy": policy or empty_policy(), "cwd": cwd, "cwd_unknown": False, "vars": {}, "exported": {},
           "check_orgs": not project_has_own_guard()}
    findings = []
    try:
        analyse(command, ctx, findings)
    except Blocked as e:
        return "deny", f"sf-org-guard: {e}"
    if not findings:
        return "allow", ""
    if problem:
        return "deny", f"sf-org-guard: {problem}"
    aliases = load_aliases()
    worst, lines = "allow", []
    for f in findings:
        try:
            user = to_username(f["org"], aliases)
        except Blocked as e:
            return "deny", f"sf-org-guard: {e}"
        d = decide(user, f["category"], policy)
        worst = d if RANK[d] > RANK[worst] else worst
        lines.append(f"{f['what']} -> {org_label(user, policy)} [{f['category']}: {d.upper()}] (org via {f['source']})")
    reason = "sf-org-guard: " + "; ".join(lines)
    if worst == "deny":
        reason += (f". Blocked by {POLICY_PATH}. Do not work around this; ask the human to change the "
                   "policy if the action is intended.")
    return worst, reason


def guard_file_tool(tool_input, cwd):
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if path and is_protected(path, cwd):
        return "deny", f"sf-org-guard: {path} is guard configuration and is reserved for a human to edit."
    return "allow", ""


def read_hook_input():
    data = json.load(sys.stdin)
    cwd = data.get("cwd") or os.getcwd()
    set_project(find_project_root(cwd))
    return data, cwd


def run_hook():
    try:
        data, cwd = read_hook_input()
        tool, tool_input = data.get("tool_name", ""), data.get("tool_input") or {}
        if tool == "Bash":
            decision, reason = evaluate(tool_input.get("command", ""), cwd)
        elif tool in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
            decision, reason = guard_file_tool(tool_input, cwd)
        else:
            return 0
    except Exception as e:  # fail closed: exit 2 blocks the tool call
        print(f"sf-org-guard crashed, blocking to be safe: {e!r}", file=sys.stderr)
        return 2
    if decision == "allow":
        return 0
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": decision, "permissionDecisionReason": reason}}))
    return 0


def session_start():
    """In a Salesforce project without a usable policy, tell the agent to ask the human for one first."""
    try:
        read_hook_input()
    except Exception:
        set_project(find_project_root(os.getcwd()))
    if project_has_own_guard() or not (PROJECT_ROOT / "sfdx-project.json").exists():
        return 0
    try:
        if load_policy() is not None:
            return 0
        problem = f"has no org policy ({POLICY_PATH})"
    except Blocked as e:
        problem = f"has a broken org policy: {e}"
    context = (
        f"This Salesforce project {problem}. Until a human creates it, sf-org-guard blocks every sf command "
        f"that touches an org. Before starting other work, ask the human in one short line to run "
        f"`{init_command()}` and then grant access per org with "
        f"`! python3 {HOOK_PATH} --set <alias> <category>=<allow|ask|deny>` "
        f"(categories: {', '.join(CATEGORIES)}; `all=` sets every category). "
        f"You cannot create or edit the policy yourself; do not try to work around the block.")
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": context}}))
    return 0


def show():
    policy, aliases = load_policy(), load_aliases()
    if policy is None:
        sys.exit(f"no org policy for {PROJECT_ROOT}; create one with:  python3 {HOOK_PATH} --init")
    print(f"policy: {POLICY_PATH}")
    by_user = {}
    for alias, user in aliases.items():
        by_user.setdefault(user.lower(), []).append(alias)
    rows = [(e.get("alias") or ",".join(by_user.get(u, [])) or "-", u, e) for u, e in policy["orgs"].items()]
    rows.append(("(any other org)", "", policy["defaultOrgPolicy"]))
    w = max(len(r[0]) for r in rows)
    print(f"{'org':<{w}}  " + "  ".join(f"{c:<8}" for c in CATEGORIES) + "  username")
    for alias, user, e in rows:
        print(f"{alias:<{w}}  " + "  ".join(f"{e.get(c, 'deny'):<8}" for c in CATEGORIES) + f"  {user}")


def add_org(policy, org, aliases):
    user = to_username(org, aliases)
    entry = policy["orgs"].setdefault(user, {c: "deny" for c in CATEGORIES})
    if "@" not in org:
        entry.setdefault("alias", org)
    return entry


def init_policy(orgs):
    if POLICY_PATH.exists():
        sys.exit(f"{POLICY_PATH} already exists; change it with --set")
    if not (PROJECT_ROOT / "sfdx-project.json").exists():
        print(f"note: {PROJECT_ROOT} has no sfdx-project.json; creating the policy here anyway")
    aliases = load_aliases()
    policy = {"_readme": README, **empty_policy(), "defaultOrgPolicy": {c: "deny" for c in CATEGORIES}}
    default_org, _ = configured_org(PROJECT_ROOT)
    if default_org:
        try:
            add_org(policy, default_org, aliases)["note"] = "project default org"
        except Blocked as e:
            print(f"note: skipping the default org: {e}")
    for org in orgs:
        add_org(policy, org, aliases)
    POLICY_PATH.parent.mkdir(parents=True, exist_ok=True)
    POLICY_PATH.write_text(json.dumps(policy, indent=2) + "\n")
    show()
    print(f"\nEvery org starts at deny. Grant access with:\n"
          f"  python3 {HOOK_PATH} --set <alias> read=allow validate=allow deploy=ask ...")


def set_policy(org, assignments):
    policy, aliases = load_policy(), load_aliases()
    if policy is None:
        sys.exit(f"no org policy for {PROJECT_ROOT}; create one first with:  python3 {HOOK_PATH} --init")
    entry = add_org(policy, org, aliases)
    for a in assignments:
        cat, _, dec = a.partition("=")
        cats = CATEGORIES if cat == "all" else [cat]
        if any(c not in CATEGORIES for c in cats) or dec not in DECISIONS:
            sys.exit(f"bad assignment '{a}': use <{'|'.join(CATEGORIES)}|all>=<{'|'.join(DECISIONS)}>")
        for c in cats:
            entry[c] = dec
    policy = {"_readme": README, **{k: v for k, v in policy.items() if k != "_readme"}}
    POLICY_PATH.write_text(json.dumps(policy, indent=2) + "\n")
    show()


def main(argv):
    if not argv:
        return run_hook()
    if argv[0] == "--session-start":
        return session_start()
    cwd = os.getcwd()
    if "--cwd" in argv:
        i = argv.index("--cwd")
        cwd = argv[i + 1]
        argv = argv[:i] + argv[i + 2:]
    set_project(find_project_root(cwd))
    try:
        if argv[0] == "--show":
            show()
        elif argv[0] == "--check" and len(argv) >= 2:
            decision, reason = evaluate(argv[1], cwd)
            print(decision.upper(), reason)
        elif argv[0] == "--init":
            init_policy(argv[1:])
        elif argv[0] == "--set" and len(argv) >= 3:
            set_policy(argv[1], argv[2:])
        else:
            print(__doc__)
            return 1
    except Blocked as e:
        sys.exit(str(e))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
