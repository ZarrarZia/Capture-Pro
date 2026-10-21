const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { outputPath, sanitize } = require('../src/main/naming');

const now = new Date(2026, 9, 21, 9, 5, 7, 42);
const base = { outputDir: 'C:\\Out', subfolder: 'none', namePrefix: 'target', customPrefix: 'Clip', nameSuffix: 'datetime' };

test('date-time suffix with target prefix', () => {
  assert.equal(outputPath(base, { kind: 'video', targetName: 'chrome', ext: 'mp4', now }), path.join('C:\\Out', 'chrome 2026-10-21 09-05-07-042.mp4'));
});

test('subfolders by type and date', () => {
  assert.equal(path.dirname(outputPath({ ...base, subfolder: 'type' }, { kind: 'image', targetName: 'x', ext: 'png', now })), path.join('C:\\Out', 'Images'));
  assert.equal(path.dirname(outputPath({ ...base, subfolder: 'date' }, { kind: 'audio', targetName: 'x', ext: 'mp3', now })), path.join('C:\\Out', '2026-10-21'));
});

test('sequence suffix skips existing files', () => {
  const taken = new Set([path.join('C:\\Out', 'Clip 0001.mp4'), path.join('C:\\Out', 'Clip 0002.mp4')]);
  const p = outputPath({ ...base, namePrefix: 'custom', nameSuffix: 'sequence' }, { kind: 'video', targetName: 'x', ext: 'mp4', now, exists: (f) => taken.has(f) });
  assert.equal(p, path.join('C:\\Out', 'Clip 0003.mp4'));
});

test('sanitize strips characters Windows forbids in file names', () => {
  assert.equal(sanitize('a:b*c?"d<e>|f/g\\h'), 'a_b_c__d_e__f_g_h');
});
