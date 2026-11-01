#!/usr/bin/env node
/*
Skipper org policy hook: deterministic Salesforce org guard for AI agents (global Claude Code hook,
one copy for all projects). Plain Node.js, no dependencies: it runs on the Node.js that ships with the
Salesforce CLI.

Every Bash command is scanned for `sf` / `sfdx` invocations (also inside `bash -c`, `eval`, `$(...)`,
`npx`, `env`, ...) and for the project scripts listed in the project's .claude/org-policy.json. Each
invocation is classified into a category (read, validate, deploy, data, delete, execute, or local)
and its target org is resolved the same way the sf CLI does: --target-org / -o flag, SF_TARGET_ORG,
project .sf/config.json, global config. The alias is resolved to a username, and the username's policy
decides: allow, ask, or deny. Anything that deletes also needs the delete category. Creating sandboxes
and scratch orgs follows fixed rules instead. Anything it cannot classify or resolve is denied (fail closed).

The policy is per project: <project>/.claude/org-policy.json. A project without one cannot reach any
org; the human creates it with --init. In a Salesforce project (sfdx-project.json) without a policy,
the SessionStart hook tells the agent to ask for that first.

The hook also refuses agent edits to the policy, to the guard itself, and to the Claude settings files
that register it. A project that registers its own copy of this guard keeps it; this global copy then
only protects files.

Usage (sf-org-guard is the launcher the installer puts next to this file):
  (hook)  reads the PreToolUse JSON on stdin
  sf-org-guard --session-start                      SessionStart hook: ask for a missing policy
  sf-org-guard --init [<alias|username> ...]        create the project policy, all deny (human only)
  sf-org-guard --set <alias|username> <category>=<allow|ask|deny> [...]   (human only)
  sf-org-guard --show                               print the project policy per org
  sf-org-guard --check "<command>" [--cwd DIR]      print the decision for a command
*/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD = 'sf-org-guard';
const HOME = os.homedir();
const HOOK_PATH = realpath(__filename);
const LAUNCHER = path.join(path.dirname(HOOK_PATH), GUARD);

function tildePath(p) {
  return isInside(p, HOME) ? '~/' + path.relative(HOME, p) : p;
}

// How a human runs the guard: the installed launcher, or node on this file when run from a checkout.
const CLI = fs.existsSync(LAUNCHER) ? LAUNCHER : `node ${HOOK_PATH}`;
const CLI_DISPLAY = fs.existsSync(LAUNCHER) ? tildePath(LAUNCHER) : `node ${tildePath(HOOK_PATH)}`;

// set by setProject() before anything else runs
let PROJECT_ROOT = process.cwd();
let POLICY_PATH = path.join(PROJECT_ROOT, '.claude', 'org-policy.json');

const CATEGORIES = ['read', 'validate', 'deploy', 'data', 'delete', 'execute'];
// Categories that were merged into another one; older policy files may still name them.
const RENAMED = { agent: 'deploy' };
const ADMIN_GONE = "'admin' no longer exists: users, permission sets and packages are part of deploy; "
  + 'deleting orgs is part of delete; creating sandboxes is always denied and creating scratch orgs always asks';
// Not settings: these always get the same decision, whatever the policy says.
const FIXED = { sandbox: 'deny', scratch: 'ask' };
const DECISIONS = ['allow', 'ask', 'deny'];
const RANK = { allow: 0, ask: 1, deny: 2 };

