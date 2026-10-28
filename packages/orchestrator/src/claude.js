// Sessions as headless Claude runs (claude -p): the sessions port outside Projects. Each job runs in its
// own session with exactly the job's tools, all allowed, and Claude Code holds the claim to the schema.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** The sessions port: (job, { signal }) => { claim, source }, source naming the session. */
export const claudeSessions = ({ model = 'haiku' } = {}) => ({ prompt, cwd, tools, schema }, { signal }) =>
  new Promise((resolve, reject) => {
    const session = randomUUID();
    const args = ['-p', prompt, '--model', model, '--session-id', session, '--output-format', 'json', '--json-schema', JSON.stringify(schema), '--tools', tools.join(','), ...(tools.length ? ['--allowedTools', ...tools] : [])];
    const child = spawn('claude', args, { cwd, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        const result = JSON.parse(stdout);
        if (result.is_error || !result.structured_output) throw new Error(result.result || `claude exited with ${code}`);
        resolve({ claim: result.structured_output, source: `claude:${session}` });
      } catch (err) {
        reject(err);
      }
    });
  });
