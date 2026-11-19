// 查件判定核心：把来源服务的目录、分片、条款、原件与档案室交付组合成
// 可追溯的分区适用性结论。所有确定性结论都要求地图、条款与原件同属一次有效发布。

import {
  classify,
  relationBetween,
  sameFeature,
  unionArea,
} from './geometry.mjs';

const inDateRange = (date, from, through) =>
  (!from || date >= from) && (!through || date <= through);

// 按拟开工日选择当前有效发布：validFrom <= opening 中最新的一次；
// 目录与分片发布时间不同步时，仍以目录中的有效发布为准，缺口在覆盖阶段暴露。
export function selectRelease(releases, opening, preferredId) {
  const effective = releases
    .filter(release => release.validFrom <= opening)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  if (preferredId) {
    const pinned = releases.find(release => release.id === preferredId);
    if (!pinned) {
      return { release: null, reason: '指定的发布编号不在目录中', effective: effective.map(r => r.id) };
    }
    if (pinned.validFrom > opening) {
      return { release: pinned, reason: '该发布在拟开工日尚未生效，仅用于历史复核', effective: effective.map(r => r.id) };
    }
    return { release: pinned, reason: '按指定发布编号复核', effective: effective.map(r => r.id) };
  }
  if (effective.length === 0) {
    return { release: null, reason: '拟开工日早于目录中任何一次发布的生效日', effective: [] };
  }
  return { release: effective[effective.length - 1], reason: '按拟开工日取最新有效发布', effective: effective.map(r => r.id) };
}

// 递归收集分片：complete=false 只给预览，不能证明完整，必须沿 subcells 继续；
// 任一子片取不到都登记缺口，保留已取得部分，让顾问看到仍缺哪个区和版本。
export async function collectFeatures(client, release, cells) {
  const queue = [...cells];
  const queriedCells = [];
  const truncatedCells = [];
  const gaps = [];
  const features = [];
  const duplicateRecords = [];
  const visited = new Set();

  while (queue.length > 0) {
    const cell = queue.shift();
    const key = release + '|' + cell;
    if (visited.has(key)) continue;
    visited.add(key);
    let payload;
    try {
      payload = await client.getCell(release, cell);
    } catch (error) {
      gaps.push({ release, cell, error: error.message });
      continue;
    }
    queriedCells.push(cell);
    if (payload.complete === false) {
      truncatedCells.push({ cell, subcells: payload.subcells ?? [] });
      // 截断页 records 只是预览，不作为完整证据；继续查子网格。
      for (const sub of payload.subcells ?? []) {
        if (!visited.has(release + '|' + sub)) queue.push(sub);
      }
      continue;
    }
    for (const record of payload.records ?? []) {
      const prior = features.find(item => item.unit === record.unit && item.feature === record.feature);
      if (prior) {
        if (sameFeature(prior, record)) {
          duplicateRecords.push({ release, cell, unit: record.unit, feature: record.feature });
        } else {
          gaps.push({
            release, cell,
            error: `单元 ${record.unit} 特征 ${record.feature} 在不同分片中几何不一致`,
          });
        }
        continue;
      }
      features.push({ ...record, sourceCell: cell });
    }
  }
  return {
    features,
    queriedCells,
    truncatedCells,
    duplicateRecords,
    gaps,
    complete: gaps.length === 0,
  };
}

function featureRings(features) {
  return features.map(feature => feature.polygon);
}