// Written into every policy file by --init and refreshed by --set, so keep it in sync with COMMANDS.
const README = [
  'Which Salesforce orgs an AI agent may touch in this project, and how. Enforced by the Skipper',
  `org policy hook (${tildePath(HOOK_PATH)}), not by the model. The agent cannot edit`,
  'this file; a human edits it or runs:',
  `  ${CLI_DISPLAY} --set <alias|username> <category>=<allow|ask|deny>`,
  `  ${CLI_DISPLAY} --show            (table of the policy below)`,
  `  ${CLI_DISPLAY} --check "<cmd>"   (what the guard would decide)`,
  '',
  'DECISIONS (one per org per category)',
  '  allow  the guard steps aside; Claude Code\'s normal permission rules still apply',
  '  ask    the human is prompted for every such command, even if it is allow-listed',
  '  deny   blocked; the agent is told not to work around it',
  '  A missing category or an unknown value counts as deny. When one command line touches several',
  '  orgs or categories, the strictest decision wins.',
  '',
  'CATEGORIES: what each one lets the agent do, the worst case, and a typical setting.',
  'Every sf command maps to exactly one; the longest matching command prefix wins.',
  '',
  '  read      Look, don\'t touch: see metadata, query records, pull source into the project.',
  '            Worst case: sees data it shouldn\'t (data export can dump whole objects), and',
  '            org display --verbose / org open hand out a logged-in session.',
  '            Typical: allow on sandboxes and dev orgs; ask on production.',
  '            Commands: data query/get/search/export, project retrieve, org display/open/list,',
  '            sobject describe, apex list/get/tail log, agent list/validate/generate,',
  '            package list, api request rest (GET)',
  '',
  '  validate  Dry-run a deploy: the org compiles the metadata and may run tests, then rolls',
  '            everything back. Worst case: long test runs; nothing is saved.',
  '            Typical: allow wherever deploy is allow or ask, production included.',
  '            Commands: project deploy validate, project deploy start --dry-run',
  '',
  '  deploy    Change the org\'s setup: objects, fields, flows, Apex, layouts, permission sets,',
  '            and who has them. Also Agentforce agents, packages and Experience Cloud sites.',
  '            Worst case: breaks automation, grants someone access, or activates an agent that',
  '            real users or customers talk to.',
  '            Typical: allow on dev and scratch orgs; ask on shared sandboxes; deny on production.',
  '            Commands: project deploy start/quick/resume, force source push/deploy,',
  '            force mdapi deploy, project delete source (also delete), org assign permset, org create user, org generate password,',
  '            package install/create/version, agent create/publish/activate/deactivate,',
  '            agent test create, community create/publish',
  '',
  '  data      Create or change records (Accounts, Cases, ...), including bulk imports.',
  '            Worst case: a mass update overwrites business data; redeploying does not undo it.',
  '            Typical: allow on demo and scratch orgs; ask on sandboxes with real data;',
  '            deny on production.',
  '            Commands: data create/update/upsert/import/bulk/tree,',
  '            api request rest (POST/PUT/PATCH), api request graphql, sfdmu',
  '',
  '  delete    An extra check on anything that deletes: records, metadata, packages, or a whole',
  '            sandbox or scratch org. A command that deletes needs both its own category and',
  '            delete: deleting records needs data and delete, a deploy that removes',
  '            components needs deploy and delete. Deleting or refreshing (wiping) an org',
  '            needs only delete, on the org that is deleted (refresh: the production org).',
  '            Overwriting values (data update/upsert/import) is data, not delete.',
  '            Worst case: deleting a field or object takes its data with it; a deleted or',
  '            refreshed sandbox is gone.',
  '            Typical: ask on scratch orgs and personal dev sandboxes; deny elsewhere.',
  '            Commands: data delete, project delete source, force source delete,',
  '            deploys with --pre/--post-destructive-changes or a destructiveChanges.xml in',
  '            the deploy folder, package uninstall/delete, api request rest -X DELETE,',
  '            org delete sandbox/scratch, org refresh sandbox',
  '            Not caught: deletes the command does not show. A file you deleted locally is',
  '            deleted in the org by the next tracked deploy, anonymous Apex can delete',
  '            records, and sfdmu can be configured to delete. Those count as deploy, execute',
  '            and data.',
  '',
  '  execute   Run code in the org. Anonymous Apex runs as the org user and can do anything',
  '            they can, including changing and deleting records, so execute=allow is at least',
  '            as powerful as data=allow and delete=allow. Apex tests roll back their own data.',
  '            Agent previews and test runs talk to the agent in the org and may run its',
  '            actions for real.',
  '            Typical: ask, unless the org\'s data is disposable.',
  '            Commands: apex run, apex run test, agent preview, agent test run',
  '',
  'FIXED RULES (not settings, the same in every org)',
  '  creating a sandbox      always denied; a human does this (also org resume sandbox)',
  '  creating a scratch org  always asks (also org resume scratch)',
  '',
  '  (local)   Never touches an org, so never checked: help, config, alias, org login/logout,',
  '            org list, project generate/convert, apex generate, ...',
  '',
  'SECTIONS',
  '  orgs              per org, keyed by USERNAME (not alias, so re-pointing an alias cannot widen',
  '                    access). "alias" and "note" are labels only.',
  '  defaultOrgPolicy  applies to any org not listed under orgs',
  '  commands          classify an sf command the guard does not know (otherwise it is denied):',
  '                      "myplugin run": "execute"',
  '  scripts           project scripts that call sf, with the categories they need:',
  '                      "scripts/foo.sh": {"categories": ["read"], "orgFlag": "-o", "defaultOrg": "myAlias"}',
  '',
  'The target org is resolved like the sf CLI does (-o / --target-org, SF_TARGET_ORG, .sf/config.json,',
  'global config). If the guard cannot work out the org or the command, it denies.',
];

// Longest matching prefix wins. "local" means the command never talks to an org.
const COMMANDS = {
  // no org involved
  'help': 'local', 'version': 'local', 'update': 'local', 'doctor': 'local', 'plugins': 'local',
  'autocomplete': 'local', 'commands': 'local', 'which': 'local', 'search': 'local',
  'info': 'local', 'whatsnew': 'local', 'config': 'local', 'alias': 'local', 'env list': 'local',
  'org login': 'local', 'org logout': 'local', 'org list': 'local', 'org list auth': 'local',
  'org enable tracking': 'local', 'org disable tracking': 'local',
  'project generate': 'local', 'project convert': 'local', 'project list ignored': 'local',
  'apex generate': 'local', 'lightning generate': 'local', 'visualforce generate': 'local',
  'static-resource generate': 'local', 'analytics generate': 'local', 'schema generate': 'local',
  'agent generate test-spec': 'local', 'template': 'local', 'dev': 'local',
  'code-analyzer': 'local', 'scanner': 'local',
  // read
  'org display': 'read', 'org open': 'read', 'org list metadata': 'read',
  'org list metadata-types': 'read', 'org list users': 'read', 'org list limits': 'read',
  'org list sobject': 'read', 'limits': 'read', 'sobject': 'read',
  'project retrieve': 'read', 'project deploy preview': 'read', 'project deploy report': 'read',
  'project reset tracking': 'read', 'project delete tracking': 'read',
  'data query': 'read', 'data get': 'read', 'data export': 'read', 'data search': 'read',
  'data resume': 'read', 'data bulk results': 'read',
  'apex get': 'read', 'apex list': 'read', 'apex tail': 'read',
  'agent generate': 'read', 'agent validate': 'read', 'agent list': 'read',
  'agent test list': 'read', 'agent test results': 'read', 'agent test resume': 'read',
  'package list': 'read', 'package installed list': 'read', 'package version list': 'read',
  'community list': 'read', 'lightning dev': 'read',
  'retrieve metadata': 'read',
  // validate (check-only)
  'project deploy validate': 'validate',
  // deploy
  'project deploy': 'deploy', 'deploy metadata': 'deploy',
  'agent publish': 'deploy', 'agent activate': 'deploy', 'agent deactivate': 'deploy',
  'agent create': 'deploy', 'agent test create': 'deploy',
  'org assign': 'deploy', 'org create user': 'deploy', 'org generate password': 'deploy',
  'package': 'deploy', 'community': 'deploy',
  // data
  'data': 'data', 'api request graphql': 'data', 'sfdmu': 'data',
  'project delete source': 'deploy',
  // deleting orgs (any other command that deletes also needs delete: see DELETE_COMMANDS)
  'org delete': 'delete', 'org refresh': 'delete',
  // execute
  'apex run': 'execute', 'agent preview': 'execute', 'agent test': 'execute',
  // fixed rules; any other org create/resume is treated as a sandbox
  'org create': 'sandbox', 'org resume': 'sandbox',
  'org create scratch': 'scratch', 'org resume scratch': 'scratch',
  // legacy sfdx (force:...)
  'force source deploy': 'deploy', 'force source push': 'deploy', 'force source delete': 'deploy',
  'force mdapi deploy': 'deploy', 'force source retrieve': 'read', 'force source pull': 'read',
  'force mdapi retrieve': 'read', 'force data soql': 'read', 'force data record get': 'read',
  'force data': 'data', 'force apex execute': 'execute', 'force apex test run': 'execute',
  'force org open': 'read', 'force org display': 'read', 'force org list': 'local',
  'force auth': 'local', 'force config': 'local', 'force alias': 'local',
};

