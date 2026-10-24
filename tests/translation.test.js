import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, containsChinese, recentContext, parseCodexResult, displayPages } from '../hooks/register.js';

const codexResult = (text = 'Translated text') => ({ exitCode: 0, stdout: [
  { type: 'thread.started', thread_id: 'codex-thread-123' },
  { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'not a translation' } },
  { type: 'item.completed', item: { type: 'agent_message', text } },
  { type: 'turn.completed', usage: {} },
].map(JSON.stringify).join('\n'), stderr: '' });

function harness(options = {}, store = new Map()) {
  const hooks = new Map();
  const calls = [];
  const notices = [];
  const logs = [];
  const opened = [];
  const closed = [];
  const timers = [];
  register((name, matcher, handler) => {
    hooks.set(name === 'ui.render' ? `${name}:${matcher.component}` : name, handler || matcher);
    return { catch() {} };
  }, options);
  const $ = {
    plugin: { root: '/plugin' },
    clock: { every: (ms, tick) => {
      const timer = { ms, tick, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(timer);
      return timer;
    } },
    session: { id: async () => 'session-123', cwd: async () => '/project', surfaces: async () => ['terminal'],
      messages: async () => [{ role: 'user', text: '术语是队列' }] },
    process: { run: async (argv, init) => { calls.push({ argv, init }); return codexResult(); } },
    command: { register: async () => {} },
    store: { get: async key => store.get(key), set: async (key, value) => store.set(key, value),
      delete: async key => store.delete(key) },
    ui: { toast: text => notices.push(text), log: text => logs.push(text), invalidate() {},
      open: async args => opened.push(args), close: async args => closed.push(args),
      resolve: () => Object.fromEntries(['Box', 'Text', 'Button', 'Markdown'].map(type => [type, props => ({ type, props })])) },
  };
  const run = async (name, event, final = async e => e) => {
    final.signal = new AbortController().signal;
    return hooks.get(name === 'ui.render' ? `${name}:${event.component}` : name)($, Object.freeze(event), final);
  };
  return { $, run, calls, notices, logs, store, opened, closed, timers };
}
const prompt = { text: '请修复这个 bug', origin: { kind: 'composer' }, wait: false };
const finish = { turnId: 't1', answer: 'Fixed the bug.', reason: 'answer', isAborted: false };

test('Chinese detection excludes code-only Chinese, English, and kana', () => {
  assert.equal(containsChinese('请 fix bug'), true);
  assert.equal(containsChinese('繁體中文'), true);
  for (const text of ['Hello', '```js\n// 中文\n```', '`中文`', '日本語です']) assert.equal(containsChinese(text), false);
});
test('translates input with session, transcript, context, model and stdin, preserving attachments', async () => {
  const h = harness({ codex_model: 'chosen-model' });
  await h.run('classic.SessionStart', { session_id: 'session-123', transcript_path: '/history/session-123.jsonl' });
  const attachments = [{ type: 'image', data: 'unchanged' }];
  const context = ['existing context'];
  const result = await h.run('prompt.submit', { ...prompt, attachments, context });
  assert.equal(result.text, 'Translated text');
  assert.ok(!result.text.includes('the original input is authoritative'));
  assert.equal(result.context, context);
  assert.deepEqual(context, ['existing context']);
  assert.equal(result.attachments, attachments);
  const { argv, init } = h.calls[0];
  assert.equal(argv[argv.indexOf('--model') + 1], 'chosen-model');
  assert.equal(argv[argv.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(argv.at(-1), '-');
  assert.ok(!argv.includes(prompt.text));
  const payload = JSON.parse(init.stdin.split('\n').at(-1));
  assert.equal(payload.claude_session_id, 'session-123');
  assert.equal(payload.claude_transcript_path, '/history/session-123.jsonl');
  assert.equal(payload.recent_conversation[0].text, '术语是队列');
  assert.equal(payload.source_text, prompt.text);
});
test('input toggle leaves output translation enabled; model changes apply next call', async () => {
  const h = harness();
  await h.run('command.run', { args: 'input off' });
  assert.equal((await h.run('prompt.submit', prompt)).text, prompt.text);
  await h.run('command.run', { args: 'model some-model' });
  const result = await h.run('turn.complete', finish, async () => ({ text: finish.answer, usage: { kept: true } }));
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].argv.includes('some-model'));
  assert.equal(result.text, finish.answer);
  assert.deepEqual(h.logs, []);
  assert.deepEqual(result.usage, { kept: true });
  await h.run('command.run', { args: 'output off' });
  await h.run('turn.complete', { ...finish, turnId: 't2' });
  assert.equal(h.calls.length, 1);
});
test('ignores tool notifications, English inputs, interrupted/error/subagent/empty final replies', async () => {
  const h = harness();
  await h.run('prompt.submit', { ...prompt, origin: { kind: 'task-notification' } });
  await h.run('prompt.submit', { ...prompt, text: 'English only' });
  for (const patch of [{ agentId: 'child' }, { isAborted: true, reason: 'aborted' }, { reason: 'error' }, { answer: '' }]) {
    await h.run('turn.complete', { ...finish, ...patch });
  }
  assert.equal(h.calls.length, 0);
});
test('translates only final answer, once per turn', async () => {
  const h = harness();
  for (let i = 0; i < 2; i++) await h.run('turn.complete', finish);
  assert.equal(h.calls.length, 1);
  assert.equal(JSON.parse(h.calls[0].init.stdin.split('\n').at(-1)).source_text, finish.answer);
});
test('translation failure blocks Chinese input and preserves the original assistant output', async () => {
  const h = harness();
  h.$.process.run = async () => { throw new Error('timeout'); };
  assert.ok((await h.run('prompt.submit', prompt)).drop.includes('未向 Claude 发送中文原文'));
  const original = { text: finish.answer };
  assert.equal(await h.run('turn.complete', finish, async () => original), original);
  assert.equal(h.notices.length, 1);
});
test('does not submit twice when downstream next rejects', async () => {
  const h = harness();
  let entered = 0;
  await assert.rejects(h.run('prompt.submit', prompt, async () => { entered++; throw new Error('downstream'); }));
  assert.equal(entered, 1);
});
test('Codex parsing rejects incomplete, empty, malformed and failed responses', () => {
  assert.equal(parseCodexResult(codexResult('中文')), '中文');
  for (const result of [{ exitCode: 1 }, { exitCode: 0, stdout: 'not json' },
    { exitCode: 0, stdout: '{"type":"turn.failed"}' }, codexResult(''),
    { exitCode: 0, stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}' }]) {
    assert.throws(() => parseCodexResult(result));
  }
});
test('history is bounded, keeps newest prose, excludes tool records', () => {
  assert.deepEqual(recentContext([{ role: 'user', text: '123456' }, { role: 'tool', text: 'secret' },
    { role: 'assistant', text: 'abc' }], 5), [{ role: 'user', text: '56' }, { role: 'assistant', text: 'abc' }]);
});

test('input and output reuse a persistent Codex session across plugin reloads', async () => {
  const h = harness();
  await h.run('prompt.submit', prompt);
  assert.ok(!h.calls[0].argv.includes('--ephemeral'));
  assert.ok(!h.calls[0].argv.includes('resume'));
  await h.run('turn.complete', finish);
  assert.deepEqual(h.calls[1].argv.slice(-3), ['resume', 'codex-thread-123', '-']);
  const reloaded = harness({}, h.store);
  await reloaded.run('prompt.submit', prompt);
  assert.deepEqual(reloaded.calls[0].argv.slice(-3), ['resume', 'codex-thread-123', '-']);
  reloaded.$.session.id = async () => 'another-claude-session';
  await reloaded.run('prompt.submit', prompt);
  assert.ok(!reloaded.calls[1].argv.includes('resume'));
});

test('reset creates a new session; model changes keep the association', async () => {
  const h = harness();
  await h.run('prompt.submit', prompt);
  await h.run('command.run', { args: 'model another-model' });
  await h.run('prompt.submit', prompt);
  assert.ok(h.calls[1].argv.includes('resume'));
  assert.ok(h.calls[1].argv.includes('another-model'));
  await h.run('command.run', { args: 'reset' });
  await h.run('prompt.submit', prompt);
  assert.ok(!h.calls[2].argv.includes('resume'));
});

test('concurrent translations serialize and the second resumes the first', async () => {
  const h = harness();
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  h.$.process.run = async (argv, init) => {
    h.calls.push({ argv, init });
    if (h.calls.length === 1) { started(); await held; }
    return codexResult();
  };
  const first = h.run('prompt.submit', prompt);
  await ready;
  const second = h.run('turn.complete', finish);
  assert.equal(h.calls.length, 1);
  assert.match((await h.run('command.run', { args: 'reset' })).text, /翻译进行中/);
  release();
  await Promise.all([first, second]);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls[1].argv.slice(-3), ['resume', 'codex-thread-123', '-']);
});

test('failed resume retains mapping, releases queue and does not silently start fresh', async () => {
  const h = harness();
  await h.run('prompt.submit', prompt);
  h.$.process.run = async () => ({ exitCode: 1, stdout: '', stderr: 'failed' });
  assert.ok((await h.run('prompt.submit', prompt)).drop);
  assert.equal(h.store.get('codex-session:session-123').id, 'codex-thread-123');
  h.$.process.run = async (argv, init) => { h.calls.push({ argv, init }); return codexResult(); };
  await h.run('prompt.submit', prompt);
  assert.ok(h.calls.at(-1).argv.includes('resume'));
});

const paneEvent = { component: 'Pane', requestId: 'translation', surface: 'terminal', props: { view: {} } };
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...(Array.isArray(tree.props?.children) ? tree.props.children.flatMap(nodes) : [])];
}

