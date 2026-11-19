import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createSource } from '../source.mjs';

const server = createSource().listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const cliPath = new URL('../lib/cli.mjs', import.meta.url).pathname;

const workdir = await mkdtemp(join(tmpdir(), 'eia-cli-'));

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, stdout, stderr }));
  });
}

async function setPhase(phase) {
  const response = await fetch(origin + '/replay/phase', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phase }),
  });
  assert.deepEqual(await response.json(), { phase });
}

const requestPath = join(workdir, 'request.json');
await writeFile(requestPath, JSON.stringify({
  consultation: 'C-14',
  use: '精密装配',
  opening: '2026-12-16',
  boundary: {
    type: 'Polygon',
    coordinates: [[[3, 2], [10, 2], [10, 6], [3, 6], [3, 2]]],
  },
}));

test.after(async () => {
  server.close();
  await once(server, 'close');
});

test('阶段0 咨询：按当时目录给出 Z-17 双单元确定结论', async () => {
  await setPhase(0);
  const out = join(workdir, 'phase0.json');
  const result = await runCli(['consult', '--request', requestPath, '--origin', origin, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const d = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(d.status, '确定');
  assert.equal(d.release.id, 'Z-17');
  assert.deepEqual(d.coverage.queriedCells, ['west', 'east']);
  assert.equal(d.units.length, 2);
  assert.equal(d.conflicts.length, 0);
  assert.equal(d.contacts[0].contact, 'segment');
});

test('阶段1 咨询：截断分片递归查齐，冲突按门户口径标注，缺件不阻塞已查实单元', async () => {
  await setPhase(1);
  const out = join(workdir, 'phase1.json');
  const result = await runCli(['consult', '--request', requestPath, '--origin', origin, '--out', out]);
  assert.equal(result.code, 0, result.stderr);
  const d = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(d.release.id, 'Z-18');
  assert.equal(d.coverage.complete, true);
  assert.ok(d.coverage.queriedCells.includes('west-south'));
  assert.ok(d.coverage.queriedCells.includes('west-north'));
  assert.equal(d.status, '部分确定');
  assert.deepEqual(d.conflicts.map(c => c.policy), ['并列待问询', '并列待问询']);
  assert.equal(d.inquiryRequired, true);
  const n = d.units.find(u => u.unit === 'N');
  assert.equal(n.status, '待补证');
  // 旧调件号的 Z-17 交付不得计入 Z-18
  assert.ok(d.staleFulfillment.some(s => s.release === 'Z-17' && s.ignored));
});

test('调件下单后轮询：staged 不冒充交付，交付后转确定', async () => {
  const ordered = join(workdir, 'ordered.json');
  const placed = await runCli(['consult', '--request', requestPath, '--order', '--origin', origin, '--out', ordered]);
  assert.equal(placed.code, 0, placed.stderr);
  const before = JSON.parse(await readFile(ordered, 'utf8'));
  const nBefore = before.units.find(u => u.unit === 'N');
  assert.equal(nBefore.evidence[0].status, 'staged');
  assert.equal(nBefore.status, '待补证');

  const polled = join(workdir, 'polled.json');
  const poll = await runCli(['poll', '--prior', ordered, '--origin', origin, '--out', polled]);
  assert.equal(poll.code, 0, poll.stderr);
  const after = JSON.parse(await readFile(polled, 'utf8'));
  // 轮询固定原发布编号，不会漂移到其他发布
  assert.equal(after.snapshot.release, 'Z-18');
  assert.equal(after.units.find(u => u.unit === 'N').status, '待补证');
});

test('复核：边界调整后逐段给出暂停引用/等待补件/未受影响并控制重发', async () => {
  const adjusted = join(workdir, 'adjusted.json');
  await writeFile(adjusted, JSON.stringify({
    consultation: 'C-14',
    use: '精密装配',
    opening: '2026-12-16',
    boundary: {
      type: 'Polygon',
      coordinates: [[[6.5, 2], [10, 2], [10, 8], [6.5, 8], [6.5, 2]]],
    },
  }));
  const reviewOut = join(workdir, 'review.json');
  const review = await runCli([
    'review', '--prior', join(workdir, 'phase1.json'),
    '--request', adjusted, '--origin', origin, '--out', reviewOut,
  ]);
  assert.equal(review.code, 0, review.stderr);
  const r = JSON.parse(await readFile(reviewOut, 'utf8'));
  const map = Object.fromEntries(r.paragraphs.map(p => [`${p.unit}/${p.clause}`, p.disposition]));
  assert.equal(map['W/W-1'], '立即暂停引用');
  assert.equal(map['E/E-5'], '未受影响');
  assert.equal(map['N/N-2'], '等待补件');
  assert.equal(r.resend.canResend, false);
  assert.equal(r.boundaryChange.removedArea, 14);
  assert.ok(r.resend.unaffectedBasis[0].basis[0].release === 'Z-18');
});

test('固定旧发布编号复核，且缺少必填参数时返回非零退出码', async () => {
  const bad = await runCli(['consult', '--origin', origin]);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /--request/);

  const pinned = await runCli([
    'consult', '--request', requestPath, '--release', 'Z-17', '--origin', origin,
  ]);
  assert.equal(pinned.code, 0, pinned.stderr);
  const d = JSON.parse(pinned.stdout);
  assert.equal(d.release.id, 'Z-17');
  assert.equal(d.releaseSelection.reason, '按指定发布编号复核');
});