// commands whose org is the Dev Hub, not the target org
const DEV_HUB_COMMANDS = ['package create', 'package version', 'package delete'];

// commands that delete, on top of their own category
const DELETE_COMMANDS = ['data delete', 'project delete source', 'force source delete', 'force data record delete',
  'force data bulk delete', 'package uninstall', 'package delete', 'package version delete'];

// deploy flags and files that make a deploy delete components as well
const DESTRUCTIVE_FLAGS = new Set(['--pre-destructive-changes', '--post-destructive-changes',
  '--predestructivechanges', '--postdestructivechanges']);
const DEPLOY_DIR_FLAGS = new Set(['--metadata-dir', '--deploydir', '-d', '--source-dir']);

const TARGET_FLAGS = new Set(['-o', '--target-org', '--targetusername', '--target-username']);
const DEV_HUB_FLAGS = new Set(['-v', '--target-dev-hub', '--targetdevhubusername']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'deno', 'bun']);
const WRAPPERS = new Set(['time', 'nohup', 'command', 'exec', 'nice', 'caffeinate', 'builtin', 'noglob']);
const READ_ONLY = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'rg', 'jq', 'ls', 'wc',
  'diff', 'file', 'stat', 'bat', 'code', 'open']);
const GUARD_READ_ONLY = new Set(['--show', '--check', '--help']);
const SF_HINT = /\bsf(dx)?\b|@salesforce\/cli/;

/** Thrown for anything the guard cannot verify; always results in deny. */
class Blocked extends Error {}

// ---------------------------------------------------------------- paths

/** Like Python's os.path.realpath: resolves symlinks in the part of the path that exists. */
function realpath(p) {
  p = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(p), ...rest);
    } catch {
      const parent = path.dirname(p);
      if (parent === p) return path.join(p, ...rest);
      rest.unshift(path.basename(p));
      p = parent;
    }
  }
}

function isInside(p, dir) {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function expandUser(p) {
  return p === '~' || p.startsWith('~/') ? HOME + p.slice(1) : p;
}

function parents(dir) {
  const out = [dir];
  while (path.dirname(out[out.length - 1]) !== out[out.length - 1]) out.push(path.dirname(out[out.length - 1]));
  return out;
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJsonKey(p, key) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))[key];
    return v || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- project

function findProjectRoot(cwd) {
  if (process.env.CLAUDE_PROJECT_DIR) return realpath(process.env.CLAUDE_PROJECT_DIR);
  const d = realpath(cwd);
  for (const folder of parents(d)) {
    if (fs.existsSync(path.join(folder, 'sfdx-project.json'))
        || fs.existsSync(path.join(folder, '.claude', 'org-policy.json'))) return folder;
  }
  return d;
}

function setProject(root) {
  PROJECT_ROOT = realpath(root);
  POLICY_PATH = path.join(PROJECT_ROOT, '.claude', 'org-policy.json');
}

/** A project that registers its own copy of the guard keeps it; this copy then only protects files. */
function projectHasOwnGuard() {
  const own = path.join(PROJECT_ROOT, '.claude', 'hooks', path.basename(HOOK_PATH));
  if (!fs.existsSync(own) || realpath(own) === HOOK_PATH) return false;
  return ['settings.json', 'settings.local.json']
    .some((name) => (readText(path.join(PROJECT_ROOT, '.claude', name)) || '').includes(GUARD));
}

function initCommand() {
  return `! ${CLI} --init`;
}

// ---------------------------------------------------------------- policy

function emptyPolicy() {
  return { orgs: {}, defaultOrgPolicy: {}, scripts: {}, commands: {} };
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Returns the project policy, or null when the project has none. */
function loadPolicy() {
  if (!fs.existsSync(POLICY_PATH)) return null;
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
  } catch (e) { // broken policy: nothing is allowed
    throw new Blocked(`org policy ${POLICY_PATH} is invalid JSON (${e.message})`);
  }
  if (!isObject(policy)) throw new Blocked(`org policy ${POLICY_PATH} is not a JSON object`);
  for (const [k, v] of Object.entries(emptyPolicy())) {
    if (!(k in policy)) policy[k] = v;
    if (!isObject(policy[k])) throw new Blocked(`"${k}" in org policy ${POLICY_PATH} is not a JSON object`);
  }
  return policy;
}

function loadAliases() {
  const aliases = {};
  for (const p of [path.join(HOME, '.sfdx', 'alias.json'), path.join(HOME, '.sf', 'alias.json')]) {
    try {
      Object.assign(aliases, JSON.parse(fs.readFileSync(p, 'utf8')).orgs || {});
    } catch {
      // no alias file
    }
  }
  return aliases;
}

function toUsername(org, aliases) {
  if (org.includes('@')) return org.toLowerCase();
  if (Object.hasOwn(aliases, org)) return String(aliases[org]).toLowerCase();
  throw new Blocked(`org '${org}' is not a known alias or username, so its policy cannot be checked`);
}

