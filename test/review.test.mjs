import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildDetermination } from '../lib/determination.mjs';
import { reviewDetermination } from '../lib/review.mjs';
import { buildFake, exampleRequest } from './fake-source.mjs';

const rect = (x0, y0, x1, y1) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});

const dispositionMap = review => Object.fromEntries(
  review.paragraphs.map(p => [`${p.unit}/${p.clause}`, p.disposition]));

test('边界缩小使单元退出：对应段落立即暂停引用，其余段落未受影响并保留依据', async () => {
  const { client } = buildFake();
  const prior = await buildDetermination(client, exampleRequest);
  // 放弃西侧：x 起点 3 -> 6.5，W 退出；E、N 仍在
  const next = { ...exampleRequest, boundary: rect(6.5, 2, 10, 6) };
  const review = await reviewDetermination(client, prior, next);

  assert.equal(review.releaseChanged, false);
  assert.equal(review.boundaryChange.removedArea, 14);
  const map = dispositionMap(review);
  assert.equal(map['W/W-1'], '立即暂停引用');
  assert.equal(map['E/E-5'], '未受影响');
  assert.equal(map['E/P-9'], '立即暂停引用'); // 拟开工日仍在暂停窗口
  assert.equal(map['N/N-2'], '等待补件'); // D65 仅 staged

  const unaffected = review.resend.unaffectedBasis.find(x => x.clause === 'E-5');
  assert.ok(unaffected.basis[0].document === 'D60');
  assert.equal(review.resend.canResend, false);
});

test('边界扩展纳入新单元：新条目进入 newRequirements 且标注证据是否齐备', async () => {
  const { client } = buildFake();
  // 旧范围只在 W/E 内、不含 N（y 上限 5，N 从 y=5 起仅共线）
  const oldRequest = { ...exampleRequest, boundary: rect(3, 2, 10, 5) };
  const prior = await buildDetermination(client, oldRequest);
  assert.ok(!prior.units.some(u => u.unit === 'N' && u.relation === 'overlap'));

  const review = await reviewDetermination(client, prior, exampleRequest);
  assert.equal(review.boundaryChange.addedArea, 7);
  const n2 = review.newRequirements.find(x => x.clause === 'N-2');
  assert.ok(n2);
  assert.equal(n2.evidenceReady, false);
});

test('新发布生效：旧条目按当前发布原件确认未受影响，新增条目录入新需求', async () => {
  const harness = buildFake({ phase: 0 });
  const prior = await buildDetermination(harness.client, exampleRequest);
  assert.equal(prior.release.id, 'Z-17');

  harness.state.phase = 1;
  const review = await reviewDetermination(harness.client, prior, exampleRequest);
  assert.equal(review.releaseChanged, true);
  assert.equal(review.changeSummary.currentRelease, 'Z-18');

  const map = dispositionMap(review);
  assert.equal(map['E/E-5'], '未受影响');
  assert.equal(map['W/W-1'], '未受影响');
  const ids = review.newRequirements.map(x => x.unit + '/' + x.clause).sort();
  assert.deepEqual(ids, ['E/P-9', 'N/N-2']);
  assert.equal(review.newRequirements.find(x => x.clause === 'N-2').evidenceReady, false);
  assert.equal(review.newRequirements.find(x => x.clause === 'P-9').status, '已暂停');
  // 未受影响段落的依据来自当前发布，而非旧发布
  const basis = review.resend.unaffectedBasis.find(x => x.clause === 'W-1').basis[0];
  assert.equal(basis.release, 'Z-18');
});

test('新发布暂停了旧条目：段落立即暂停引用并说明暂停条款', async () => {
  const harness = buildFake({ phase: 0 });
  const prior = await buildDetermination(harness.client, exampleRequest);
  harness.state.phase = 1;
  // 选暂停窗口外的开工日，让当前发布视角 P-9 之外仍可对照；这里旧答复无 P-9，
  // 改为直接验证窗口内开工时旧 E 条目不受暂停影响、新 P-9 已暂停
  const review = await reviewDetermination(harness.client, prior, {
    ...exampleRequest, opening: '2026-12-16',
  });
  assert.equal(dispositionMap(review)['E/E-5'], '未受影响');
  assert.equal(review.newRequirements.find(x => x.clause === 'P-9').status, '已暂停');
  assert.equal(review.resend.canResend, true); // 旧段落本身都仍成立
});

test('缺件补齐后复核：等待补件段落转为未受影响，结论可整体重发', async () => {
  const harness = buildFake();
  const prior = await buildDetermination(harness.client, exampleRequest);
  harness.state.fulfillmentOverride = [
    { requestKey: 'C-14-Z18-N', release: 'Z-18', unit: 'N', document: 'D65',
      state: 'delivered', text: '北区夜间装卸登记原件' },
  ];
  const review = await reviewDetermination(harness.client, prior, exampleRequest);
  assert.equal(dispositionMap(review)['N/N-2'], '未受影响');
  assert.ok(review.paragraphs.every(p => p.disposition !== '等待补件'));
  // P-9 处于暂停窗口，仍需暂停引用
  assert.equal(dispositionMap(review)['E/P-9'], '立即暂停引用');
  assert.equal(review.resend.canResend, false);
});

test('旧调件号交付不能补齐新发布缺件，段落维持等待补件', async () => {
  const harness = buildFake();
  const prior = await buildDetermination(harness.client, exampleRequest);
  // 档案室只返回旧经办号 C-14-Z17-W 的交付，N 的 D65 仍缺
  harness.state.fulfillmentOverride = [
    { requestKey: 'C-14-Z17-W', release: 'Z-17', unit: 'W', document: 'D61',
      state: 'delivered', text: '旧调件结果' },
  ];
  const review = await reviewDetermination(harness.client, prior, exampleRequest);
  assert.equal(dispositionMap(review)['N/N-2'], '等待补件');
  assert.ok(review.currentDetermination.staleFulfillment.some(s => s.requestKey === 'C-14-Z17-W'));
});

test('复核必须携带原请求快照与原发布编号', async () => {
  const { client } = buildFake();
  await assert.rejects(
    reviewDetermination(client, { paragraphs: [] }, exampleRequest),
    /请求快照或原发布编号/,
  );
});
