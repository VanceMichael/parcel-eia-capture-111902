import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDetermination, selectRelease, collectFeatures } from '../lib/determination.mjs';
import { buildFake, exampleRequest } from './fake-source.mjs';

const rect = (x0, y0, x1, y1) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

test('按拟开工日选择有效发布：未来开工取最新、过早开工无发布、可固定编号', () => {
  const releases = [
    { id: 'Z-17', validFrom: '2026-11-01', tileKeys: [] },
    { id: 'Z-18', validFrom: '2026-12-10', tileKeys: [] },
  ];
  assert.equal(selectRelease(releases, '2026-12-16').release.id, 'Z-18');
  assert.equal(selectRelease(releases, '2026-12-09').release.id, 'Z-17');
  assert.equal(selectRelease(releases, '2026-10-31').release, null);
  const pinned = selectRelease(releases, '2026-12-16', 'Z-17');
  assert.equal(pinned.release.id, 'Z-17');
  assert.equal(pinned.reason, '按指定发布编号复核');
});

test('截断分片必须沿子网格递归，预览记录不得充当完整证据', async () => {
  const { client } = buildFake();
  const coverage = await collectFeatures(client, 'Z-18', ['west']);
  assert.deepEqual(coverage.queriedCells, ['west', 'west-south', 'west-north']);
  assert.deepEqual(coverage.truncatedCells, [{ cell: 'west', subcells: ['west-south', 'west-north'] }]);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.features.length, 2);
});

test('子网格取件失败时登记缺口并保留已取得部分', async () => {
  const { client } = buildFake({ failCells: ['Z-18|west-north'] });
  const coverage = await collectFeatures(client, 'Z-18', ['west', 'east', 'north']);
  assert.equal(coverage.complete, false);
  assert.deepEqual(coverage.gaps.map(g => g.cell), ['west-north']);
  assert.ok(coverage.features.some(f => f.unit === 'W' && f.feature === 1));
});

test('同 unit+feature 重复分片去重，几何冲突记为缺口', async () => {
  // east 分片重复发布 west-south 的 W f1（同单元同特征同几何）
  const { client: dupClient } = buildFake({
    cellOverrides: { 'Z-18|east': { complete: true, records: [
      { unit: 'E', feature: 1, polygon: [[5, 0], [10, 0], [10, 9], [5, 9], [5, 0]] },
      { unit: 'W', feature: 1, polygon: [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] },
    ] } },
  });
  const coverage = await collectFeatures(dupClient, 'Z-18', ['west', 'east']);
  assert.equal(coverage.features.filter(f => f.unit === 'W').length, 2);
  assert.deepEqual(coverage.duplicateRecords.map(d => d.unit + d.feature), ['W1']);

  // west-north 除 W f2 外，带回同编号 W f1 但几何不同（与 west-south 的 f1 冲突）
  const conflictCell = {
    complete: true,
    records: [
      { unit: 'W', feature: 2, polygon: [[0, 4], [5, 4], [5, 9], [0, 9], [0, 4]] },
      { unit: 'W', feature: 1, polygon: [[0, 0], [5, 0], [5, 5], [0, 5], [0, 0]] },
    ],
  };
  const { client: badClient } = buildFake({ cellOverrides: { 'Z-18|west-north': conflictCell } });
  const bad = await collectFeatures(badClient, 'Z-18', ['west']);
  assert.equal(bad.complete, false);
  assert.match(bad.gaps[0].error, /几何不一致/);
});

test('阶段0：单发布双单元、共线接触不计面积，公开原件齐备即确定', async () => {
  const { client } = buildFake({ phase: 0 });
  const d = await buildDetermination(client, exampleRequest);
  assert.equal(d.status, '确定');
  assert.equal(d.release.id, 'Z-17');
  const w = d.units.find(u => u.unit === 'W');
  const e = d.units.find(u => u.unit === 'E');
  assert.equal(w.restrictedArea, 12);
  assert.equal(e.restrictedArea, 16);
  assert.equal(w.status, '确定');
  assert.equal(e.status, '确定');
  assert.deepEqual(d.conflicts, []);
  assert.equal(d.contacts[0].contact, 'segment');
  assert.equal(d.inquiryRequired, false);
  assert.deepEqual(d.paragraphs.map(p => p.paragraphId), ['P1', 'P2']);
});

test('阶段1：递归覆盖、限制面积、同层冲突并列待问询、暂停与补证分区呈现', async () => {
  const { client } = buildFake();
  const d = await buildDetermination(client, exampleRequest);
  assert.equal(d.status, '部分确定');
  assert.equal(d.coverage.complete, true);
  assert.deepEqual(d.coverage.queriedCells, ['west', 'east', 'north', 'west-south', 'west-north']);

  const byUnit = Object.fromEntries(d.units.map(u => [u.unit, u]));
  assert.equal(byUnit.W.restrictedArea, 8);
  assert.equal(byUnit.E.restrictedArea, 20);
  assert.equal(byUnit.N.restrictedArea, 4);
  assert.equal(byUnit.N.status, '待补证');
  assert.deepEqual(byUnit.N.missingDocuments.map(m => m.document), ['D65']);

  const p9 = byUnit.E.entries.find(x => x.id === 'P-9');
  assert.equal(p9.status, '已暂停');
  assert.equal(p9.pausedBy[0].id, 'U-2');
  assert.deepEqual(p9.documents, ['D62', 'D63']);
  const n2 = byUnit.N.entries.find(x => x.id === 'N-2');
  assert.equal(n2.status, '适用');

  assert.deepEqual(d.conflicts.map(c => c.units.join('/')).sort(), ['E/N', 'N/W']);
  assert.ok(d.conflicts.every(c => c.policy === '并列待问询' && c.level === '单元'));
  assert.equal(d.inquiryRequired, true);
  assert.equal(d.contacts[0].units.join('/'), 'E/W');
});