function orgLabel(username, policy) {
  const entry = policy.orgs[username] || {};
  return entry.alias ? `${entry.alias} (${username})` : username;
}

function decide(username, category, policy) {
  const entry = Object.hasOwn(policy.orgs, username) ? policy.orgs[username] : policy.defaultOrgPolicy;
  const d = (entry || {})[category];
  return Object.hasOwn(RANK, d) ? d : 'deny';
}

// ---------------------------------------------------------------- org resolution

function configuredOrg(cwd, devHub = false) {
  const [keySf, keySfdx] = devHub ? ['target-dev-hub', 'defaultdevhubusername'] : ['target-org', 'defaultusername'];
  for (const folder of [...parents(realpath(cwd)), HOME]) {
    for (const [p, key] of [[path.join(folder, '.sf', 'config.json'), keySf],
      [path.join(folder, '.sfdx', 'sfdx-config.json'), keySfdx]]) {
      const v = readJsonKey(p, key);
      if (v) return [String(v), p];
    }
  }
  return [null, null];
}

/** Expand $VAR / ${VAR} from variables set earlier in the same command; refuse anything else dynamic. */
function expand(value, env) {
  const out = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    const name = a || b;
    if (Object.hasOwn(env, name)) return env[name];
    throw new Blocked(`org comes from $${name}, which the guard cannot resolve; pass a literal alias`);
  });
  if (out.includes('$') || out.includes('`')) throw new Blocked(`org value '${value}' is dynamic; pass a literal alias`);
  return out;
}

function flagValue(args, flags, allowU) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (flags.has(a) || (allowU && a === '-u')) {
      if (i + 1 < args.length) return args[i + 1];
      throw new Blocked(`${a} given without a value`);
    }
    for (const f of flags) {
      if (f.startsWith('--') && a.startsWith(f + '=')) return a.slice(f.length + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------- shell parsing

/** Index of the ')' that closes the '(' at `open`, skipping quoted text and nested parentheses. */
function matchParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') i++;
    else if (c === "'") {
      i = s.indexOf("'", i + 1);
      if (i < 0) break;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  throw new Blocked('could not parse the shell command (unbalanced parentheses)');
}

/** Index of the backtick that closes the one at `open`. */
function matchBacktick(s, open) {
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '`') return i;
  }
  throw new Blocked('could not parse the shell command (no closing backtick)');
}

/**
 * Reads a command substitution starting at i ($(...), `...`, <(...) or >(...)); returns
 * [inner command, index after it] or null when there is none at i.
 */
