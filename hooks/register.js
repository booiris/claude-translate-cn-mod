// No Node imports: Claude Mods execute in a restricted JS runtime.
export function containsChinese(text) {
  // Han is shared with Japanese; do not classify kana-containing input as Chinese.
  const prose = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, '');
  return /\p{Script=Han}/u.test(prose) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(prose);
}

export function translationPrompt(text, target) {
  return JSON.stringify({ target_language: target === 'en' ? 'English' : 'Simplified Chinese', source_text: text });
}

function instructionArgs($, sessionId, transcriptPath) {
  const context = sessionId
    ? { claude_session_id: sessionId, claude_transcript_path: transcriptPath || null }
    : null;
  const instructions = context
    ? 'Use translation history for terminology; read_claude_transcript can supply context if needed. If unavailable, use existing text. Session: ' + JSON.stringify(context)
    : 'Translate only the current source_text; no external context.';
  return ['-c', `model_instructions_file=${JSON.stringify(`${$.plugin.root}/hooks/translation-instructions.txt`)}`,
    '-c', `developer_instructions=${JSON.stringify(instructions)}`, '-c', 'project_doc_max_bytes=0'];
}

export function parseCodexResult(result, withSession = false) {
  if (result.exitCode !== 0) throw new Error(`Codex 退出码 ${result.exitCode}`);
  let answer = '';
  let completed = false;
  let sessionId;
  let usage;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error('Codex 返回了无效 JSONL'); }
    if (event.type === 'turn.failed' || event.type === 'error') throw new Error('Codex 翻译失败');
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') sessionId = event.thread_id;
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') answer = event.item.text;
    if (event.type === 'turn.completed') {
      completed = true;
      usage = tokenUsage(event.usage);
    }
  }
  if (!completed || typeof answer !== 'string' || !answer.trim()) throw new Error('Codex 未返回完整译文');
  return withSession ? { text: answer, sessionId, ...(usage ? { usage } : {}) } : answer;
}

// Preserve unknown counters as unknown rather than reporting zero usage.
function tokenUsage(usage) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const counters = {
    input_tokens: count(usage?.input_tokens),
    output_tokens: count(usage?.output_tokens),
    cached_input_tokens: count(usage?.cached_input_tokens),
  };
  return Object.values(counters).some(value => value !== null) ? counters : undefined;
}

function usageFooter(card) {
  const usage = tokenUsage(card.usage);
  const parts = [];
  if (usage) parts.push(`Input token: ${usage.input_tokens ?? '未知'} · Output token: ${usage.output_tokens ?? '未知'} · Cache token: ${usage.cached_input_tokens ?? '未知'}`);
  if (Number.isFinite(card.elapsedMs) && card.elapsedMs >= 0) parts.push(`耗时: ${(card.elapsedMs / 1000).toFixed(1)}s`);
  return parts.join(' · ');
}

function displayedTranslation(card) {
  const footer = usageFooter(card);
  return card.translated + (footer ? `\n\n${footer}` : '');
}

function waitWithSignal(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new Error('翻译已取消')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}

async function runTranslation($, argv, init, signal) {
  if (signal.aborted) throw new Error('翻译已取消');
  const runner = ['python3', `${$.plugin.root}/hooks/translation_runner.py`,
    '--transcript', init.transcriptPath || '', '--', ...argv];
  const stream = $.process.spawn({ argv: runner, cwd: init.cwd, input: init.stdin });
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = $.clock.after(init.timeoutMs, () => reject(new Error('Codex 翻译超时')));
    });
    const read = async () => {
      let stdout = '';
      while (true) {
        const chunk = await stream.next();
        if (chunk.done) return { exitCode: chunk.value?.code ?? 1, stdout, stderr: '' };
        if (chunk.value.stream === 'stdout') {
          stdout += chunk.value.text;
          if (stdout.length > 4 * 1024 * 1024) throw new Error('Codex 翻译输出过长');
        }
      }
    };
    return await waitWithSignal(Promise.race([read(), timeout]), signal);
  } finally {
    timer?.cancel();
    // The Mods streaming process API kills the child when its stream closes.
    // Close the stream before allowing another call to resume the same session.
    await stream.return().catch(() => {});
  }
}