// 单元级条款适用性：含单元条目、地块补充函（按与项目范围的实质交叠）、
// 暂停条款（按拟开工日，两端包含；暂停只作用于 pauseTarget 一项）。
export function evaluateUnitEntries(unitKey, unitFeatures, clauses, request) {
  const { use, opening, boundary } = request;
  const boundaryRing = boundary.coordinates[0];
  const mine = clauses.filter(clause => clause.unit === unitKey &&
    (!clause.use || clause.use === use));

  const activePauses = mine
    .filter(clause => clause.level === '暂停' &&
      inDateRange(opening, clause.fromDate, clause.throughDate));

  const entries = [];
  const notApplicable = [];

  for (const clause of mine) {
    if (clause.level === '暂停') continue;

    let parcelResult = null;
    if (clause.level === '地块') {
      if (!clause.parcel) {
        notApplicable.push({ id: clause.id, reason: '地块补充函缺少地块几何，无法认定适用' });
        continue;
      }
      parcelResult = classify(boundaryRing, clause.parcel);
      if (parcelResult.relation !== 'overlap') {
        notApplicable.push({
          id: clause.id,
          reason: parcelResult.relation === 'contact'
            ? `地块与项目范围仅${parcelResult.contact === 'segment' ? '共线' : '点'}接触，无实质交叠`
            : '地块不在项目范围内',
          contact: parcelResult.contact,
        });
        continue;
      }
    }

    const pauses = activePauses.filter(pause => pause.pauseTarget === clause.id);
    const documents = [clause.document, ...pauses.map(pause => pause.document)]
      .filter((id, index, all) => id && all.indexOf(id) === index);
    entries.push({
      id: clause.id,
      level: clause.level,
      limit: clause.limit,
      use: clause.use,
      status: pauses.length > 0 ? '已暂停' : '适用',
      pausedBy: pauses.map(pause => ({
        id: pause.id,
        document: pause.document,
        fromDate: pause.fromDate,
        throughDate: pause.throughDate,
      })),
      documents,
      parcel: clause.parcel,
      parcelOverlapArea: parcelResult ? parcelResult.area : undefined,
    });
  }

  return {
    entries: entries.sort((a, b) => a.id.localeCompare(b.id)),
    notApplicable,
    activePauses: activePauses.map(pause => ({
      id: pause.id,
      pauseTarget: pause.pauseTarget,
      document: pause.document,
      fromDate: pause.fromDate,
      throughDate: pause.throughDate,
    })),
  };
}

function buildEvidence(unit, registryDocuments) {
  const required = [...new Set(unit.entries.flatMap(entry => entry.documents))].sort();
  const evidence = required.map(document => {
    const exact = registryDocuments.find(row => row.release === unit.release && row.document === document);
    if (exact) {
      return { document, status: 'public', source: 'registry', release: exact.release, text: exact.text };
    }
    const otherReleases = registryDocuments
      .filter(row => row.document === document && row.release !== unit.release)
      .map(row => row.release);
    if (otherReleases.length > 0) {
      return {
        document,
        status: 'wrongRelease',
        source: null,
        availableInReleases: [...new Set(otherReleases)],
        note: '其他发布中的同编号原件不能用于本次有效发布',
      };
    }
    return { document, status: 'archiveRequired', source: null };
  });
  return { required, evidence };
}

// 档案室对账：只认本次发布、本经办号下的交付；旧调件号结果显式标为 stale，
// 绝不能用旧调件的最后一份凑出新版完整。
function reconcileArchive(unit, fulfillment, orderViews) {
  const stale = [];
  const matched = [];
  for (const row of fulfillment) {
    if (row.unit !== unit.unit) continue;
    if (row.requestKey === unit.orderKey && row.release === unit.release) {
      matched.push(row);
    } else if (row.release !== unit.release || row.requestKey !== unit.orderKey) {
      stale.push({ ...row, ignored: true, reason: '调件不属于本次发布或本次经办号' });
    }
  }

  const delivered = new Map(
    matched.filter(row => row.state === 'delivered').map(row => [row.document, row]),
  );
  const staged = matched.filter(row => row.state === 'staged');

  const evidence = unit.evidence.map(item => {
    if (item.status !== 'archiveRequired' && item.status !== 'wrongRelease') return item;
    const done = delivered.get(item.document);
    if (done) {
      return {
        document: item.document,
        status: 'delivered',
        source: 'archive',
        release: done.release,
        requestKey: done.requestKey,
        text: done.text,
      };
    }
    if (staged.some(row => row.document === item.document)) {
      return { ...item, status: 'staged', source: 'archive' };
    }
    return item;
  });

  return {
    evidence,
    stale,
    stagedDocuments: staged.map(row => row.document),
    orderViews,
  };
}

function boundaryRings(request) {
  if (!request.boundary || request.boundary.type !== 'Polygon' || !request.boundary.coordinates?.length) {
    throw new Error('boundary 必须是 GeoJSON Polygon');
  }
  return request.boundary.coordinates;
}

