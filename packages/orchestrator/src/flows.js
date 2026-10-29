// Example runs of the work item, played through the real machine so the inspector can show more than the
// golden path. Each flow is a short script of what the outside world sends; play() turns it into a journal by
// feeding it to a Host, so a flow the spec no longer allows throws instead of drawing something untrue.
import { Host } from './host.js';

const ISSUE = { url: 'sandbox:issues/1', title: 'Add multiply to math.js', expect: ['math.js exports multiply(a, b)', 'node --test passes'] };
const BRIEFS = { builder: 'briefs/builder.md', verifier: 'briefs/verifier.md' };
const sha = (n) => String(n).repeat(40).slice(0, 40);
const pr = (n) => ({ pr: { branch: 'item/1', headSha: sha(n), url: 'sandbox:pulls/1' } });
const verdict = (result, n) => ({ result, sha: sha(n), report: `reports/${result.toLowerCase()}-${n}.md` });
const standIn = (choice, why) => ({ choice, by: 'stand-in', why });
const person = (choice, why) => ({ choice, by: 'person', why });

// A script line: [actor, output] finishes that actor's open run, [actor, Error] fails it, 'timer' fires the
// timer that is set, and any other object is an event from outside.
const SOURCES = { brief: 'host', build: 'claude:builder', verify: 'claude:verifier', merge: 'host' };
const sourceOf = (actor, output) => (actor === 'ask' ? (output?.by === 'person' ? 'person' : 'claude:stand-in') : SOURCES[actor]);
const brief = ['brief', BRIEFS];
const merged = [['ask', standIn('approve', 'PASS at the PR head, and the diff matches the issue.')], ['merge', { sha: sha(9) }]];

export const flows = [
  {
    name: 'Merged first time',
    about: 'The golden path: one build passes verification, the stand-in approves, and it merges.',
    script: [brief, ['build', pr(1)], ['verify', verdict('PASS', 1)], ...merged]
  },
  {
    name: 'Fails verification, fixed on the next build',
    about: 'The verifier says FAIL; a build is left, so the builder tries again with the verdict, and the second build passes.',
    script: [brief, ['build', pr(1)], ['verify', verdict('FAIL', 1)], ['build', pr(2)], ['verify', verdict('PASS', 2)], ...merged]
  },
  {
    name: 'Fails twice, out of tries, dropped',
    about: 'Two FAILs use up both builds, so the item stalls in replanning, and the person drops it.',
    script: [brief, ['build', pr(1)], ['verify', verdict('FAIL', 1)], ['build', pr(2)], ['verify', verdict('FAIL', 2)], ['ask', person('drop', 'Not worth a third try.')]]
  },
  {
    name: 'Pushed again while waiting to merge',
    about: 'A new commit lands on the PR after it passed; the old verdict no longer covers the head, so it goes back to verifying.',
    script: [brief, ['build', pr(1)], ['verify', verdict('PASS', 1)], { type: 'pr.pushed', headSha: sha(2) }, ['verify', verdict('PASS', 2)], ...merged]
  },
  {
    name: 'Build crashes, replanned with five whys',
    about: 'The build session fails outright. Replanning asks for a written five whys, then the item starts again from a new brief and merges.',
    script: [
      brief, ['build', new Error('the builder session ended without a commit')],
      ['ask', person('replan', 'Why no commit? The brief named the wrong file. Why? ... Fix: name math.js in the brief.')],
      brief, ['build', pr(3)], ['verify', verdict('PASS', 3)], ...merged
    ]
  },
  {
    name: 'Build takes too long, dropped',
    about: 'The build outlives buildTimeout; the timer moves the item to replanning, and it is dropped.',
    script: [brief, 'timer', ['ask', person('drop', 'The issue is bigger than one item; split it.')]]
  },
  {
    name: 'Stand-in rejects, replanned',
    about: 'Verification passes but the stand-in rejects the merge, so the item is replanned and built again.',
    script: [
      brief, ['build', pr(1)], ['verify', verdict('PASS', 1)], ['ask', standIn('reject', 'The test checks only one pair of numbers.')],
      ['ask', person('replan', 'Why rejected? Thin tests. Why? The Expect lines did not ask for edge cases. Fix: add them.')],
      brief, ['build', pr(4)], ['verify', verdict('PASS', 4)], ...merged
    ]
  }
];

/** A flow's journal, made by feeding its script to a fresh Host one minute apart. */
export const play = (spec, { name, script }, startAt = '2026-10-29T09:00:00.000Z') => {
  const host = new Host(spec);
  let clock = Date.parse(startAt);
  const accept = (input) => {
    const result = host.accept({ at: new Date(clock).toISOString(), ...input });
    if (!result.ok) throw new Error(`flow "${name}": ${result.reason}`);
  };
  accept({ event: { type: 'xstate.init', input: { issue: ISSUE } }, source: 'person' });
  for (const line of script) {
    clock += 60_000;
    if (line === 'timer') {
      const timer = host.pending.find((p) => p.type === 'timer');
      clock = Date.parse(timer.due);
      accept({ event: timer.event, source: 'timer' });
    } else if (Array.isArray(line)) {
      const [actor, result] = line;
      const { run } = host.pending.find((p) => p.type === 'run' && p.id === actor) ?? {};
      const event = result instanceof Error ? { type: `xstate.error.actor.${actor}`, error: result.message } : { type: `xstate.done.actor.${actor}`, output: result };
      accept({ run, event, source: sourceOf(actor, result) });
    } else accept({ event: line, source: 'github' });
  }
  return host.journal;
};
