// 与 scenario.json 一致的内存假来源，支持故障注入，用于不依赖网络的判定测试。
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(readFileSync(new URL('../scenario.json', import.meta.url), 'utf8'));

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

const releases = [
  {
    phase0: [
      { id: 'Z-17', validFrom: '2026-11-01', tileKeys: ['west', 'east'], overlapPolicy: '并列待问询' },
    ],
    phase1: [
      { id: 'Z-17', validFrom: '2026-11-01', tileKeys: ['west', 'east'], overlapPolicy: '并列待问询' },
      { id: 'Z-18', validFrom: '2026-12-10', tileKeys: ['west', 'east', 'north'], overlapPolicy: '并列待问询' },
    ],
  },
];

const cells = {
  'Z-17|west': { complete: true, records: [{ unit: 'W', feature: 1, polygon: rect(0, 0, 6, 9) }] },
  'Z-17|east': { complete: true, records: [{ unit: 'E', feature: 1, polygon: rect(6, 0, 10, 9) }] },
  'Z-18|west': { complete: false, subcells: ['west-south', 'west-north'], records: [] },
  'Z-18|west-south': { complete: true, records: [{ unit: 'W', feature: 1, polygon: rect(0, 0, 5, 4) }] },
  'Z-18|west-north': { complete: true, records: [{ unit: 'W', feature: 2, polygon: rect(0, 4, 5, 9) }] },
  'Z-18|east': { complete: true, records: [{ unit: 'E', feature: 1, polygon: rect(5, 0, 10, 9) }] },
  'Z-18|north': { complete: true, records: [{ unit: 'N', feature: 1, polygon: rect(4, 5, 8, 9) }] },
};

const parcelP9 = rect(6, 1, 9, 3);
const clauses = {
  'Z-17': [
    { id: 'E-5', level: '单元', unit: 'E', use: '精密装配', limit: '备查工艺清单', document: 'D60' },
    { id: 'W-1', level: '单元', unit: 'W', use: '精密装配', limit: '施工车辆限时', document: 'D61' },
  ],
  'Z-18': [
    { id: 'E-5', level: '单元', unit: 'E', use: '精密装配', limit: '备查工艺清单', document: 'D60' },
    { id: 'W-1', level: '单元', unit: 'W', use: '精密装配', limit: '施工车辆限时', document: 'D61' },
    { id: 'N-2', level: '单元', unit: 'N', use: '精密装配', limit: '不登记夜间装卸', document: 'D65' },
    { id: 'P-9', level: '地块', unit: 'E', use: '精密装配', limit: '提交夜间声源说明', document: 'D62', parcel: parcelP9 },
    { id: 'U-2', level: '暂停', unit: 'E', use: '精密装配', pauseTarget: 'P-9', document: 'D63',
      fromDate: '2026-12-15', throughDate: '2026-12-17' },
  ],
};

const documentsPhase0 = [
  { release: 'Z-17', document: 'D60', text: '东区工艺资料备查通知' },
  { release: 'Z-17', document: 'D61', text: '西区施工车辆时段' },
];
const documentsPhase1 = [
  ...documentsPhase0,
  { release: 'Z-18', document: 'D61', text: '西区施工车辆时段' },
  { release: 'Z-18', document: 'D60', text: '东区工艺资料备查通知' },
  { release: 'Z-18', document: 'D62', text: '东区地块夜间声源告知' },
  { release: 'Z-18', document: 'D63', text: '十二月临时暂停条款' },
];

const fulfillmentPhase0 = [
  { requestKey: 'C-14-Z17-W', release: 'Z-17', unit: 'W', document: 'D61', state: 'staged' },
];
const fulfillmentPhase1 = [
  { requestKey: 'C-14-Z17-W', release: 'Z-17', unit: 'W', document: 'D61', state: 'delivered', text: '西区施工车辆时段' },
  { requestKey: 'C-14-Z18-N', release: 'Z-18', unit: 'N', document: 'D65', state: 'staged' },
];

export const exampleRequest = {
  consultation: 'C-14',
  use: '精密装配',
  opening: '2026-12-16',
  boundary: { type: 'Polygon', coordinates: [rect(3, 2, 10, 6)] },
};

export function buildFake(options = {}) {
  const state = {
    phase: options.phase ?? 1,
    cellOverrides: options.cellOverrides ?? {},
    failCells: new Set(options.failCells ?? []),
    extraCells: options.extraCells ?? {},
    documentsOverride: options.documentsOverride,
    fulfillmentOverride: options.fulfillmentOverride,
    orders: new Map(),
    orderLog: [],
  };

  const client = {
    async listReleases() {
      return state.phase === 0 ? releases[0].phase0 : releases[0].phase1;
    },
    async getCell(release, cell) {
      const key = release + '|' + cell;
      if (state.failCells.has(key)) throw new Error('模拟分片取件失败：' + key);
      if (state.cellOverrides[key]) return structuredClone(state.cellOverrides[key]);
      if (state.extraCells[key]) return structuredClone(state.extraCells[key]);
      const payload = cells[key];
      if (!payload) throw new Error('查无网格 ' + key);
      return structuredClone(payload);
    },
    async listClauses(release) {
      return structuredClone(clauses[release] ?? []);
    },
    async listDocuments() {
      if (state.documentsOverride) return structuredClone(state.documentsOverride);
      return structuredClone(state.phase === 0 ? documentsPhase0 : documentsPhase1);
    },
    async listFulfillment() {
      if (state.fulfillmentOverride) return structuredClone(state.fulfillmentOverride);
      return structuredClone(state.phase === 0 ? fulfillmentPhase0 : fulfillmentPhase1);
    },
    async placeOrder(order) {
      state.orderLog.push(structuredClone(order));
      const key = order.requestKey;
      if (state.orders.has(key)) return { state: '已受理', receipt: 'R-DUP', submitted: order };
      state.orders.set(key, order);
      return { state: '已受理', receipt: 'R-' + key, submitted: order };
    },
    async getOrder(requestKey) {
      const submitted = state.orders.get(requestKey);
      if (!submitted) throw new Error('查无受理');
      return { state: '已受理', receipt: 'R-' + requestKey, submitted };
    },
  };
  return { client, state, fixture };
}