// 主入口：组合一次完整查件。placeOrders=false 时只出结论与调件建议，不产生受理。
export async function buildDetermination(client, rawRequest, options = {}) {
  const request = {
    consultation: rawRequest.consultation,
    use: rawRequest.use,
    opening: rawRequest.opening,
    boundary: rawRequest.boundary,
  };
  if (!request.consultation || !request.use || !request.opening || !request.boundary) {
    throw new Error('请求必须包含 consultation、use、opening 与 boundary');
  }
  const rings = boundaryRings(request);
  const boundaryRing = rings[0];

  const releases = await client.listReleases();
  const selection = selectRelease(releases, request.opening, options.release);
  const base = {
    consultation: request.consultation,
    use: request.use,
    opening: request.opening,
    boundary: request.boundary,
    releaseSelection: selection,
    queriedAt: new Date().toISOString(),
    snapshot: { request: structuredClone(request), release: selection.release?.id ?? null },
  };
  if (!selection.release) {
    return {
      ...base,
      release: null,
      coverage: null,
      units: [],
      conflicts: [],
      contacts: [],
      paragraphs: [],
      inquiryRequired: false,
      status: '无法确定',
      reason: selection.reason,
      gaps: [],
    };
  }
  const release = selection.release;

  const [coverage, clauses, registryDocuments, fulfillmentRows] = await Promise.all([
    collectFeatures(client, release.id, release.tileKeys),
    client.listClauses(release.id),
    client.listDocuments(),
    client.listFulfillment(),
  ]);

  const unitMap = new Map();
  for (const feature of coverage.features) {
    if (!unitMap.has(feature.unit)) unitMap.set(feature.unit, []);
    unitMap.get(feature.unit).push(feature);
  }

  const units = [];
  for (const [unitKey, features] of [...unitMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const featureFacts = [];
    const overlapRings = [];
    let contactKind = null;
    for (const feature of features) {
      const result = classify(boundaryRing, feature.polygon);
      featureFacts.push({
        feature: feature.feature,
        sourceCell: feature.sourceCell,
        polygon: feature.polygon,
        relation: result.relation,
        contact: result.contact,
        intersection: result.intersection,
        intersectionArea: result.area,
      });
      if (result.relation === 'overlap') overlapRings.push(result.intersection);
      else if (result.contact === 'segment') contactKind = 'segment';
      else if (result.contact === 'point' && !contactKind) contactKind = 'point';
    }
    const relation = overlapRings.length > 0 ? 'overlap' : contactKind ? 'contact' : 'disjoint';
    if (relation === 'disjoint') continue;

    const unit = {
      unit: unitKey,
      release: release.id,
      relation,
      contact: relation === 'contact' ? contactKind : null,
      restrictedArea: relation === 'overlap' ? unionArea(overlapRings) : 0,
      features: featureFacts,
      orderKey: `${request.consultation}-${release.id.replace(/-/g, '')}-${unitKey}`,
    };

    if (relation === 'contact') {
      unit.entries = [];
      unit.notApplicable = [];
      unit.activePauses = [];
      unit.evidence = [];
      unit.requiredDocuments = [];
      unit.missingDocuments = [];
      unit.orders = [];
      unit.status = '仅接触';
      unit.note = '项目范围与该单元仅线/点接触，不计算限制面积、不适用单元条目';
      units.push(unit);
      continue;
    }

    const evaluated = evaluateUnitEntries(unitKey, featureRings(features), clauses, request);
    Object.assign(unit, evaluated);
    const { required, evidence: initialEvidence } = buildEvidence(unit, registryDocuments);
    unit.requiredDocuments = required;
    unit.evidence = initialEvidence;

    const orderViews = [];
    const needsOrder = unit.evidence.some(item => item.status === 'archiveRequired');
    if (needsOrder && options.placeOrders) {
      const orderBody = {
        requestKey: unit.orderKey,
        release: release.id,
        unit: unitKey,
        use: request.use,
        documents: unit.evidence
          .filter(item => item.status === 'archiveRequired')
          .map(item => item.document),
      };
      let placed;
      try {
        placed = await client.placeOrder(orderBody);
      } catch (error) {
        placed = { error: error.message };
      }
      orderViews.push({ request: orderBody, receipt: placed });
      try {
        orderViews.push({ lookup: await client.getOrder(unit.orderKey) });
      } catch (error) {
        orderViews.push({ lookupError: error.message });
      }
    }
    unit.orders = orderViews;

    const reconciled = reconcileArchive(unit, fulfillmentRows, orderViews);
    unit.evidence = reconciled.evidence;
    unit.staleFulfillment = reconciled.stale;
    unit.stagedDocuments = reconciled.stagedDocuments;
    unit.missingDocuments = unit.evidence
      .filter(item => ['archiveRequired', 'wrongRelease', 'staged'].includes(item.status))
      .map(item => ({ document: item.document, status: item.status, detail: item }));
    unit.sameReleaseConsistent = unit.missingDocuments.length === 0 &&
      unit.evidence.every(item => !item.release || item.release === release.id);
    unit.status = unit.missingDocuments.length === 0 ? '确定' : '待补证';
    units.push(unit);
  }

  // 单元间关系：同一生效范围内同层级单元的实质交叠按门户口径标注冲突，不能任选；
  // 仅共线/点接触的单元对单独列出。
  const involved = units.filter(unit => unit.relation !== 'disjoint');
  const conflicts = [];
  const contacts = [];
  for (let i = 0; i < involved.length; i += 1) {
    for (let j = i + 1; j < involved.length; j += 1) {
      const a = involved[i];
      const b = involved[j];
      const pair = relationBetween(
        a.features.map(f => f.polygon),
        b.features.map(f => f.polygon),
      );
      if (pair.relation === 'overlap') {
        conflicts.push({
          units: [a.unit, b.unit],
          level: '单元',
          policy: release.overlapPolicy,
          overlapArea: pair.area,
        });
      } else if (pair.contact) {
        contacts.push({ units: [a.unit, b.unit], contact: pair.contact });
      }
    }
  }

  // 段落编号：仅给答复中实际引用的条目（含已暂停条目），编号在本次结论内稳定。
  const paragraphs = [];
  let paragraphSeq = 1;
  for (const unit of units) {
    for (const entry of unit.entries ?? []) {
      entry.paragraphId = `P${paragraphSeq}`;
      paragraphs.push({
        paragraphId: entry.paragraphId,
        unit: unit.unit,
        clause: entry.id,
        status: entry.status,
        documents: entry.documents,
      });
      paragraphSeq += 1;
    }
  }

  const overlapUnits = units.filter(unit => unit.relation === 'overlap');
  const firmUnits = overlapUnits.filter(unit => unit.status === '确定');
  const pendingUnits = overlapUnits.filter(unit => unit.status === '待补证');
  const allStale = units.flatMap(unit => unit.staleFulfillment ?? []);
  const inquiryRequired = conflicts.length > 0;

  let status;
  let reason;
  if (!coverage.complete) {
    status = '无法确定';
    reason = '地图分片存在缺口，尚不能判断完整项目范围';
  } else if (overlapUnits.length === 0) {
    status = '无法确定';
    reason = '项目范围未与任何已取得评价单元实质交叠';
  } else if (pendingUnits.length === 0) {
    status = '确定';
    reason = selection.reason;
  } else if (firmUnits.length === 0) {
    status = '无法确定';
    reason = '所有涉及单元的引用原件均未齐备';
  } else {
    status = '部分确定';
    reason = '部分单元原件已查实，其余单元等待档案室交付';
  }

  return {
    ...base,
    release: { id: release.id, validFrom: release.validFrom, overlapPolicy: release.overlapPolicy },
    coverage: {
      complete: coverage.complete,
      queriedCells: coverage.queriedCells,
      truncatedCells: coverage.truncatedCells,
      duplicateRecords: coverage.duplicateRecords,
    },
    units,
    conflicts,
    contacts,
    staleFulfillment: allStale,
    inquiryRequired,
    paragraphs,
    status,
    reason,
    gaps: coverage.gaps,
  };
}

// 档案室轮询：按已保存结论的原请求与原发布重跑判定，保持同一次有效发布口径。
export async function refreshDetermination(client, prior, options = {}) {
  if (!prior?.snapshot?.request) {
    throw new Error('缺少原始请求快照，无法按原发布编号复核');
  }
  return buildDetermination(client, prior.snapshot.request, {
    release: prior.snapshot.release,
    placeOrders: options.placeOrders ?? false,
  });
}