function substitution(s, i) {
  if ((s[i] === '$' || s[i] === '<' || s[i] === '>') && s[i + 1] === '(') {
    const end = matchParen(s, i + 1);
    return [s.slice(i + 2, end), end + 1];
  }
  if (s[i] === '`') {
    const end = matchBacktick(s, i);
    return [s.slice(i + 1, end).replace(/\\([`$\\])/g, '$1'), end + 1];
  }
  return null;
}

/** All command substitutions in text where quotes have no meaning (an unquoted heredoc body). */
function substitutionsIn(text) {
  const subs = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    const sub = text[i] === '$' || text[i] === '`' ? substitution(text, i) : null;
    if (sub) {
      subs.push(sub[0]);
      i = sub[1] - 1;
    }
  }
  return subs;
}

/** Whether position `at` of a line falls inside quotes, so a `<<` there is text, not a heredoc. */
function quotedAt(line, at) {
  let quote = null;
  for (let i = 0; i < at; i++) {
    const c = line[i];
    if (c === '\\' && quote !== "'") i++;
    else if (quote === null && (c === "'" || c === '"')) quote = c;
    else if (c === quote) quote = null;
  }
  return quote !== null;
}

/**
 * Remove heredoc bodies; bodies fed to a shell are analysed as commands, bodies fed to an
 * interpreter that mention sf are refused, and $(...) in unquoted bodies is analysed.
 */
function stripHeredocs(command, ctx, findings) {
  const lines = command.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(line);
    if (!m || quotedAt(line, m.index)) {
      i++;
      continue;
    }
    const delim = m[2];
    const body = [];
    for (i++; i < lines.length && lines[i].trim() !== delim; i++) body.push(lines[i]);
    i++;
    const text = body.join('\n');
    const words = line.slice(0, m.index).split(/[;&|(]/).pop().trim().split(/\s+/);
    const consumer = words[0] ? path.basename(words[0]) : '';
    if (SHELLS.has(consumer)) analyse(text, ctx, findings);
    else if (INTERPRETERS.has(consumer) && SF_HINT.test(text)) {
      throw new Blocked(`a ${consumer} heredoc calls sf; the guard cannot check indirect calls`);
    } else if (!m[1]) {
      for (const sub of substitutionsIn(text)) analyse(sub, ctx, findings);
    }
  }
  return out.join('\n');
}

const SEPARATORS = ';&|()\n';

/**
 * Splits a command line into simple commands, each {words, redirects}, the way bash reads it:
 * quotes, backslashes, comments, separators and redirections. The bodies of command substitutions,
 * also inside double quotes, go to `subs` to be analysed as commands of their own.
 */
function splitSimpleCommands(command, subs) {
  const cmds = [];
  let cur = { words: [], redirects: [] };
  let word = null; // null: between words
  let redirect = false; // the next word is a redirection target
  const flush = () => {
    if (word === null) return;
    if (redirect) cur.redirects.push(word);
    else cur.words.push(word);
    word = null;
    redirect = false;
  };
  const endCommand = () => {
    flush();
    if (cur.words.length || cur.redirects.length) cmds.push(cur);
    cur = { words: [], redirects: [] };
    redirect = false;
  };
  const s = command;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const sub = substitution(s, i);
    if (sub) {
      subs.push(sub[0]);
      word = (word ?? '') + '$(...)';
      i = sub[1];
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (c === '#' && word === null) {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '\\') {
      if (i + 1 >= s.length) throw new Blocked('could not parse the shell command (no escaped character)');
      if (s[i + 1] !== '\n') word = (word ?? '') + s[i + 1];
      i += 2;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Blocked('could not parse the shell command (no closing quotation)');
      word = (word ?? '') + s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      word = word ?? '';
      for (i++; ; ) {
        if (i >= s.length) throw new Blocked('could not parse the shell command (no closing quotation)');
        const d = s[i];
        const inner = d === '$' || d === '`' ? substitution(s, i) : null;
        if (d === '"') {
          i++;
          break;
        } else if (inner) {
          subs.push(inner[0]);
          word += '$(...)';
          i = inner[1];
        } else if (d === '\\' && '"\\$`\n'.includes(s[i + 1])) {
          if (s[i + 1] !== '\n') word += s[i + 1];
          i += 2;
        } else {
          word += d;
          i++;
        }
      }
    } else if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      if (word !== null && /^\d+$/.test(word) && !redirect) word = null; // file descriptor, as in 2>&1
      flush();
      while (i < s.length && '<>&|'.includes(s[i])) i++;
      redirect = true;
    } else if (SEPARATORS.includes(c)) {
      endCommand();
      i++;
    } else {
      word = (word ?? '') + c;
      i++;
    }
  }
  endCommand();
  return cmds;
}

// ---------------------------------------------------------------- analysis

function isAssignment(w) {
  return /^[A-Za-z_]\w*=/.test(w);
}

function splitAssignment(w) {
  const i = w.indexOf('=');
  return [w.slice(0, i), w.slice(i + 1)];
}

function protectedPaths() {
  const claude = path.join(PROJECT_ROOT, '.claude');
  return [POLICY_PATH, path.dirname(HOOK_PATH) + path.sep, path.join(claude, 'hooks') + path.sep,
    path.join(claude, 'settings.json'), path.join(claude, 'settings.local.json')];
}

function isProtected(p, cwd) {
  const real = realpath(path.resolve(cwd, expandUser(p)));
  if (protectedPaths().some((x) => real === x || (x.endsWith(path.sep) && real.startsWith(x)))) return true;
  return /\/\.claude[\w-]*\/settings(\.local)?\.json$|managed-settings\.json$|\/\.claude\/org-policy\.json$/.test(real);
}

function mentionsProtected(word, cwd) {
  return ['org-policy.json', GUARD, 'settings.json', 'settings.local.json', 'hooks'].some((k) => word.includes(k))
    && isProtected(word, cwd);
}

/** The agent may ask this guard what it would do, but not change the policy through it. */
function checkGuardCall(script, args) {
  if (!path.basename(script).startsWith(GUARD)) return false;
  if (args.length && GUARD_READ_ONLY.has(args[0])) return true;
  throw new Blocked('changing the org policy is reserved for a human');
}

function analyse(command, ctx, findings) {
  if (!SF_HINT.test(command) && !['org-policy', GUARD, 'settings', '.claude', 'hooks',
    ...Object.keys(ctx.policy.scripts)].some((k) => command.includes(k))) return;
  command = stripHeredocs(command, ctx, findings);
  const subs = [];
  for (const { words, redirects } of splitSimpleCommands(command, subs)) {
    for (const target of redirects) {
      if (isProtected(target, ctx.cwd)) throw new Blocked(`writing to ${target} is reserved for a human`);
    }
    analyseSimple(words, ctx, findings);
  }
  for (const sub of subs) analyse(sub, ctx, findings);
}

function analyseSimple(words, ctx, findings) {
  const localEnv = {};
  while (words.length && isAssignment(words[0])) {
    const [k, v] = splitAssignment(words[0]);
    localEnv[k] = v;
    words = words.slice(1);
  }
  if (!words.length) {
    Object.assign(ctx.vars, localEnv); // plain `ORG=myAlias`
    return;
  }
  const cmd = path.basename(words[0]);
  const args = words.slice(1);
  const withEnv = (rest) => [...Object.entries(localEnv).map(([k, v]) => `${k}=${v}`), ...rest];

  if (cmd === 'export') {
    for (const a of args.filter(isAssignment)) {
      const [k, v] = splitAssignment(a);
      ctx.vars[k] = v;
      ctx.exported[k] = v;
    }
    return;
  }
  if (cmd === 'cd') {
    const target = args.length ? args[0] : HOME;
    if (target.includes('$') || target === '-') ctx.cwdUnknown = true;
    else ctx.cwd = realpath(path.resolve(ctx.cwd, expandUser(target)));
    return;
  }
  if (WRAPPERS.has(cmd) || cmd === 'sudo') return analyseSimple(withEnv(args), ctx, findings);
  if (cmd === 'timeout') return analyseSimple(args.filter((a) => !a.startsWith('-')).slice(1), ctx, findings);
  if (cmd === 'env') {
    let rest = args;
    while (rest.length && (rest[0].startsWith('-') || isAssignment(rest[0]))) {
      if (['-u', '-C', '-S'].includes(rest[0])) throw new Blocked(`env ${rest[0]} is not supported by the guard`);
      if (isAssignment(rest[0])) {
        const [k, v] = splitAssignment(rest[0]);
        localEnv[k] = v;
      }
      rest = rest.slice(1);
    }
    return analyseSimple(withEnv(rest), ctx, findings);
  }
  if (cmd === 'xargs') {
    if (args.some((a) => SF_HINT.test(a))) throw new Blocked('sf behind xargs cannot be checked; run the sf commands directly');
    return analyseSimple(args.filter((a) => !a.startsWith('-')), ctx, findings);
  }
  if (cmd === 'eval') return analyse(args.join(' '), ctx, findings);
  if (SHELLS.has(cmd)) {
    const c = args.indexOf('-c');
    if (c >= 0 && c + 1 < args.length) return analyse(args[c + 1], ctx, findings);
    const s = args.findIndex((a) => !a.startsWith('-'));
    if (s >= 0) return analyseScript(args[s], args.slice(s + 1), localEnv, ctx, findings);
    return;
  }
  if ((cmd === '.' || cmd === 'source') && args.length) {
    return analyseScript(args[0], args.slice(1), localEnv, ctx, findings);
  }
  if (INTERPRETERS.has(cmd) || /^python3?\.\d+$/.test(cmd)) {
    if (args.some((a) => ['-c', '-e', '--eval', '-p'].includes(a)) && SF_HINT.test(args.join(' '))) {
      throw new Blocked(`inline ${cmd} code calls sf; the guard cannot check indirect calls`);
    }
    if (cmd.startsWith('python') && args[0] === '-m' && args[1] === 'json.tool') return;
    const s = args.findIndex((a) => !a.startsWith('-'));
    if (s < 0) return;
    if (checkGuardCall(args[s], args.slice(s + 1))) return;
    return analyseScript(args[s], args.slice(s + 1), localEnv, ctx, findings);
  }
  if (['npx', 'pnpx', 'bunx'].includes(cmd) || (['npm', 'pnpm', 'yarn'].includes(cmd) && args[0] === 'exec')) {
    let rest = ['npm', 'pnpm', 'yarn'].includes(cmd) ? args.slice(1) : args;
    while (rest.length && rest[0].startsWith('-')) rest = rest.slice(1);
    if (rest.length && (rest[0] === 'sf' || rest[0] === 'sfdx' || rest[0].startsWith('@salesforce/cli'))) {
      return analyseSf(rest[0] === 'sfdx' ? 'sfdx' : 'sf', rest.slice(1), localEnv, ctx, findings);
    }
    return;
  }
  if (cmd === 'sf' || cmd === 'sfdx') return analyseSf(cmd, args, localEnv, ctx, findings);
  if (checkGuardCall(words[0], args)) return;

  // anything else: guard protected files, then check known scripts
  for (const w of words) {
    if (!mentionsProtected(w, ctx.cwd)) continue;
    if (READ_ONLY.has(cmd) || (cmd === 'git' && ['add', 'commit', 'diff', 'log', 'show', 'status', 'blame']
      .includes(args[0]))) continue;
    throw new Blocked(`'${cmd}' on ${w} is reserved for a human`);
  }
  if (words[0].includes('/')) analyseScript(words[0], args, localEnv, ctx, findings);
}

function analyseScript(script, args, localEnv, ctx, findings) {
  if (mentionsProtected(script, ctx.cwd)) throw new Blocked(`running ${script} is reserved for a human`);
  if (!ctx.checkOrgs) return;
  const real = realpath(path.resolve(ctx.cwd, script));
  for (const [rel, rule] of Object.entries(ctx.policy.scripts)) {
    if (real !== realpath(path.resolve(PROJECT_ROOT, rel))) continue;
    let org = (rule.orgFlag && flagValue(args, new Set([rule.orgFlag]), false)) || rule.defaultOrg;
    if (!org) throw new Blocked(`${rel} has no org flag or defaultOrg in the policy`);
    org = expand(String(org), { ...ctx.vars, ...localEnv });
    for (let category of rule.categories || CATEGORIES) {
      category = RENAMED[category] || category;
      if (!CATEGORIES.includes(category)) {
        throw new Blocked(`${rel} declares unknown category '${category}' in the policy`
          + (category === 'admin' ? ` (${ADMIN_GONE})` : ''));
      }
      findings.push({ what: rel, category, org, source: `${rule.orgFlag || '(no flag)'} / script default` });
    }
  }
}

function classify(words, flags, overrides) {
  const table = { ...COMMANDS, ...overrides };
  const key = words.join(' ');
  let best = null;
  for (const prefix of Object.keys(table)) {
    if ((key === prefix || key.startsWith(prefix + ' ')) && (best === null || prefix.length > best.length)) best = prefix;
  }
  if (best === null) return [null, key];
  let category = RENAMED[table[best]] || table[best];
  if (best === 'project deploy' && words.slice(0, 3).join(' ') === 'project deploy start' && flags.includes('--dry-run')) {
    category = 'validate';
  }
  return [category, key];
}

function analyseSf(cmd, args, localEnv, ctx, findings) {
  if (!ctx.checkOrgs) return;
  let words = [];
  let i = 0;
  for (; i < args.length && !args[i].startsWith('-'); i++) words.push(...args[i].split(':').filter(Boolean));
  const flags = args.slice(i);
  words = words.map((w) => w.toLowerCase());
  if (!words.length || flags.some((f) => f === '-h' || f === '--help')) return;
  let category;
  let key;
  let deletes = false;
  if (words[0] === 'api' && words[1] === 'request' && words[2] === 'rest') {
    const method = (flagValue(flags, new Set(['-X', '--method']), false) || 'GET').toUpperCase();
    [category, key] = [method === 'GET' ? 'read' : 'data', words.join(' ')];
    deletes = method === 'DELETE';
  } else {
    [category, key] = classify(words, flags, ctx.policy.commands);
  }
  const what = `${cmd} ${key}`;
  if (category === null) {
    throw new Blocked(`'${what}' is not a known sf command; a human can classify it under "commands" `
      + 'in .claude/org-policy.json');
  }
  if (category === 'local') return;
  if (Object.hasOwn(FIXED, category)) {
    findings.push({ what, category, org: null, source: 'fixed rule' });
    return;
  }
  if (!CATEGORIES.includes(category)) {
    throw new Blocked(`'${what}' is mapped to unknown category '${category}'`
      + (category === 'admin' ? ` (${ADMIN_GONE})` : ''));
  }
  deletes ||= DELETE_COMMANDS.some((p) => key === p || key.startsWith(p + ' '))
    || (category === 'deploy' && deletesMetadata(flags, ctx.cwd));
  const categories = deletes && category !== 'delete' ? [category, 'delete'] : [category];

  const devHub = DEV_HUB_COMMANDS.some((p) => key === p || key.startsWith(p + ' '));
  const legacyU = cmd === 'sfdx' || words[0] !== 'agent';
  const env = { ...ctx.exported, ...localEnv };
  let org;
  let source;
  if (devHub) {
    [org, source] = [flagValue(flags, DEV_HUB_FLAGS, false), '--target-dev-hub'];
    if (org === null) [org, source] = [env.SF_TARGET_DEV_HUB || env.SFDX_DEFAULTDEVHUBUSERNAME || null, 'environment'];
  } else {
    [org, source] = [flagValue(flags, TARGET_FLAGS, legacyU), '--target-org'];
    if (org === null) [org, source] = [env.SF_TARGET_ORG || env.SFDX_DEFAULTUSERNAME || null, 'environment'];
  }
  if (org === null) {
    const name = devHub ? 'SF_TARGET_DEV_HUB' : 'SF_TARGET_ORG';
    if (process.env[name]) [org, source] = [process.env[name], `$${name}`];
  }
  if (org === null) {
    if (ctx.cwdUnknown) {
      throw new Blocked('the command changes to a directory the guard cannot resolve, so the default org is unknown');
    }
    [org, source] = configuredOrg(ctx.cwd, devHub);
    if (org === null) throw new Blocked(`'${what}' has no target org and no default is configured`);
    source = `default from ${source}`;
  }
  org = expand(org, { ...ctx.vars, ...localEnv });
  for (const c of categories) findings.push({ what, category: c, org, source });
}

/** Whether a deploy visibly deletes components: destructive-changes flags, or such a file in the deploy folder. */
function deletesMetadata(flags, cwd) {
  if (flags.some((f) => DESTRUCTIVE_FLAGS.has(f.split('=')[0]))) return true;
  const dir = flagValue(flags, DEPLOY_DIR_FLAGS, false);
  if (!dir) return false;
  try {
    return fs.readdirSync(path.resolve(cwd, dir)).some((n) => /^destructiveChanges(Pre|Post)?\.xml$/i.test(n));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- entry points

/** Returns [decision, reason]. */
function evaluate(command, cwd) {
  let policy = null;
  let problem = null;
  try {
    policy = loadPolicy();
    if (policy === null) {
      problem = `this project has no org policy (${POLICY_PATH}), so no sf command may touch an org. `
        + `Do not work around this; ask the human to run:  ${initCommand()}`;
    }
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    problem = `${e.message}. Ask the human to fix it.`;
  }
  const ctx = { policy: policy || emptyPolicy(), cwd, cwdUnknown: false, vars: {}, exported: {},
    checkOrgs: !projectHasOwnGuard() };
  const findings = [];
  try {
    analyse(command, ctx, findings);
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    return ['deny', `sf-org-guard: ${e.message}`];
  }
  if (!findings.length) return ['allow', ''];
  if (problem) return ['deny', `sf-org-guard: ${problem}`];
  const aliases = loadAliases();
  let worst = 'allow';
  let fixedDeny = false;
  const lines = [];
  for (const f of findings) {
    if (Object.hasOwn(FIXED, f.category)) {
      const d = FIXED[f.category];
      if (RANK[d] > RANK[worst]) worst = d;
      if (d === 'deny') fixedDeny = true;
      lines.push(`${f.what} [${f.category === 'sandbox' ? 'creating a sandbox' : 'creating a scratch org'}: always ${d.toUpperCase()}]`);
      continue;
    }
    let user;
    try {
      user = toUsername(f.org, aliases);
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      return ['deny', `sf-org-guard: ${e.message}`];
    }
    const d = decide(user, f.category, policy);
    if (RANK[d] > RANK[worst]) worst = d;
    lines.push(`${f.what} -> ${orgLabel(user, policy)} [${f.category}: ${d.toUpperCase()}] (org via ${f.source})`);
  }
  let reason = 'sf-org-guard: ' + lines.join('; ');
  if (fixedDeny) {
    reason += '. Creating sandboxes is reserved for a human. Do not work around this; '
      + 'tell the human what you wanted to do.';
  } else if (worst === 'deny') {
    reason += `. Blocked by ${POLICY_PATH}. Do not work around this; ask the human to change the `
      + 'policy if the action is intended.';
  }
  return [worst, reason];
}

function guardFileTool(toolInput, cwd) {
  const p = toolInput.file_path || toolInput.notebook_path || '';
  if (p && isProtected(p, cwd)) {
    return ['deny', `sf-org-guard: ${p} is guard configuration and is reserved for a human to edit.`];
  }
  return ['allow', ''];
}

function readHookInput() {
  const data = JSON.parse(fs.readFileSync(0, 'utf8'));
  const cwd = data.cwd || process.cwd();
  setProject(findProjectRoot(cwd));
  return [data, cwd];
}

function runHook() {
  let decision;
  let reason;
  try {
    const [data, cwd] = readHookInput();
    const tool = data.tool_name || '';
    const toolInput = data.tool_input || {};
    if (tool === 'Bash') [decision, reason] = evaluate(String(toolInput.command || ''), cwd);
    else if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) [decision, reason] = guardFileTool(toolInput, cwd);
    else return 0;
  } catch (e) { // fail closed: exit 2 blocks the tool call
    process.stderr.write(`sf-org-guard crashed, blocking to be safe: ${e && e.stack ? e.stack : e}\n`);
    return 2;
  }
  if (decision === 'allow') return 0;
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } }));
  return 0;
}

