import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const html = await readFile(new URL('index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('app.js', import.meta.url), 'utf8');
const nodes = new Map();
function element() {
  return {
    value: '', textContent: '', innerHTML: '', dataset: {}, disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    listeners: {},
    addEventListener(name, listener) { this.listeners[name] = listener; },
    setAttribute() {},
    appendChild() {},
    insertBefore(option) { this.options.push(option); },
  };
}
for (const match of html.matchAll(/id="([^"]+)"/g)) nodes.set(`#${match[1]}`, element());
nodes.set('.metric-card.gain', element());
nodes.set('.results-section', element());
nodes.get('#phase1ModelSelect').options = [...html.matchAll(/option value="([^"]+)"/g)].map((match) => ({ value: match[1] }));
const requests = [];
let failStage = null;
let failUpload = false;
const sandbox = vm.createContext({
  document: {
    querySelector(selector) { assert.ok(nodes.has(selector), `Missing ${selector}`); return nodes.get(selector); },
    createElement: element,
  },
  performance, AbortSignal, setTimeout,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
  fetch: async (url, options) => {
    if (url === '/api/config') return { ok: true, json: async () => ({ hasApiKey: true, hasStorage: true, oldModel: 'gpt-4o', newModel: 'configured-model' }) };
    if (url === '/api/upload') {
      requests.push({ upload: true });
      if (failUpload) return { ok: false, json: async () => ({ error: 'Upload unavailable' }) };
      return { ok: true, json: async () => ({ imageUrl: 'https://example.com/test.png', storageMs: 1 }) };
    }
    const body = JSON.parse(options.body);
    requests.push(body);
    const failed = body.flow === 'phase1' && body.stage === failStage;
    return { ok: !failed, json: async () => failed ? { error: 'Model unavailable' } : {
      model: body.flow === 'old' ? 'gpt-4o' : body.model,
      result: body.stage === 'basic' ? { productName: 'Sản phẩm mẫu', category: 'Đồ gia dụng', confidence: 0.9, moderation: { allowed: true } } : { attributes: [{ key: 'Màu', value: 'Đen' }] },
    } };
  },
});
vm.runInContext(source, sandbox);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(nodes.get('#phase1ModelSelect').value, 'gpt-4o');
assert.equal(nodes.get('#newModelDisplay').textContent, 'gpt-4o');
assert.ok(nodes.get('#phase1ModelSelect').options.some((option) => option.value === 'configured-model'));
assert.equal(nodes.get('#runButton').disabled, true);
vm.runInContext("showSelectedFile({name:'test.png',type:'image/png',size:100})", sandbox);
for (const model of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'custom']) {
  requests.length = 0;
  nodes.get('#phase1ModelSelect').value = model;
  nodes.get('#phase1ModelInput').value = 'custom-model';
  vm.runInContext('updateModelSelection()', sandbox);
  const running = vm.runInContext('startBenchmark()', sandbox);
  assert.equal(nodes.get('#phase1ModelSelect').disabled, true);
  await vm.runInContext('startBenchmark()', sandbox);
  await running;
  assert.equal(requests.filter((request) => request.upload).length, 1);
  assert.equal(requests.filter((request) => request.flow === 'phase1').length, 2);
  assert.ok(requests.filter((request) => request.flow === 'phase1').every((request) => request.model === (model === 'custom' ? 'custom-model' : model)));
  assert.ok(requests.filter((request) => request.flow === 'old').every((request) => !Object.hasOwn(request, 'model')));
  assert.equal(nodes.get('#phase1ModelSelect').disabled, false);
}
const previousModel = nodes.get('#newModelDisplay').textContent;
nodes.get('#phase1ModelSelect').value = 'gpt-4o';
vm.runInContext('updateModelSelection()', sandbox);
assert.equal(nodes.get('#newModelDisplay').textContent, previousModel);
nodes.get('#phase1ModelSelect').value = 'custom';
nodes.get('#phase1ModelInput').value = '<invalid>';
vm.runInContext('updateModelSelection()', sandbox);
assert.equal(nodes.get('#runButton').disabled, true);
nodes.get('#phase1ModelSelect').value = 'gpt-4o';
failStage = 'basic';
await vm.runInContext('startBenchmark()', sandbox);
assert.match(nodes.get('#decisionText').textContent, /Chưa đủ kết quả/);
failStage = 'attributes';
await vm.runInContext('startBenchmark()', sandbox);
assert.match(nodes.get('#decisionText').textContent, /chưa có đủ chi tiết/);
failUpload = true;
await vm.runInContext('startBenchmark()', sandbox);
assert.equal(nodes.get('#imageUrlText').textContent, '');
assert.equal(nodes.get('#uploadInfo').textContent, 'Gửi ảnh không thành công');
assert.equal(nodes.get('#savedMetric').textContent, '—');
assert.equal(nodes.get('#runButton').disabled, false);
nodes.get('#fileInput').listeners.change({ target: { files: [{ type: 'image/svg+xml', size: 100 }] } });
assert.match(nodes.get('#fileError').textContent, /Chọn ảnh/);

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url), env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout')), 5000);
    server.once('error', reject);
    server.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  for (const resource of ['/', '/app.js', '/styles.css']) assert.equal((await fetch(address + resource)).status, 200);
  for (const resource of ['/.env', '/server.mjs', '/README.md', '/package.json']) assert.equal((await fetch(address + resource)).status, 404);
  const response = await fetch(address + '/api/analyze', { method: 'POST', body: JSON.stringify({ flow: 'phase1', stage: 'basic', imageUrl: 'https://example.com/test.png', model: '<invalid>' }) });
  assert.equal(response.status, 400);
} finally {
  server.kill();
  await once(server, 'exit');
}
const protectedServer = spawn(process.execPath, ['server.mjs'], {
  cwd: new URL('.', import.meta.url),
  env: { PATH: process.env.PATH, HOST: '127.0.0.1', PORT: '0', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
try {
  const address = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Protected server startup timeout')), 5000);
    protectedServer.once('error', reject);
    protectedServer.stdout.on('data', (chunk) => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  assert.equal((await fetch(address + '/health')).status, 200);
  const landing = await fetch(address);
  assert.equal(landing.status, 200);
  const landingHtml = await landing.text();
  assert.match(landingHtml, /Bắt đầu so sánh/);
  assert.ok(!landingHtml.includes('type="password"'));
  assert.equal(landing.headers.get('www-authenticate'), null);
  assert.equal(landing.headers.get('set-cookie'), null);
  for (const resource of ['/api/config', '/app.js', '/styles.css']) {
    assert.equal((await fetch(address + resource)).status, 200);
  }
  const headers = {};
  assert.equal((await fetch(address, { headers })).status, 200);
  assert.equal((await fetch(address + '/.env', { headers })).status, 404);
  const config = await (await fetch(address + '/api/config', { headers })).json();
  assert.deepEqual(config.allowedModels, ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']);
  assert.equal(config.newModel, 'gpt-4o');
  assert.ok(!Object.keys(config).some((key) => /password|secret|token/i.test(key)));
  assert.equal((await fetch(address + '/api/upload', { method: 'POST', headers: { ...headers, Origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(address + '/api/analyze', { method: 'POST', headers, body: 'null' })).status, 400);
  const request = { flow: 'phase1', stage: 'basic', imageUrl: 'https://example.com/test.png', model: 'not-allowed' };
  assert.equal((await fetch(address + '/api/analyze', { method: 'POST', headers, body: JSON.stringify(request) })).status, 400);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    assert.equal((await fetch(address + '/api/upload', { method: 'POST', headers })).status, 503);
  }
  const limited = await fetch(address + '/api/upload', { method: 'POST', headers });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  for (let attempt = 0; attempt < 78; attempt += 1) {
    assert.equal((await fetch(address + '/api/analyze', { method: 'POST', headers, body: '{}' })).status, 400);
  }
  assert.equal((await fetch(address + '/api/analyze', { method: 'POST', headers, body: '{}' })).status, 429);
} finally {
  protectedServer.kill();
  await once(protectedServer, 'exit');
}
console.log('PASS: model selection, locked run, payloads, stale labels, errors, file validation, static allowlist.');
console.log('PASS: public production access without login, health check, CSRF, model allowlist, invalid JSON, upload/AI quotas; no paid calls.');