async function translate($, text, target, config, paths, queues, signal) {
  const started = await $.clock.now();
  const result = await performTranslation($, text, target, config, paths, queues, signal);
  return { ...result, elapsedMs: Math.max(0, await $.clock.now() - started) };
}

async function performTranslation($, text, target, config, paths, queues, signal) {
  if (!config.context) {
    if (signal.aborted) throw new Error('翻译已取消');
    const argv = [config.binary, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--ephemeral', '--color', 'never', '--json', '-c', 'approval_policy="never"',
      ...instructionArgs($)];
    if (config.model) argv.push('--model', config.model);
    argv.push('-');
    return parseCodexResult(await runTranslation($, argv, {
      stdin: translationPrompt(text, target), timeoutMs: config.timeout,
    }, signal), true);
  }
  const sessionId = await $.session.id();
  const previous = queues.get(sessionId) || Promise.resolve();
  let release;
  const slot = new Promise(resolve => { release = resolve; });
  const pending = previous.then(() => slot);
  queues.set(sessionId, pending);
  try {
    await waitWithSignal(previous, signal);
    if (signal.aborted) throw new Error('翻译已取消');
    const key = `codex-session:${sessionId}`;
    const saved = await $.store.get(key);
    const transcriptPath = paths.get(sessionId) || null;
    // Resumed threads retain their original developer instructions. Start fresh
    // when the instruction format or transcript path changes.
    const resumeId = saved?.instructionVersion === 7 && saved?.transcriptPath === transcriptPath &&
      saved?.binary === config.binary && typeof saved?.id === 'string' ? saved.id : null;
    const cwd = await $.session.cwd();
    // exec options precede the resume subcommand (resume has no --sandbox flag).
    const argv = [config.binary, 'exec', '--sandbox', 'read-only', '--skip-git-repo-check',
      '--color', 'never', '--json', '-c', 'approval_policy="never"',
      ...instructionArgs($, sessionId, paths.get(sessionId))];
    if (config.model) argv.push('--model', config.model);
    if (resumeId) argv.push('resume', resumeId);
    argv.push('-');
    const result = await runTranslation($, argv, {
      cwd, transcriptPath,
      stdin: translationPrompt(text, target),
      timeoutMs: config.timeout,
    }, signal);
    const parsed = parseCodexResult(result, true);
    const id = parsed.sessionId || resumeId;
    if (!id) throw new Error('Codex 未返回会话 ID');
    const cumulativeUsage = parsed.usage;
    if (resumeId && cumulativeUsage) {
      parsed.usage = Object.fromEntries(Object.entries(cumulativeUsage).map(([name, value]) => {
        const previous = saved.usage?.[name];
        return [name, Number.isSafeInteger(value) && Number.isSafeInteger(previous) && value >= previous
          ? value - previous : null];
      }));
    }
    await $.store.set(key, { id, binary: config.binary, instructionVersion: 7, transcriptPath, usage: cumulativeUsage });
    return parsed;
  } finally {
    release();
    void pending.then(() => {
      if (queues.get(sessionId) === pending) queues.delete(sessionId);
    });
  }
}

function beginProgress($, progress, kind, config) {
  const id = ++progress.sequence;
  progress.jobs.set(id, { kind, model: config.model || 'Codex 默认模型', context: config.context });
  if (!progress.timer) progress.timer = $.clock.every(120, () => {
    progress.frame++;
    $.ui.invalidate('ui.render');
  });
  $.ui.invalidate('ui.render');
  return id;
}

function endProgress($, progress, id) {
  progress.jobs.delete(id);
  if (!progress.jobs.size && progress.timer) {
    progress.timer.cancel();
    progress.timer = null;
    progress.frame = 0;
  }
  $.ui.invalidate('ui.render');
}

async function modelCatalog($, binary) {
  const result = await $.process.run(['python3', `${$.plugin.root}/hooks/model_catalog.py`, binary], { timeoutMs: 20000 });
  if (result.exitCode !== 0) throw new Error('无法查询 Codex 模型目录');
  return JSON.parse(result.stdout);
}

// Keep each Markdown node within the host limit, without splitting surrogate pairs.
export function displayPages(text, limit = 9000) {
  const pages = [];
  let remaining = text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < limit / 2) end = limit;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    pages.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  pages.push(remaining);
  return pages;
}