/** In a Salesforce project without a usable policy, tell the agent to ask the human for one first. */
function sessionStart() {
  try {
    readHookInput();
  } catch {
    setProject(findProjectRoot(process.cwd()));
  }
  if (projectHasOwnGuard() || !fs.existsSync(path.join(PROJECT_ROOT, 'sfdx-project.json'))) return 0;
  let problem;
  try {
    if (loadPolicy() !== null) return 0;
    problem = `has no org policy (${POLICY_PATH})`;
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    problem = `has a broken org policy: ${e.message}`;
  }
  const context = `This Salesforce project ${problem}. Until a human creates it, sf-org-guard blocks every sf command `
    + `that touches an org. Before starting other work, ask the human in one short line to run `
    + `\`${initCommand()}\` and then grant access per org with `
    + `\`! ${CLI} --set <alias> <category>=<allow|ask|deny>\` `
    + `(categories: ${CATEGORIES.join(', ')}; \`all=\` sets every category). `
    + 'You cannot create or edit the policy yourself; do not try to work around the block.';
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context } }));
  return 0;
}

function fail(message) {
  throw new Blocked(message);
}

function writePolicy(policy) {
  fs.mkdirSync(path.dirname(POLICY_PATH), { recursive: true });
  fs.writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2) + '\n');
}

