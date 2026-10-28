// The item's actors for a headless run against a local git sandbox. Each is (input, { run, signal }) =>
// { output, source }. The host does what can be done exactly (briefs, commits, test runs, merges); Claude does
// only what needs judgement, and its word never stands in for a fact: the builder's commit and the verified
// commit come from git, not from what the session says.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claude } from './claude.js';
import { gitForge } from './git.js';

const write = (path, text) => (mkdirSync(join(path, '..'), { recursive: true }), writeFileSync(path, text), path);
const lines = (items) => items.map((x) => `- ${x}`).join('\n');
const sh = (cwd, cmd, args) => {
  try {
    return `$ ${cmd} ${args.join(' ')}\n${execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })}exit 0`;
  } catch (err) {
    return `$ ${cmd} ${args.join(' ')}\n${err.stdout ?? ''}${err.stderr ?? ''}exit ${err.status}`;
  }
};

/** Actors for an item kept in dir, building in the git repo at repo. */
export const sandboxActors = ({ dir, repo, model = 'haiku' }) => {
  const forge = gitForge(repo);
  return {
    // Both briefs are written before any build, so the verifier's cannot be shaped by what was built.
    brief: async ({ issue, why }) => ({
      source: 'host',
      output: {
        builder: write(join(dir, 'briefs/builder.md'), `# Build: ${issue.title ?? issue.url}\n\n${issue.url}\n\nDone when:\n${lines(issue.expect)}\n${why ? `\nLast attempt stalled. Five whys:\n${why}\n` : ''}`),
        verifier: write(join(dir, 'briefs/verifier.md'), `# Verify: ${issue.title ?? issue.url}\n\nPASS only if every line holds for the commit under review; otherwise FAIL.\n${lines(issue.expect)}\n`)
      }
    }),

    build: async ({ issue, brief, verdict }, { signal }) => {
      const branch = `item/${issue.url.split('/').pop()}`;
      const cwd = forge.worktree(join(dir, 'work'), { branch });
      const retry = verdict ? `\n\nThe last commit failed verification. The verifier's report:\n${readFileSync(verdict.report, 'utf8')}` : '';
      const { source } = await claude({
        prompt: `${readFileSync(brief, 'utf8')}${retry}\n\nMake the change in this directory by editing files. Do not run git; the host commits for you. Reply with a one-line summary.`,
        schema: { type: 'object', required: ['summary'], properties: { summary: { type: 'string' } } },
        tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
        cwd, model, signal
      });
      const headSha = forge.commitAll(cwd, issue.title ?? issue.url);
      if (!headSha) throw new Error('the builder changed nothing');
      return { source, output: { pr: { branch, headSha, url: forge.url(branch) } } };
    },

    // The host checks out the commit and runs the tests; the session judges the lines against that evidence.
    verify: async ({ brief, pr }, { run: id, signal }) => {
      const cwd = forge.worktree(join(dir, `verify-${id}`), { at: pr.headSha });
      try {
        const evidence = `Diff against main:\n${forge.diff(pr.headSha)}\n\nTests:\n${sh(cwd, 'node', ['--test'])}`;
        const { output, source } = await claude({
          prompt: `${readFileSync(brief, 'utf8')}\n\nThe commit under review, ${pr.headSha}, is checked out in this directory. The host ran the tests on it; the evidence below is their real output. You can read files but not run commands, and need not.\n\n${evidence}\n\nGive the verdict, and a report with one line per expectation.`,
          schema: { type: 'object', required: ['result', 'report'], properties: { result: { enum: ['PASS', 'FAIL'] }, report: { type: 'string' } } },
          cwd, model, signal
        });
        const report = write(join(dir, `reports/${id}.md`), `# ${output.result} at ${pr.headSha}\n\n${output.report}\n\n## Evidence\n\n${evidence}\n`);
        return { source, output: { result: output.result, sha: pr.headSha, report } };
      } finally {
        forge.removeWorktree(cwd);
      }
    },

    // The stand-in: a session picks one of the choices the machine offers, and says why.
    ask: async ({ question, choices, ...facts }, { signal }) => {
      const report = facts.verdict?.report ? `\n\nVerifier's report:\n${readFileSync(facts.verdict.report, 'utf8')}` : '';
      const { output, source } = await claude({
        prompt: `You decide for the person. ${question}\n\nFacts:\n${JSON.stringify(facts, null, 2)}${report}\n\nPick one choice and give a short why.`,
        schema: { type: 'object', required: ['choice', 'why'], properties: { choice: { enum: choices }, why: { type: 'string' } } },
        cwd: dir, model, signal, tools: []
      });
      return { source, output: { ...output, by: source } };
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
