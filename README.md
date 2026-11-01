# Skipper org policy hook

A Claude Code hook that decides which Salesforce orgs an AI agent may touch, and what it may do there. You
write the rules per project in `.claude/org-policy.json`. The hook enforces them on every command the agent
runs, so it doesn't depend on the model remembering or obeying instructions.

Example: let the agent deploy freely to your dev sandbox, ask you before it touches data in UAT, and block
it from changing anything in production.

## How it works

1. Before every Bash command, Claude Code runs the hook. The hook finds every `sf` / `sfdx` call in the
   command, including ones inside `bash -c`, `eval`, `$(...)`, `npx`, `env` and heredocs, and calls from
   project scripts you list in the policy.
2. Each call is sorted into a **category** (read, validate, deploy, data, delete, execute).
3. It works out the **target org** the same way the sf CLI does: `-o` / `--target-org`, `SF_TARGET_ORG`,
   the project's `.sf/config.json`, then the global config. The alias is turned into a username.
4. The policy for that username and category gives the **decision**: `allow`, `ask` or `deny`.

If the hook can't work out the command or the org, it denies. It fails closed.

The hook also stops the agent from editing the policy file, the hook itself, and the Claude Code settings
that register it, so the agent can't widen its own access by mistake.

## Install

Requires the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) and Claude Code. Nothing
else: the hook is plain JavaScript and runs on the Node.js that ships with the Salesforce CLI, so you don't
need to install Python or Node.js yourself.

```sh
git clone <this repo> skipper-org-policy-hook
cd skipper-org-policy-hook
sh install.sh
```

(No git? Download the repo as a ZIP, unzip it, and run `sh install.sh` in that folder.)

This copies `sf-org-guard.js` to `~/.claude/hooks/` (or `$CLAUDE_CONFIG_DIR/hooks/` if you use a custom
config dir, or pass `--config-dir DIR`), next to a small `sf-org-guard` launcher that runs it with the
Salesforce CLI's Node.js (or any `node` on your PATH). It adds to `settings.json`:

- a **SessionStart** hook: in a Salesforce project without a policy, the agent asks you to create one
- a **PreToolUse** hook on Bash, Edit, Write, MultiEdit and NotebookEdit: does the actual checking
- **deny rules** so the agent can't edit the hook, your settings or `.claude/org-policy.json`

Your old settings are saved as `settings.json.bak`. Restart Claude Code afterwards.

**Updating:** `git pull && sh install.sh`. Running it again replaces the hook and leaves settings that are
already there alone. If you had the earlier Python version installed, it replaces that too.

## Set up a project

Run these yourself in the project folder (in Claude Code, type them with a `!` in front):

```sh
~/.claude/hooks/sf-org-guard --init                    # creates .claude/org-policy.json, all deny
~/.claude/hooks/sf-org-guard --set DevSandbox read=allow validate=allow deploy=allow data=ask
~/.claude/hooks/sf-org-guard --set Production read=ask
~/.claude/hooks/sf-org-guard --show                    # see the result as a table
```

`--init` adds the project's default org (from `.sf/config.json`) with everything on deny. `--set` accepts an
alias or a username, adds the org if it isn't there yet, and takes `all=<decision>` to set every category
at once.

Until a project has a policy, the agent can't reach any org from it.

Commit `.claude/org-policy.json` if the whole team should share the same rules. Orgs are listed by
username, which differs per person, so each colleague usually adds their own orgs with `--set`.

To see what the hook would do with a command, without running it:

```sh
~/.claude/hooks/sf-org-guard --check "sf project deploy start -o UAT"
```

## Decisions

Each org gets one decision per category.

| Decision | What happens |
|---|---|
| `allow` | The hook steps aside. Claude Code's normal permission rules still apply. |
| `ask` | You're prompted for every such command, even if it's allow-listed or you're in auto mode. |
| `deny` | Blocked. The agent is told why and not to work around it. |

A missing category or an unknown value counts as `deny`. If one command line hits several orgs or
categories, the strictest decision wins.

## Categories

Every sf command belongs to one category. A command that deletes something also needs **delete**, on top
of its own category. The "Typical" column is a suggestion, so set what fits the org.

| Category | What it lets the agent do | Worst case | Typical |
|---|---|---|---|
| **read** | Look, don't touch: see metadata, query records, retrieve source into the project. | Sees data it shouldn't (`data export` can dump whole objects). `org display --verbose` and `org open` hand out a logged-in session. | allow on sandboxes and dev orgs; ask on production |
| **validate** | Dry-run a deploy: the org compiles the metadata and may run tests, then rolls everything back. | Long test runs. Nothing is saved. | allow wherever deploy is allow or ask, production included |
| **deploy** | Change the org's setup: objects, fields, flows, Apex, layouts, permission sets and who has them. Also Agentforce agents, packages and Experience Cloud sites. | Breaks automation, grants someone access, or activates an agent that real users or customers talk to. | allow on dev and scratch orgs; ask on shared sandboxes; deny on production |
| **data** | Create or change records (Accounts, Cases, …), including bulk imports. | A mass update overwrites business data. Redeploying doesn't undo it. | allow on demo and scratch orgs; ask on sandboxes with real data; deny on production |
| **delete** | An extra check on anything that deletes: records, metadata, packages, or a whole sandbox or scratch org. | Deleting a field or object takes its data with it. A deleted or refreshed sandbox is gone. | ask on scratch orgs and personal dev sandboxes; deny elsewhere |
| **execute** | Run code in the org: anonymous Apex, Apex tests, agent previews and agent test runs. | Anonymous Apex can do anything the org user can, including changing and deleting records, so this is at least as powerful as **data** and **delete**. Agent previews and tests may run the agent's actions for real. | ask, unless the org's data is disposable |

