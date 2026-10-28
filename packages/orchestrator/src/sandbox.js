// The item's actors against a local git sandbox. The host does what can be done exactly (briefs, commits,
// test runs, merges); a session does only what needs judgement, and its claim never stands in for a fact:
// the built commit and the verified commit come from git, not from what the session says.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitForge } from './git.js';
import { openItem } from './item.js';

const write = (path, text) => (mkdirSync(join(path, '..'), { recursive: true }), writeFileSync(path, text), path);
const lines = (items) => items.map((x) => `- ${x}`).join('\n');
const sh = (cwd, cmd, args) => {
  try {
    return `$ ${cmd} ${args.join(' ')}\n${execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })}exit 0`;
  } catch (err) {
    return `$ ${cmd} ${args.join(' ')}\n${err.stdout ?? ''}${err.stderr ?? ''}exit ${err.status}`;
  }
};
const object = (properties) => ({ type: 'object', required: Object.keys(properties), properties });
const READ = ['Read', 'Glob', 'Grep'];

/** Actors for an item kept in dir, building in the git repo at repo. */
export const sandboxActors = ({ dir, repo }) => {
  const forge = gitForge(repo);
  return {
    // Both briefs are written before any build, so the verifier's cannot be shaped by what was built.
    brief: async ({ issue, why }) => ({
      source: 'host',
      output: {
        builder: write(join(dir, 'briefs/builder.md'), `# Build: ${issue.title ?? issue.url}\n\n${issue.url}\n\nDone when:\n${lines(issue.expect)}\n${why ? `\nThe last attempt stalled. Five whys:\n${why}\n` : ''}`),
        verifier: write(join(dir, 'briefs/verifier.md'), `# Verify: ${issue.title ?? issue.url}\n\nPASS only if every line holds for the commit under review; otherwise FAIL.\n${lines(issue.expect)}\n`)
      }
    }),

    build: {
      claim: object({ summary: { type: 'string' } }),
      tools: [...READ, 'Edit', 'Write'],
      prepare: ({ issue, brief, verdict }) => ({
        cwd: forge.worktree(join(dir, 'work'), { branch: `item/${issue.url.split('/').pop()}` }),
        prompt: `${readFileSync(brief, 'utf8')}${verdict ? `\n\nThe last commit failed verification. The verifier's report:\n${readFileSync(verdict.report, 'utf8')}` : ''}\n\nMake the change in this directory by editing files. Do not run git; the host commits for you. Reply with a one-line summary.`
      }),
      finish: ({ summary }, { issue }, { cwd }) => {
        const headSha = forge.commitAll(cwd, `${issue.title ?? issue.url}\n\n${summary}`);
        if (!headSha) throw new Error('the builder changed nothing');
        const branch = forge.branchOf(cwd);
        return { pr: { branch, headSha, url: forge.url(branch) } };
      }
    },

    // The host checks out the commit and runs the tests; the session judges the lines against that evidence.
    verify: {
      claim: object({ result: { enum: ['PASS', 'FAIL'] }, report: { type: 'string' } }),
      tools: READ,
      prepare: ({ brief, pr }, { run }) => {
        const cwd = forge.worktree(join(dir, `verify-${run}`), { at: pr.headSha });
        const evidence = `Diff against main:\n${forge.diff(pr.headSha)}\n\nTests:\n${sh(cwd, 'node', ['--test'])}`;
        return {
          cwd,
          evidence,
          prompt: `${readFileSync(brief, 'utf8')}\n\nThe commit under review, ${pr.headSha}, is checked out in this directory. The host ran the tests on it; the evidence below is their real output. You can read files but not run commands, and need not.\n\n${evidence}\n\nGive the verdict, and a report with one line per expectation.`
        };
      },
      finish: ({ result, report }, { pr }, { cwd, evidence }, { run }) => {
        forge.removeWorktree(cwd);
        return { result, sha: pr.headSha, report: write(join(dir, `reports/${run}.md`), `# ${result} at ${pr.headSha}\n\n${report}\n\n## Evidence\n\n${evidence}\n`) };
      }
    },

    // A stand-in session picks one of the choices the machine offers, and says why.
    ask: {
      claim: object({ choice: { type: 'string' }, why: { type: 'string' } }),
      tools: [],
      prepare: ({ question, choices, ...facts }) => ({
        cwd: dir,
        prompt: `You decide for the person. ${question}\nChoose exactly one of: ${choices.join(', ')}.\n\nFacts:\n${JSON.stringify(facts, null, 2)}${facts.verdict?.report ? `\n\nThe verifier's report:\n${readFileSync(facts.verdict.report, 'utf8')}` : ''}\n\nGive your choice and a short why.`
      }),
      finish: (claim, { choices }) => {
        if (!choices.includes(claim.choice)) throw new Error(`${claim.choice} is not one of ${choices.join(', ')}`);
        return { ...claim, by: 'stand-in' };
      }
    },

    merge: async ({ pr, sha }) => ({ source: 'host', output: { sha: forge.merge(sha, `Merge ${pr.branch} at ${sha}`) } })
  };
};

/** A fresh sandbox repository: a tiny module with a test, committed on main. */
export const makeSandbox = (repo) => {
  write(join(repo, 'package.json'), '{ "type": "module" }\n');
  write(join(repo, 'math.js'), 'export const add = (a, b) => a + b;\n');
  write(join(repo, 'math.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from './math.js';\n\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'sandbox host');
  git('config', 'user.email', 'host@sandbox.invalid');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start');
  return repo;
};

/** The item kept in dir, with its sandbox repository (made on first use) and the actors that work on it. */
export const openSandboxItem = (dir) => {
  const repo = join(dir, 'repo');
  if (!existsSync(repo)) makeSandbox(repo);
  return { ...openItem(dir), actors: sandboxActors({ dir, repo }) };
};
