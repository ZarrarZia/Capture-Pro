const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, defaults } = require('../src/main/settings');

function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-settings-'));
  const file = path.join(dir, 'settings.json');
  if (content) fs.writeFileSync(file, JSON.stringify(content));
  try { return fn(file); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('new installs record the microphone by default', () => {
  assert.equal(defaults().audio.mic.enabled, true);
  withFile(null, (file) => assert.equal(new Settings(file).get().audio.mic.enabled, true));
});

test('settings saved by v1 (mic off by default) are upgraded once and persisted', () => {
  const v1 = defaults();
  delete v1.version;
  v1.audio.mic.enabled = false;
  withFile(v1, (file) => {
    assert.equal(new Settings(file).get().audio.mic.enabled, true);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 2);
    assert.equal(saved.audio.mic.enabled, true);
  });
});

test('a user who turns the mic off after upgrading keeps it off', () => {
  const v2 = defaults();
  v2.audio.mic.enabled = false;
  withFile(v2, (file) => assert.equal(new Settings(file).get().audio.mic.enabled, false));
});
