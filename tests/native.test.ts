import { expect, test } from 'claude-code/testing';

test('translation controls run inside the actual Mods runtime', async ($, on) => {
  const initial = await $.command.run({ command: 'translate', args: 'status' });
  expect(initial.text).toContain('输入翻译：开');
  const disabled = await $.command.run({ command: 'translate', args: 'input off' });
  expect(disabled.text).toContain('输入翻译：关');
  expect(disabled.text).toContain('最终输出翻译：开');
  const model = await $.command.run({ command: 'translate', args: 'model example-model' });
  expect(model.text).toContain('example-model');
});
