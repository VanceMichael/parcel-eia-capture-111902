import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ringArea,
  intersectConvex,
  classify,
  boundaryContact,
  sameFeature,
  relationBetween,
  unionArea,
  gridDiff,
  pointInRing,
} from '../lib/geometry.mjs';

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

test('闭合矩形面积精确', () => {
  assert.equal(ringArea(rect(0, 0, 6, 9)), 54);
  assert.equal(ringArea(rect(3, 2, 10, 6)), 28);
});

test('相交裁剪给出实质交叠多边形与面积', () => {
  const cut = intersectConvex(rect(3, 2, 10, 6), rect(0, 4, 5, 9));
  assert.ok(cut);
  assert.equal(ringArea(cut), 4);
  const result = classify(rect(3, 2, 10, 6), rect(0, 4, 5, 9));
  assert.equal(result.relation, 'overlap');
  assert.equal(result.area, 4);
});

test('共线边界只算接触、面积为零', () => {
  const result = classify(rect(0, 0, 6, 9), rect(6, 0, 10, 9));
  assert.equal(result.relation, 'contact');
  assert.equal(result.contact, 'segment');
  assert.equal(result.area, 0);
  assert.equal(boundaryContact(rect(0, 0, 1, 1), rect(1, 0, 2, 1)), 'segment');
});

test('仅角点接触单独识别为 point', () => {
  const result = classify(rect(0, 0, 1, 1), rect(1, 1, 2, 2));
  assert.equal(result.relation, 'contact');
  assert.equal(result.contact, 'point');
  assert.equal(result.area, 0);
});

test('分离多边形不产生交叠或接触', () => {
  assert.equal(classify(rect(0, 0, 1, 1), rect(2, 2, 3, 3)).relation, 'disjoint');
});

test('点在环内判定', () => {
  assert.equal(pointInRing([5, 5], rect(0, 0, 10, 10)), true);
  assert.equal(pointInRing([11, 5], rect(0, 0, 10, 10)), false);
});

test('重复分片按 unit+feature 与几何一致性识别', () => {
  const a = { unit: 'W', feature: 1, polygon: rect(0, 0, 5, 4) };
  const b = { unit: 'W', feature: 1, polygon: [[0, 0], [5, 0], [5, 4], [0, 4], [0, 0]] };
  const c = { unit: 'W', feature: 1, polygon: rect(0, 0, 5, 5) };
  const d = { unit: 'W', feature: 2, polygon: rect(0, 0, 5, 4) };
  assert.equal(sameFeature(a, b), true);
  assert.equal(sameFeature(a, c), false);
  assert.equal(sameFeature(a, d), false);
});

test('单元关系取最强接触、交叠面积走并集避免重复计数', () => {
  const touch = relationBetween([rect(0, 0, 5, 4)], [rect(5, 0, 9, 4)]);
  assert.equal(touch.relation, 'contact');
  assert.equal(touch.contact, 'segment');
  const overlap = relationBetween([rect(0, 0, 10, 10)], [rect(4, 4, 8, 8)]);
  assert.equal(overlap.relation, 'overlap');
  assert.equal(overlap.area, 16);
  // 两个相交矩形：面积 28 与 16，重叠 4，并集 40，不重复计数
  const union = unionArea([rect(3, 2, 10, 6), rect(4, 5, 8, 9)]);
  assert.equal(union, 40);
});

test('边界差异统计新增与退出条带', () => {
  const diff = gridDiff([rect(0, 0, 10, 10)], [rect(0, 0, 12, 10)]);
  assert.equal(diff.addedArea, 20);
  assert.equal(diff.removedArea, 0);
  assert.equal(diff.added[0].polygon[1][0], 12);
  const shrink = gridDiff([rect(0, 0, 10, 10)], [rect(2, 0, 10, 10)]);
  assert.equal(shrink.removedArea, 20);
  assert.equal(shrink.addedArea, 0);
});
