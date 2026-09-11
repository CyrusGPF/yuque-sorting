import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/directory-picker.ts'], bundle: true, write: false, format: 'esm' });
const { chooseDirectory } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
test('native directory selection preserves absolute paths and cancellation leaves input unchanged', async () => {
  let options;
  const load = () => ({ dialog: { showOpenDialog: async value => { options = value; return { canceled: false, filePaths: ['C:\\笔记库'] }; } } });
  assert.equal(await chooseDirectory(load, '选择目标目录', 'C:\\'), 'C:\\笔记库');
  assert.ok(options.properties.includes('openDirectory'));
  assert.equal(await chooseDirectory(() => ({ dialog: { showOpenDialog: async () => ({ canceled: true }) } }), '目录', ''), null);
});
test('Windows fallback passes user paths only as environment data and opens no console', async () => {
  let args, options;
  const unsafe = 'C:\\name;$(anything)';
  const load = name => {
    if (name === 'electron') return {};
    if (name === '@electron/remote') throw new Error('not available');
    if (name === 'process') return { platform: 'win32', env: {} };
    if (name === 'child_process') return { execFile: (_file, values, config, callback) => { args = values; options = config; callback(null, 'C:\\chosen'); } };
    throw new Error(name);
  };
  assert.equal(await chooseDirectory(load, '目录', unsafe), 'C:\\chosen');
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.YQ_PICK_INITIAL, unsafe);
  assert.ok(!args.join(' ').includes(unsafe));
});
test('only automatic copy entry points remain and both directory fields expose the picker', async () => {
  const source = await readFile('main.ts', 'utf8');
  assert.doesNotMatch(source, /openVaultTransfer|exportVaultTransfer|importVaultTransfer|手动顺序包/);
  assert.match(source, /pathRow\("源库或源库指定目录", false\)/);
  assert.match(source, /pathRow\("当前库或者当前库的目录", true\)/);
  assert.match(source, /预检并处理冲突/);
});