async function openPanel($) {
  if ((await $.session.surfaces()).length) {
    await $.ui.open({ id: 'translation', title: '翻译', rows: 22, columns: 64 });
  }
}

function addCard(state, card) {
  state.cards.push(card);
  // UI history is bounded separately from the complete Claude/Codex histories.
  while (state.cards.length > 20 || (state.cards.length > 1 &&
    state.cards.reduce((size, item) => size + item.original.length + item.translated.length, 0) > 200000)) state.cards.shift();
  state.selected = state.cards.length - 1;
  state.page = 0;
  state.showOriginal = card.kind === 'input';
}

function renderPanel($, e, state) {
  const { Box, Text, Button, Markdown } = $.ui.resolve(e);
  const card = state.cards[state.selected];
  const children = [Box({ flexDirection: 'row', justifyContent: 'space-between', children: [
    Text({ bold: true, children: '翻译' }),
    Button({ key: 'close', label: '关闭', onPress: () => $.ui.close({ id: 'translation' }) }),
  ] })];
  if (!card) {
    children.push(Text({ dimColor: true, children: '输入原文、英文译文与最终中文回复会显示在这里。' }));
  } else {
    children.push(Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'previous', label: '上一条', onPress: () => {
        state.selected = Math.max(0, state.selected - 1); state.page = 0;
        $.ui.invalidate('ui.render');
      } }),
      Text({ dimColor: true, children: `${state.selected + 1} / ${state.cards.length}` }),
      Button({ key: 'next', label: '下一条', onPress: () => {
        state.selected = Math.min(state.cards.length - 1, state.selected + 1); state.page = 0;
        $.ui.invalidate('ui.render');
      } }),
      Button({ key: 'original', label: state.showOriginal ? '收起原文' : '查看原文', onPress: () => {
        state.showOriginal = !state.showOriginal; state.page = 0; $.ui.invalidate('ui.render');
      } }),
    ] }));
    const sourcePages = displayPages(card.original);
    const translatedPages = displayPages(card.translated);
    const pageCount = Math.max(translatedPages.length, state.showOriginal ? sourcePages.length : 0);
    const page = Math.min(state.page, pageCount - 1);
    if (state.showOriginal && sourcePages[page] !== undefined) {
      children.push(Text({ dimColor: true, children: card.kind === 'input' ? '原始输入' : 'Claude 原文' }));
      children.push(Markdown({ text: sourcePages[page], dimColor: true }));
    }
    if (translatedPages[page] !== undefined) children.push(Markdown({ text: translatedPages[page] }));
    if (page === translatedPages.length - 1 && usageFooter(card)) {
      children.push(Text({ dimColor: true, children: usageFooter(card) }));
    }
    if (pageCount > 1) children.push(Box({ flexDirection: 'row', gap: 1, children: [
      Button({ key: 'page-back', label: '上一页', onPress: () => {
        state.page = Math.max(0, page - 1); $.ui.invalidate('ui.render');
      } }),
      Text({ dimColor: true, children: `${page + 1} / ${pageCount} 页` }),
      Button({ key: 'page-next', label: '下一页', onPress: () => {
        state.page = Math.min(pageCount - 1, page + 1); $.ui.invalidate('ui.render');
      } }),
    ] }));
  }
  return Box({ flexDirection: 'column', gap: 1, paddingX: 1, children });
}

// UI-only cache; never included in translationPrompt or session messages.
const validCard = card => card && ['input', 'output'].includes(card.kind) &&
  typeof card.sessionId === 'string' && typeof card.messageId === 'string' &&
  typeof card.original === 'string' && typeof card.translated === 'string' &&
  (card.kind === 'input' || typeof card.lastBlock === 'string');