test('multiline output uses one native Markdown node, not per-line logs', async () => {
  const h = harness();
  const markdown = '**洛杉矶**晴朗。\n\n| 时间 | 气温 |\n|---|---|\n| 09:00 | 20°C |\n\n```js\nconst x = 1;\n```';
  h.$.process.run = async () => codexResult(markdown);
  await h.run('turn.complete', finish);
  const tree = await h.run('ui.render', paneEvent);
  const blocks = nodes(tree).filter(node => node.type === 'Markdown');
  assert.deepEqual(blocks.map(node => node.props.text), [markdown]);
  assert.deepEqual(h.logs, []);
});

test('input is paired in UI, native prompt displays original, and unrelated rows pass through', async () => {
  const h = harness();
  const submitted = await h.run('prompt.submit', prompt);
  assert.equal(h.opened.length, 0);
  const tree = await h.run('ui.render', paneEvent);
  assert.deepEqual(nodes(tree).filter(node => node.type === 'Markdown').map(node => node.props.text),
    [prompt.text, 'Translated text']);
  const view = { component: 'UserMessage', props: { text: submitted.text, onScreen: null } };
  const rendered = await h.run('ui.render', view);
  assert.equal(rendered.props.children[0].props.text, prompt.text);
  assert.equal(rendered.props.children[0].props.onScreen, null);
  assert.ok(nodes(rendered).some(node => node.type === 'Markdown' && node.props.text === 'Translated text'));
  assert.ok(submitted.text.includes('Translated text'));
  assert.ok(!JSON.stringify(submitted).includes(prompt.text));
  const unrelated = { component: 'UserMessage', props: { text: 'other user input' } };
  assert.equal(await h.run('ui.render', unrelated), unrelated);
});