function show() {
  const policy = loadPolicy();
  const aliases = loadAliases();
  if (policy === null) fail(`no org policy for ${PROJECT_ROOT}; create one with:  ${CLI} --init`);
  console.log(`policy: ${POLICY_PATH}`);
  const byUser = {};
  for (const [alias, user] of Object.entries(aliases)) (byUser[String(user).toLowerCase()] ??= []).push(alias);
  const rows = Object.entries(policy.orgs).map(([u, e]) => [e.alias || (byUser[u] || []).join(',') || '-', u, e]);
  rows.push(['(any other org)', '', policy.defaultOrgPolicy]);
  const w = Math.max(...rows.map((r) => r[0].length));
  console.log(`${'org'.padEnd(w)}  ${CATEGORIES.map((c) => c.padEnd(8)).join('  ')}  username`);
  for (const [alias, user, e] of rows) {
    console.log(`${alias.padEnd(w)}  ${CATEGORIES.map((c) => String(e[c] ?? 'deny').padEnd(8)).join('  ')}  ${user}`);
  }
  console.log('\nfixed, in every org: creating a sandbox always deny; creating a scratch org always ask');
}

function addOrg(policy, org, aliases) {
  const user = toUsername(org, aliases);
  if (!Object.hasOwn(policy.orgs, user)) policy.orgs[user] = Object.fromEntries(CATEGORIES.map((c) => [c, 'deny']));
  const entry = policy.orgs[user];
  if (!org.includes('@') && !('alias' in entry)) entry.alias = org;
  return entry;
}