function loadHistory($, cache) {
  if (!cache.ready) cache.ready = (async () => {
    try {
      const saved = await $.store.get('translation-ui:v1');
      if (saved?.version === 1 && Array.isArray(saved.cards)) cache.cards = saved.cards.filter(validCard);
    } catch {
      cache.writable = false;
      $.ui.toast('翻译显示缓存读取失败；本次翻译仍可使用，但旧译文暂时无法恢复。');
    }
  })();
  return cache.ready;
}
async function restorePanel($, panel, cache) {
  await loadHistory($, cache);
  const sessionId = await $.session.id();
  if (panel.sessionId !== sessionId) {
    panel.cards = []; panel.selected = 0; panel.page = 0; panel.showOriginal = false;
    panel.sessionId = sessionId;
    panel.lastAssistant = null;
    for (const card of cache.cards.filter(card => card.sessionId === sessionId)) {
      addCard(panel, { ...card, ...(card.kind === 'input' ? { submitted: card.translated } : {}) });
    }
  }
  return sessionId;
}
async function saveCard($, cache, sessionId, card) {
  if (!card.messageId || (card.kind === 'output' && typeof card.lastBlock !== 'string')) return;
  await loadHistory($, cache);
  if (!cache.writable) return;
  const saved = { sessionId, messageId: card.messageId, kind: card.kind,
    original: card.original, translated: card.translated,
    ...(Number.isFinite(card.elapsedMs) && card.elapsedMs >= 0 ? { elapsedMs: card.elapsedMs } : {}),
    ...(tokenUsage(card.usage) ? { usage: tokenUsage(card.usage) } : {}),
    ...(card.kind === 'output' ? { lastBlock: card.lastBlock } : {}) };
  if (JSON.stringify({ version: 1, cards: [saved] }).length > 800000) {
    $.ui.toast('这条译文超过显示缓存容量，当前仍可查看，但恢复会话后无法自动显示。');
    return;
  }
  cache.cards = cache.cards.filter(item => !(item.sessionId === sessionId &&
    item.messageId === card.messageId && item.kind === card.kind));
  cache.cards.push(saved);
  // $.store has a 4 MiB total limit. Reserve space for Codex associations;
  // 800k UTF-16 units of JSON occupy at most 2.4 MB of UTF-8.
  let serialized = JSON.stringify({ version: 1, cards: cache.cards });
  while (serialized.length > 800000 && cache.cards.length) {
    cache.cards.shift();
    serialized = JSON.stringify({ version: 1, cards: cache.cards });
  }
  const snapshot = JSON.parse(serialized);
  cache.writes = cache.writes.then(() => $.store.set('translation-ui:v1', snapshot)).catch(() => {
    if (!cache.warning) {
      cache.warning = true;
      $.ui.toast('译文已显示，但本地缓存保存失败；恢复会话时可能无法显示这次译文。');
    }
  });
  await cache.writes;
}
async function savedCard($, panel, cache, kind, messageId) {
  const sessionId = await restorePanel($, panel, cache);
  return cache.cards.findLast(card => card.sessionId === sessionId &&
    card.kind === kind && card.messageId === messageId);
}
export function register(on, options = {}) {
  const config = {
    input: options.input_translation ?? true,
    output: options.output_translation ?? true,
    context: options.translation_context ?? false,
    model: options.codex_model || '',
    binary: options.codex_binary || 'codex',
    timeout: Math.min(600000, Math.max(1000, Number(options.timeout_ms) || 120000)),
  };
  const paths = new Map();
  const completed = new Set();
  const queues = new Map();
  const panel = { cards: [], selected: 0, page: 0, showOriginal: false, sessionId: null, lastAssistant: null };
  const progress = { jobs: new Map(), sequence: 0, frame: 0, timer: null };
  const cache = { cards: [], ready: null, writable: true, warning: false, writes: Promise.resolve() };

  on('turn.start', async ($, e, next) => {
    panel.lastAssistant = null;
    return next(e);
  });

  on('classic.SessionStart', async ($, e, next) => {
    paths.set(e.session_id, e.transcript_path);
    const result = await next(e);
    await restorePanel($, panel, cache);
    $.ui.invalidate('ui.render');
    return result;
  });
  on('session.append', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) return result;
    const sessionId = await restorePanel($, panel, cache);
    if (!e.agentId && result.message?.type === 'assistant') {
      const texts = result.message.content.filter(block => block.type === 'text').map(block => block.text);
      panel.lastAssistant = { id: result.uuid, texts };
    } else if (!e.agentId && result.message?.type === 'user') {
      const text = result.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const card = panel.cards.findLast(item => item.kind === 'input' && !item.messageId && item.submitted === text);
      if (card) {
        card.messageId = result.uuid;
        await saveCard($, cache, sessionId, card);
      }
    }
    return result;
  });
  // Also learns the path on hot reload, when SessionStart has already fired.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    paths.set(e.session_id, e.transcript_path);
    return next(e);
  });
  on('classic.Stop', async ($, e, next) => {
    paths.set(e.session_id, e.transcript_path);
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'translate', description: 'Codex 翻译开关及模型设置',
      argumentHint: '[show | hide | status | input/output/context on/off | model [ID/default] | models | reset]' });
    const result = await next(e);
    await restorePanel($, panel, cache);
    $.ui.invalidate('ui.render');
    return result;
  });
  on('command.run', { command: 'translate' }, async ($, e) => {
    const [action = 'status', ...rest] = e.args.trim().split(/\s+/).filter(Boolean);
    const value = rest.join(' ');
    if (action === 'show' && !value) {
      await restorePanel($, panel, cache);
      await openPanel($);
      return {};
    } else if (action === 'hide' && !value) {
      await $.ui.close({ id: 'translation' });
      return {};
    } else if (['input', 'output', 'context'].includes(action) && ['on', 'off'].includes(value)) {
      config[action] = value === 'on';
    } else if ((action === 'model' || action === 'models') && !value) {
      const selected = `当前选择：${config.model || 'default（沿用 Codex 配置）'}`;
      if (action === 'model' && config.model) return { text: `${selected}\n使用 /translate models 查看可选 ID。` };
      try {
        const catalog = await modelCatalog($, config.binary);
        const current = `${selected}\nCodex 配置模型：${catalog.configModel || '未显式配置（使用 Codex 默认值）'}`;
        if (action === 'model') return { text: `${current}\n使用 /translate models 查看可选 ID。` };
        return { text: `${current}\n\n可选模型 ID：\n${catalog.models.map(model =>
          `- ${model.id}${model.isDefault ? '（推荐默认）' : ''}${model.id === config.model ? ' ← 已选择' : ''}`
        ).join('\n') || '当前账号未返回可选模型。'}\n\n切换：/translate model 模型ID` };
      } catch {
        return { text: `${selected}\n模型目录查询失败，请检查 python3、Codex 登录及网络。仍可用 /translate model 模型ID 手动指定。` };
      }
    } else if (action === 'model' && value) {
      config.model = value === 'default' ? '' : value;
    } else if (action === 'reset' && !value) {
      const sessionId = await $.session.id();
      if (queues.has(sessionId)) return { text: '翻译进行中，请完成后再执行 /translate reset。' };
      await $.store.delete(`codex-session:${sessionId}`);
      return { text: '已清除当前 Claude 会话的 Codex 关联，下次翻译将新建会话；旧 Codex 历史仍保留。' };
    } else if (action !== 'status' || value) {
      return { text: '用法：/translate [show | hide | status | input/output/context on/off | model [模型ID/default] | models | reset]' };
    }
    return { text: `输入翻译：${config.input ? '开' : '关'}；最终输出翻译：${config.output ? '开' : '关'}；上下文：${config.context ? '开（复用会话）' : '关（临时会话）'}；Codex 模型：${config.model || '默认'}（设置仅当前加载期间有效，持久设置请使用 /config）` };
  });
  on('prompt.submit', async ($, e, next) => {
    if (!['composer', 'bridge', 'sdk'].includes(e.origin?.kind)) return next(e);
    if (!config.input || !containsChinese(e.text)) return next(e);
    const sessionId = await restorePanel($, panel, cache);
    let translation;
    const job = beginProgress($, progress, 'input', config);
    try {
      translation = await translate($, e.text, 'en', { ...config }, paths, queues, next.signal);
    } catch {
      if (next.signal.aborted) return { drop: '翻译已取消' };
      return { drop: '输入翻译失败，未向 Claude 发送中文原文。检查 Codex 登录、模型或超时后重试；会话已删除时用 /translate reset。' };
    } finally {
      endProgress($, progress, job);
    }
    if (next.signal.aborted) return { drop: '翻译已取消' };
    const { text, usage, elapsedMs } = translation;
    // Original is UI-only state. Never append it to Claude's prompt or context.
    if (panel.sessionId === sessionId) {
      addCard(panel, { kind: 'input', original: e.text, translated: text, submitted: text, usage, elapsedMs });
    }
    $.ui.invalidate('ui.render');
    return next({
      ...e,
      text,
    });
  }).catch(async ($, e, next) => {
    // Never re-enter the downstream chain after it already accepted a prompt.
    if (next.called) throw new Error('下游输入处理失败');
    return { drop: '输入翻译不可用，未发送原文，请重试。' };
  });
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!progress.jobs.size || e.props.hasSurvey || e.props.view?.agentId) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    return Box({ flexDirection: 'column', children: [
      await next(e),
      ...Array.from(progress.jobs.values()).map(job => Box({ flexDirection: 'column', children: [
        Text({ color: 'cyan', children: `${frames[progress.frame % frames.length]} ${job.kind === 'input'
          ? '正在将输入翻译为英文…' : '正在将最终回复翻译为中文…'}` }),
        Text({ dimColor: true, children: `${job.model} · ${job.context ? '使用会话上下文' : '无上下文 · 临时会话'}` }),
      ] })),
    ] });
  });
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== 'translation') return next(e);
    if (e.props.view?.agentId) return next(e);
    await restorePanel($, panel, cache);
    return renderPanel($, e, panel);
  });
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.view?.agentId) return next(e);
    const restored = await savedCard($, panel, cache, 'input', e.requestId);
    const card = restored?.translated === e.props.text ? restored :
      panel.cards.findLast(item => item.kind === 'input' && item.submitted === e.props.text &&
        (item.messageId ? item.messageId === e.requestId : true));
    if (!card) return next(e);
    const original = await next({ ...e, props: { ...e.props, text: card.original } });
    const { Box, Markdown, Text } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [
      original,
      Box({ flexDirection: 'column', marginLeft: 2, marginTop: 1, children: [
        ...displayPages(card.translated).map(text => Markdown({ text, dimColor: true })),
        ...(usageFooter(card) ? [Text({ dimColor: true, children: usageFooter(card) })] : []),
      ] }),
    ] });
  });
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.view?.agentId) return next(e);
    const restored = await savedCard($, panel, cache, 'output', e.requestId);
    const card = restored || panel.cards.find(item => item.kind === 'output' && item.messageId === e.requestId);
    // A reply may contain several text blocks. Append only beneath its last one.
    if (!card || e.props.text !== card.lastBlock) return next(e);
    const original = await next(e);
    const { Box, Markdown, Text } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [
      original,
      Box({ flexDirection: 'column', marginLeft: 2, marginTop: 1, children: [
        Text({ dimColor: true, children: '─'.repeat(32) }),
        ...displayPages(card.translated).map(text => Markdown({ text })),
        ...(usageFooter(card) ? [Text({ dimColor: true, children: usageFooter(card) })] : []),
      ] }),
    ] });
  });
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (!config.output || e.agentId || e.isAborted || !['answer', 'refusal'].includes(e.reason) || !e.answer.trim()) return result;
    const sessionId = await restorePanel($, panel, cache);
    const key = `${sessionId}:${e.turnId}`;
    if (completed.has(key)) return result;
    completed.add(key);
    if (completed.size > 256) completed.delete(completed.values().next().value);
    // Snapshot before awaiting Codex: a later turn must not steal this reply's ID.
    const reply = panel.lastAssistant;
    const job = beginProgress($, progress, 'output', config);
    try {
      const { text, usage, elapsedMs } = await translate($, e.answer, 'zh', { ...config }, paths, queues, next.signal);
      if (next.signal.aborted) return result;
      const card = { kind: 'output', original: e.answer, translated: text, usage, elapsedMs,
        messageId: reply?.id, lastBlock: reply?.texts.at(-1) };
      if (panel.sessionId === sessionId) addCard(panel, card);
      await saveCard($, cache, sessionId, card);
      if ((await $.session.surfaces()).length) {
        $.ui.invalidate('ui.render');
        if (!reply?.id) $.ui.toast('中文译文已完成，输入 /translate show 查看。');
      } else {
        // Headless consumers receive one complete ui_log event, not N log rows.
        $.ui.log(displayedTranslation(card));
      }
      return result;
    } catch {
      completed.delete(key);
      if (next.signal.aborted) return result;
      $.ui.toast('最终回复翻译失败，原文已保留；检查 Codex 登录、模型和超时；会话已删除时用 /translate reset。');
      return result;
    } finally {
      endProgress($, progress, job);
    }
  });
}
