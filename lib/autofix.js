/**
 * Ground Control Autofix: an agent fixes the project, then Run tries again.
 *
 * Run cures the failures with a known cause by itself. Everything else used to
 * end with a message and a button that opened a chat, after which the person
 * still had to read the reply and press Run again. This module closes that
 * loop: it hands the failure to a Comms chat in the project, waits for the
 * agent's turn to finish, re-runs the project, and if it fails again hands the
 * new log back, up to MAX_ROUNDS times. It stops the moment the project runs.
 *
 * Its dependencies are injected (`comms`, `runner`, `findProject`) so the loop
 * can be tested without a `claude` CLI. It owns no processes of its own: the
 * chat is a normal Comms chat (visible and stoppable in the chat panel) and
 * each re-run is a normal Run.
 */

const MAX_ROUNDS = 3;

function createAutofix({ comms, runner, findProject }) {
  const loops = new Map();   // projectId -> loop

  function publish(loop) {
    runner.setAgent(loop.projectId, {
      state: loop.state, round: loop.round, maxRounds: MAX_ROUNDS,
      chatId: loop.chatId, note: loop.note || null,
    });
  }

  function promptFor(run, round) {
    const steps = (run.steps || []).map((s) => `- ${s.label}: \`${s.display || s.command}\` (${s.state})`).join('\n');
    const d = run.diagnosis || {};
    return [
      round === 1
        ? 'I pressed "Run" on this project in Ground Control and it failed. Find out why and fix the project so it runs.'
        : `Ground Control ran the project again after your changes (attempt ${round} of ${MAX_ROUNDS}) and it still fails. Here is the new output.`,
      '',
      'What Ground Control ran, from the project\'s own files:',
      steps,
      '',
      `Its diagnosis: ${d.title || 'none'}. ${d.detail || ''}`,
      (run.fixes || []).length ? 'It already tried, automatically: ' + run.fixes.map((f) => f.action).join(' ') : '',
      '',
      'The end of the output:',
      '```',
      runner.logTail(run, 120) || '(no output)',
      '```',
      '',
      'Rules for this fix:',
      '- Change only what is needed for the project to start. Keep the change small.',
      '- Do NOT start the app or any dev server yourself, and do not run anything that keeps running: Ground Control re-runs the project as soon as you finish, and a server you start would hold its port.',
      '- Quick checks are fine (installing a package, compiling, running the tests).',
      '- If the fix needs something only the person can provide (a secret, an account, hardware), do not guess: say exactly what is needed in one sentence.',
      '- Finish with one or two sentences saying what was wrong and what you changed.',
    ].filter((l) => l !== '').join('\n');
  }

  function waitForSettle(chatId) {
    return new Promise((resolve) => {
      const off = comms.subscribe(chatId, (event, chat) => {
        if (event === 'settled') { off(); resolve(chat); }
      });
    });
  }

  function waitForRun(projectId) {
    return new Promise((resolve) => {
      const check = (r) => r && (runner.isTerminal(r.state) || r.readyUrl || (r.state === 'running' && runningLongEnough(r)));
      const cur = runner.get(projectId);
      if (check(cur)) return resolve(cur);
      const off = runner.subscribe(projectId, (event, r) => { if (event === 'state' && check(r)) { off(); clearInterval(poll); resolve(r); } });
      // A desktop app or a server with no address never becomes "ready" by
      // address; still running after a while counts as started.
      const poll = setInterval(() => { const r = runner.get(projectId); if (check(r)) { off(); clearInterval(poll); resolve(r); } }, 2000);
      if (poll.unref) poll.unref();
    });
  }

  function runningLongEnough(r) {
    const starts = (r.steps || []).filter((s) => s.kind === 'start');
    return starts.length > 0 && starts.every((s) => s.state === 'running' && s.startedAt && Date.now() - s.startedAt > 15000);
  }

  async function begin(projectId, run) {
    const existing = loops.get(projectId);
    if (existing && (existing.state === 'fixing' || existing.state === 'rerunning')) return existing;
    const project = await findProject(projectId);
    if (!project) throw Object.assign(new Error('that project is no longer being watched'), { status: 409 });
    const loop = { projectId, round: 0, chatId: null, state: 'fixing', note: null, stopped: false, choices: run.choices || {}, open: run.openOnReady };
    loops.set(projectId, loop);
    drive(loop, project, run).catch((err) => {
      loop.state = 'gave-up';
      loop.note = `The agent could not run: ${(err && err.message) || err}`;
      publish(loop);
    });
    return loop;
  }

  async function drive(loop, project, failedRun) {
    let run = failedRun;
    while (!loop.stopped) {
      loop.round += 1;
      loop.state = 'fixing';
      loop.note = null;
      publish(loop);
      if (!loop.chatId) loop.chatId = comms.startChat({ project }).id;
      const settled = waitForSettle(loop.chatId);
      comms.send(loop.chatId, promptFor(run, loop.round));
      const chat = await settled;
      if (loop.stopped) break;
      if (!chat || chat.state === 'error') {
        loop.state = 'gave-up';
        loop.note = 'The agent\'s turn failed. Its message is in the chat below.';
        return publish(loop);
      }

      loop.state = 'rerunning';
      publish(loop);
      await runner.start(project, { choices: loop.choices, open: loop.open });
      run = await waitForRun(project.id);
      if (loop.stopped) break;
      if (run && !(runner.isTerminal(run.state) && run.state !== 'done')) {
        loop.state = 'fixed';
        loop.note = loop.round === 1 ? 'An agent fixed it and Run started it again.' : `An agent fixed it after ${loop.round} attempts.`;
        return publish(loop);
      }
      if (run && run.diagnosis && run.diagnosis.needs === 'you') {
        loop.state = 'gave-up';
        loop.note = 'What is left needs you: see below.';
        return publish(loop);
      }
      if (loop.round >= MAX_ROUNDS) {
        loop.state = 'gave-up';
        loop.note = `Still failing after ${MAX_ROUNDS} attempts by an agent. Its notes are in the chat below.`;
        return publish(loop);
      }
    }
    loop.state = 'stopped';
    publish(loop);
  }

  function stop(projectId) {
    const loop = loops.get(projectId);
    if (!loop) return;
    loop.stopped = true;
    if (loop.chatId) { try { comms.stop(loop.chatId, 'stopped from the Run panel'); } catch { /* already idle */ } }
    loop.state = 'stopped';
    publish(loop);
  }

  function get(projectId) { return loops.get(projectId) || null; }

  return { begin, stop, get, promptFor, MAX_ROUNDS };
}

export { createAutofix, MAX_ROUNDS };