test('开工日不在暂停窗口内时地块补充函恢复适用', async () => {
  const { client } = buildFake();
  const d = await buildDetermination(client, { ...exampleRequest, opening: '2026-12-18' });
  const e = d.units.find(u => u.unit === 'E');
  const p9 = e.entries.find(x => x.id === 'P-9');
  assert.equal(p9.status, '适用');
  assert.deepEqual(p9.pausedBy, []);
});

test('仅与地块共线或点接触时补充函不适用，列入 notApplicable 且不出段落', async () => {
  const { client } = buildFake();
  // 项目范围只在 P-9 地块（y 1..3）下方共线 y=1
  const request = { ...exampleRequest, boundary: rect(6, 0, 9, 1) };
  const d = await buildDetermination(client, request);
  const e = d.units.find(u => u.unit === 'E');
  assert.ok(e.notApplicable.some(x => x.id === 'P-9' && /接触/.test(x.reason)));
  assert.ok(!e.entries.some(x => x.id === 'P-9'));
});

test('档案室只认本次发布本次经办号：旧调件结果标 stale 且不能凑齐新版', async () => {
  const { client } = buildFake();
  const d = await buildDetermination(client, exampleRequest);
  const stale = d.staleFulfillment;
  assert.equal(stale.length, 1);
  assert.equal(stale[0].requestKey, 'C-14-Z17-W');
  assert.equal(stale[0].ignored, true);
  const n = d.units.find(u => u.unit === 'N');
  // D65 在本次经办号下仅 staged，仍属缺件，不能因为旧 Z-17 已交付而判定完成
  assert.equal(n.evidence[0].status, 'staged');
  assert.equal(n.status, '待补证');
});

test('其他发布中的同编号原件不能用于本次发布', async () => {
  const { client } = buildFake({
    // 只给 Z-17 的 D60，Z-18 条目所需 D60 在公开目录缺失
    documentsOverride: [
      { release: 'Z-17', document: 'D60', text: '旧版工艺资料' },
      { release: 'Z-17', document: 'D61', text: '旧版车辆时段' },
    ],
  });
  const d = await buildDetermination(client, exampleRequest);
  const e = d.units.find(u => u.unit === 'E');
  const d60 = e.evidence.find(x => x.document === 'D60');
  assert.equal(d60.status, 'wrongRelease');
  assert.deepEqual(d60.availableInReleases, ['Z-17']);
  assert.equal(e.status, '待补证');
});

test('--order 时按单元提交调件并回填 staged，交付后判定转确定', async () => {
  const harness = buildFake();
  const before = await buildDetermination(harness.client, exampleRequest, { placeOrders: true });
  assert.equal(harness.state.orderLog.length, 1);
  assert.deepEqual(harness.state.orderLog[0].documents, ['D65']);
  assert.equal(harness.state.orderLog[0].requestKey, 'C-14-Z18-N');
  assert.equal(before.units.find(u => u.unit === 'N').evidence[0].status, 'staged');

  // 档案室逐件交付后再次判定
  harness.state.fulfillmentOverride = [
    { requestKey: 'C-14-Z18-N', release: 'Z-18', unit: 'N', document: 'D65',
      state: 'delivered', text: '北区夜间装卸登记原件' },
  ];
  const after = await buildDetermination(harness.client, exampleRequest);
  const n = after.units.find(u => u.unit === 'N');
  assert.equal(n.evidence[0].status, 'delivered');
  assert.equal(n.status, '确定');
  assert.equal(after.status, '确定');
});

test('覆盖不完整时整体无法确定，但已查实单元仍可单独给出', async () => {
  const { client } = buildFake({ failCells: ['Z-18|north'] });
  const d = await buildDetermination(client, exampleRequest);
  assert.equal(d.status, '无法确定');
  assert.match(d.reason, /分片存在缺口/);
  assert.ok(d.units.some(u => u.unit === 'E' && u.status === '确定'));
  assert.equal(d.gaps[0].cell, 'north');
});

test('拟开工日早于任何发布时无法给出确定答复', async () => {
  const { client } = buildFake();
  const d = await buildDetermination(client, { ...exampleRequest, opening: '2026-01-01' });
  assert.equal(d.status, '无法确定');
  assert.equal(d.units.length, 0);
});

test('仅线/点接触的单元单独显示，不产生限制面积与条目', async () => {
  const { client } = buildFake();
  // 边界完全落在 W 内并在 x=5 与 E 共线（E 在 Z-18 自 x=5 起）
  const request = { ...exampleRequest, boundary: rect(0, 4.5, 5, 5.5) };
  const d = await buildDetermination(client, request);
  const e = d.units.find(u => u.unit === 'E');
  assert.equal(e.relation, 'contact');
  assert.equal(e.contact, 'segment');
  assert.equal(e.restrictedArea, 0);
  assert.equal(e.entries.length, 0);
});