test('pane supports history navigation, original toggle, show and hide', async () => {
  const h = harness();
  await h.run('prompt.submit', prompt);
  await h.run('turn.complete', finish);
  let tree = await h.run('ui.render', paneEvent);
  await nodes(tree).find(node => node.props.key === 'original').props.onPress();
  tree = await h.run('ui.render', paneEvent);
  assert.ok(nodes(tree).some(node => node.type === 'Markdown' && node.props.text === finish.answer));
  await nodes(tree).find(node => node.props.key === 'previous').props.onPress();
  tree = await h.run('ui.render', paneEvent);
  assert.ok(nodes(tree).some(node => node.type === 'Markdown' && node.props.text === prompt.text));
  await h.run('command.run', { args: 'show' });
  await h.run('command.run', { args: 'hide' });
  assert.equal(h.opened.at(-1).id, 'translation');
  assert.equal(h.closed.at(-1).id, 'translation');
  const otherPane = { ...paneEvent, requestId: 'other' };
  assert.equal(await h.run('ui.render', otherPane), otherPane);
});

test('UI failure does not prevent prompt submission and headless gets one complete log', async () => {
  const h = harness();
  h.$.ui.open = async () => { throw new Error('UI unavailable'); };
  assert.ok((await h.run('prompt.submit', prompt)).text.includes('Translated text'));
  h.$.session.surfaces = async () => [];
  h.$.process.run = async () => codexResult('第一段\n\n第二段');
  await h.run('turn.complete', finish);
  assert.deepEqual(h.logs, ['第一段\n\n第二段']);
});

test('long content is paginated without losing text or breaking Unicode', () => {
  const text = 'x'.repeat(8999) + '😀' + '\n' + '中'.repeat(11000);
  const pages = displayPages(text);
  assert.equal(pages.join(''), text);
  assert.ok(pages.every(page => page.length <= 9000 && page.isWellFormed()));
});

test('long output can be paged in the panel', async () => {
  const h = harness();
  const text = 'a'.repeat(19000);
  h.$.process.run = async () => codexResult(text);
  await h.run('turn.complete', finish);
  let tree = await h.run('ui.render', paneEvent);
  const chunks = [];
  for (let page = 0; page < 3; page++) {
    chunks.push(nodes(tree).find(node => node.type === 'Markdown').props.text);
    await nodes(tree).find(node => node.props.key === 'page-next').props.onPress();
    tree = await h.run('ui.render', paneEvent);
  }
  assert.equal(chunks.join(''), text);
});

