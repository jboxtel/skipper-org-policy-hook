#!/usr/bin/env node
/*
Install or update the Skipper org policy hook for Claude Code. Run it through install.sh, which finds a
Node.js to run it with (the one that ships with the Salesforce CLI will do).

Copies sf-org-guard.js into <config dir>/hooks/, writes the sf-org-guard launcher next to it (it runs the
hook with the Node.js this installer runs on), and registers it in <config dir>/settings.json
(SessionStart + PreToolUse hooks, plus deny rules so the agent cannot edit the hook or settings).
The config dir is $CLAUDE_CONFIG_DIR if set, else ~/.claude; override with --config-dir DIR.
Safe to run again: it replaces the hook files and skips settings that are already there. Hooks left
by the old Python version (sf-org-guard.py) are replaced.
*/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = 'sf-org-guard';
const SOURCE = path.join(__dirname, `${GUARD}.js`);
const HOME = os.homedir();

function configDir(argv) {
  const i = argv.indexOf('--config-dir');
  const dir = i >= 0 ? argv[i + 1] : process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
  return path.resolve(dir.replace(/^~(?=\/|$)/, HOME));
}

function relativeToHome(p) {
  const rel = path.relative(HOME, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
}

/** $HOME/... when possible, so the settings file reads the same on every machine. */
function shellPath(p) {
  const rel = relativeToHome(p);
  return rel ? `$HOME/${rel}` : p;
}

function tildePath(p) {
  const rel = relativeToHome(p);
  return rel ? `~/${rel}` : p;
}

/** Permission rules read /x as relative to the settings file; absolute paths need //x. */
function rulePath(p) {
  const t = tildePath(p);
  return t.startsWith('~') ? t : '/' + t;
}

function launcher(node) {
  return `#!/bin/sh
# Skipper org policy hook launcher, written by install.sh. Runs sf-org-guard.js with the Node.js found
# at install time, or any node on the PATH if that one is gone.
NODE='${node.replace(/'/g, "'\\''")}'
[ -x "$NODE" ] || NODE=node
exec "$NODE" "$(dirname "$0")/${GUARD}.js" "$@"
`;
}

/** Drops hook entries of the old Python version; reports whether one of ours is still registered. */
function cleanGuard(entries) {
  for (const e of entries) e.hooks = (e.hooks || []).filter((h) => !(h.command || '').includes(`${GUARD}.py`));
  const kept = entries.filter((e) => e.hooks.length);
  entries.splice(0, entries.length, ...kept);
  return entries.some((e) => e.hooks.some((h) => (h.command || '').includes(GUARD)));
}

function main(argv) {
  if (Number(process.versions.node.split('.')[0]) < 18) {
    console.error(`Node.js 18 or newer is required (found ${process.version} at ${process.execPath})`);
    return 1;
  }
  const cfg = configDir(argv);
  const hooksDir = path.join(cfg, 'hooks');
  const hook = path.join(hooksDir, GUARD);
  const settingsPath = path.join(cfg, 'settings.json');

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(SOURCE, path.join(hooksDir, `${GUARD}.js`));
  fs.writeFileSync(hook, launcher(process.execPath), { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  fs.rmSync(path.join(hooksDir, `${GUARD}.py`), { force: true });
  console.log(`hook installed: ${hook} (runs on Node.js ${process.version}, ${process.execPath})`);

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    fs.copyFileSync(settingsPath, settingsPath.replace(/\.json$/, '.json.bak'));
  }

  const command = `"${shellPath(hook)}"`;
  const hooks = (settings.hooks ??= {});
  const sessionStart = (hooks.SessionStart ??= []);
  if (!cleanGuard(sessionStart)) {
    sessionStart.push({ hooks: [{ type: 'command', command: `${command} --session-start` }] });
  }
  const preToolUse = (hooks.PreToolUse ??= []);
  if (!cleanGuard(preToolUse)) {
    preToolUse.push({ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command }] });
  }

  // Edit(...) rules cover every file-editing tool; Write(...) rules never match, so drop the ones
  // earlier versions of this installer added.
  const permissions = (settings.permissions ??= {});
  const targets = [`${rulePath(hooksDir)}/**`, rulePath(settingsPath), '.claude/org-policy.json'];
  const deny = (permissions.deny ?? []).filter((r) => !targets.some((t) => r === `Write(${t})`));
  for (const target of targets) {
    if (!deny.includes(`Edit(${target})`)) deny.push(`Edit(${target})`);
  }
  permissions.deny = deny;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`settings updated: ${settingsPath}`);
  console.log(`\nRestart Claude Code. Then, in each Salesforce project:\n`
    + `  ${tildePath(hook)} --init\n`
    + `  ${tildePath(hook)} --set <alias> read=allow validate=allow deploy=ask`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