function initPolicy(orgs) {
  if (fs.existsSync(POLICY_PATH)) fail(`${POLICY_PATH} already exists; change it with --set`);
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'sfdx-project.json'))) {
    console.log(`note: ${PROJECT_ROOT} has no sfdx-project.json; creating the policy here anyway`);
  }
  const aliases = loadAliases();
  const policy = { _readme: README, ...emptyPolicy(), defaultOrgPolicy: Object.fromEntries(CATEGORIES.map((c) => [c, 'deny'])) };
  const [defaultOrg] = configuredOrg(PROJECT_ROOT);
  if (defaultOrg) {
    try {
      addOrg(policy, defaultOrg, aliases).note = 'project default org';
    } catch (e) {
      if (!(e instanceof Blocked)) throw e;
      console.log(`note: skipping the default org: ${e.message}`);
    }
  }
  for (const org of orgs) addOrg(policy, org, aliases);
  writePolicy(policy);
  show();
  console.log(`\nEvery org starts at deny. Grant access with:\n  ${CLI} --set <alias> read=allow validate=allow deploy=ask ...`);
}

function setPolicy(org, assignments) {
  const policy = loadPolicy();
  const aliases = loadAliases();
  if (policy === null) fail(`no org policy for ${PROJECT_ROOT}; create one first with:  ${CLI} --init`);
  const entry = addOrg(policy, org, aliases);
  for (const a of assignments) {
    const [cat, dec] = [a.split('=')[0], a.split('=').slice(1).join('=')];
    const cats = cat === 'all' ? CATEGORIES : [cat];
    if (cat === 'admin') fail(ADMIN_GONE);
    if (Object.hasOwn(RENAMED, cat)) fail(`'${cat}' is now part of '${RENAMED[cat]}'; set ${RENAMED[cat]}=${dec} instead`);
    if (cats.some((c) => !CATEGORIES.includes(c)) || !DECISIONS.includes(dec)) {
      fail(`bad assignment '${a}': use <${CATEGORIES.join('|')}|all>=<${DECISIONS.join('|')}>`);
    }
    for (const c of cats) entry[c] = dec;
  }
  for (const e of [...Object.values(policy.orgs), policy.defaultOrgPolicy]) {
    if (isObject(e)) for (const old of [...Object.keys(RENAMED), 'admin']) delete e[old];
  }
  delete policy._readme;
  writePolicy({ _readme: README, ...policy });
  show();
}

function usage() {
  const src = fs.readFileSync(HOOK_PATH, 'utf8');
  console.log(src.slice(src.indexOf('/*') + 3, src.indexOf('*/')).trim());
}

function main(argv) {
  if (!argv.length) return runHook();
  if (argv[0] === '--session-start') return sessionStart();
  let cwd = process.cwd();
  const c = argv.indexOf('--cwd');
  if (c >= 0) {
    cwd = argv[c + 1];
    argv = [...argv.slice(0, c), ...argv.slice(c + 2)];
  }
  setProject(findProjectRoot(cwd));
  try {
    if (argv[0] === '--show') show();
    else if (argv[0] === '--check' && argv.length >= 2) {
      const [decision, reason] = evaluate(argv[1], cwd);
      console.log(decision.toUpperCase(), reason);
    } else if (argv[0] === '--init') initPolicy(argv.slice(1));
    else if (argv[0] === '--set' && argv.length >= 3) setPolicy(argv[1], argv.slice(2));
    else {
      usage();
      return 1;
    }
  } catch (e) {
    if (!(e instanceof Blocked)) throw e;
    process.stderr.write(e.message + '\n');
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