Which commands fall where:

| Category | Commands |
|---|---|
| read | `data query/get/search/export`, `project retrieve`, `org display/open/list`, `sobject describe`, `apex list/get/tail log`, `agent list/validate/generate`, `package list`, `api request rest` (GET) |
| validate | `project deploy validate`, `project deploy start --dry-run` |
| deploy | `project deploy start/quick/resume`, `force source push/deploy`, `force mdapi deploy`, `org assign permset`, `org create user`, `org generate password`, `package install/create/version`, `agent create/publish/activate/deactivate`, `agent test create`, `community create/publish` |
| data | `data create/update/upsert/import/bulk/tree`, `api request rest` (POST/PUT/PATCH), `api request graphql`, `sfdmu` |
| execute | `apex run`, `apex run test`, `agent preview`, `agent test run` |
| *(local)* | Never touch an org, so never checked: `help`, `config`, `alias`, `org login/logout`, `org list`, `project generate/convert`, `apex generate`, … |

### Delete

These need **delete** as well as the category shown, and the strictest of the two wins:

| Command | Needs |
|---|---|
| `data delete record/bulk`, `api request rest -X DELETE` | data + delete |
| `project delete source`, `force source delete` | deploy + delete |
| a deploy with `--pre-destructive-changes` / `--post-destructive-changes`, or with a `destructiveChanges.xml` in the deploy folder | deploy + delete |
| `package uninstall`, `package delete`, `package version delete` | deploy + delete |
| `org delete sandbox/scratch` | delete, on the org being deleted |
| `org refresh sandbox` (wipes the sandbox) | delete, on the production org it runs against |

Overwriting values with `data update`, `upsert` or `import` is **data**, not delete.

Delete only catches deletes it can see in the command. These count as their own category only:

- a file you deleted locally is deleted in the org by the next `project deploy start` with source tracking
  (deploy)
- `apex run` can delete records (execute)
- `sfdmu` can be configured to delete (data)
- a deploy from a `.zip`, or `project deploy quick` of a validation that included deletes (deploy)

### Fixed rules

These aren't settings. They're the same in every org:

| Command | Decision |
|---|---|
| `org create sandbox`, `org resume sandbox` | always deny: a human creates sandboxes |
| `org create scratch`, `org resume scratch` | always ask |

Package versions are checked against the **Dev Hub** org (`-v` / `--target-dev-hub`), not the target
org.

The full mapping is the `COMMANDS` table in `sf-org-guard.js`, where the longest matching command prefix
wins.

## The policy file

See [`examples/org-policy.json`](examples/org-policy.json) for a complete example.

| Section | Purpose |
|---|---|
| `orgs` | One entry per org, keyed by **username**, not alias, so pointing an alias at another org can't widen access. `alias` and `note` are labels only. |
| `defaultOrgPolicy` | Applies to any org not listed under `orgs`. `--init` sets it to all deny. |
| `commands` | Classifies sf commands the hook doesn't know (from plugins, say). Unknown commands are denied. Example: `"myplugin run": "execute"` |
| `scripts` | Project scripts that call sf internally. The hook can't see inside them, so you declare what they do: `"scripts/load.sh": {"categories": ["data"], "orgFlag": "-o", "defaultOrg": "DevSandbox"}` |
| `_readme` | Explanation written by the hook. `--set` refreshes it. |

## Limits

This is a guardrail against mistakes, not a security sandbox.

- It checks `sf` / `sfdx` calls. An agent that reaches Salesforce some other way, such as `curl` with an
  access token or a script you haven't listed under `scripts`, isn't covered. It does refuse inline
  `python -c` / `node -e` code and heredocs that mention sf.
- The file protection matches known paths and names. A script that writes the policy file isn't inspected.
  For stronger guarantees, combine the hook with Claude Code's own permission rules or a managed settings
  file.
- `org display --verbose` (read) prints an access token. Keep production on `read=ask` if that matters.

## Uninstall

Remove the two `sf-org-guard` entries under `hooks` and the related `permissions.deny` rules from your
Claude Code `settings.json`, then delete `~/.claude/hooks/sf-org-guard` and `~/.claude/hooks/sf-org-guard.js`.

Windows: untested. Claude Code on Windows runs hooks through Git Bash, so `sh install.sh` from Git Bash
should work, but nobody has tried it yet.