test('Chinese output is rendered inline only on the final block of its own message', async () => {
  const h = harness();
  await h.run('turn.start', { turnId: 't1' });
  await h.run('session.append', { uuid: 'message-1', message: { type: 'assistant', content: [
    { type: 'text', text: 'First block.' }, { type: 'text', text: 'Final block.' },
  ] } });
  h.$.process.run = async () => codexResult('**中文回复**\n\n- 一条说明');
  await h.run('turn.complete', { ...finish, answer: 'First block.\nFinal block.' });
  const row = { component: 'AssistantMessage', requestId: 'message-1', props: { text: 'Final block.', isFirstOfReply: false } };
  const result = await h.run('ui.render', row);
  assert.equal(result.props.text, 'Final block.\n\n---\n\n**中文回复**\n\n- 一条说明');
  assert.equal(result.props.isFirstOfReply, false);
  const first = { ...row, props: { text: 'First block.' } };
  assert.equal(await h.run('ui.render', first), first);
  const other = { ...row, requestId: 'unrelated-message' };
  assert.equal(await h.run('ui.render', other), other);
  assert.equal(h.logs.length, 0);
  assert.equal(h.opened.length, 0);
});

test('context off uses ephemeral Codex with source text only and no history/store access', async () => {
  const h = harness({ translation_context: false });
  h.$.session.id = h.$.session.messages = h.$.store.get = h.$.store.set = async () => {
    throw new Error('must not read session context');
  };
  const result = await h.run('prompt.submit', prompt);
  assert.equal(result.text, 'Translated text');
  const { argv, init } = h.calls[0];
  assert.ok(argv.includes('--ephemeral'));
  assert.ok(!argv.includes('resume'));
  assert.deepEqual(JSON.parse(init.stdin.split('\n').at(-1)), { source_text: prompt.text });
  assert.ok(!init.stdin.includes('claude_session_id'));
  assert.ok(!init.stdin.includes('recent_conversation'));
  assert.ok(!init.stdin.includes('transcript file'));
});

test('context toggle affects input and output without deleting the existing Codex association', async () => {
  const h = harness();
  await h.run('prompt.submit', prompt);
  const saved = h.store.get('codex-session:session-123');
  const status = await h.run('command.run', { args: 'context off' });
  assert.ok(status.text.includes('关（临时会话）'));
  await h.run('turn.complete', finish);
  assert.ok(h.calls[1].argv.includes('--ephemeral'));
  assert.deepEqual(JSON.parse(h.calls[1].init.stdin.split('\n').at(-1)), { source_text: finish.answer });
  assert.equal(h.store.get('codex-session:session-123'), saved);
  await h.run('command.run', { args: 'context on' });
  await h.run('prompt.submit', prompt);
  assert.ok(h.calls[2].argv.includes('resume'));
});

test('input and output show an animated status and remove it after settling', async () => {
  for (const phase of ['input', 'output']) {
    const h = harness();
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    h.$.process.run = async () => { started(); await held; return codexResult(); };
    const pending = phase === 'input' ? h.run('prompt.submit', prompt) : h.run('turn.complete', finish);
    await ready;
    const event = { component: 'AbovePrompt', surface: 'terminal', props: { view: {}, hasSurvey: false } };
    let tree = await h.run('ui.render', event, async () => null);
    const before = nodes(tree).filter(node => node.type === 'Text').map(node => node.props.children).join(' ');
    assert.ok(before.includes(phase === 'input' ? '输入翻译为英文' : '最终回复翻译为中文'));
    h.timers[0].tick();
    tree = await h.run('ui.render', event, async () => null);
    const after = nodes(tree).filter(node => node.type === 'Text').map(node => node.props.children).join(' ');
    assert.notEqual(before, after);
    release();
    await pending;
    assert.equal(await h.run('ui.render', event), event);
    assert.equal(h.timers[0].cancelled, true);
  }
});

test('failure clears progress and model commands query sanitized model catalog', async () => {
  const h = harness();
  h.$.process.run = async () => { throw new Error('timeout'); };
  await h.run('prompt.submit', prompt);
  assert.equal(h.timers[0].cancelled, true);
  h.$.process.run = async (argv) => {
    assert.deepEqual(argv, ['python3', '/plugin/hooks/model_catalog.py', 'codex']);
    return { exitCode: 0, stdout: JSON.stringify({ configModel: 'configured-model', models: [
      { id: 'configured-model', isDefault: false }, { id: 'another-model', isDefault: true },
    ] }) };
  };
  assert.ok((await h.run('command.run', { args: 'model' })).text.includes('configured-model'));
  assert.ok((await h.run('command.run', { args: 'models' })).text.includes('another-model'));
  await h.run('command.run', { args: 'model explicit-model' });
  assert.ok((await h.run('command.run', { args: 'model' })).text.includes('explicit-model'));
});
