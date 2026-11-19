// 已签答复复核：按当时的项目范围、拟开工时间与原发布编号重查，
// 输出逐段处置（暂停引用 / 等待补件 / 未受影响）、新纳入部分的资料需求与重发依据。

import { gridDiff, ringArea } from './geometry.mjs';
import { buildDetermination } from './determination.mjs';

function findEntry(determination, unit, clauseId) {
  const target = determination.units?.find(item => item.unit === unit);
  return target?.entries?.find(entry => entry.id === clauseId) ?? null;
}

function findUnit(determination, unit) {
  return determination.units?.find(item => item.unit === unit) ?? null;
}

function firmBasis(determination, entry) {
  const unit = findUnit(determination, entry.unit);
  if (!unit) return null;
  const texts = [];
  for (const document of entry.documents) {
    const item = unit.evidence?.find(evidence => evidence.document === document);
    if (!item || !['public', 'delivered'].includes(item.status)) return null;
    texts.push({
      document,
      release: item.release,
      source: item.source,
      text: item.text,
    });
  }
  return texts;
}

export async function reviewDetermination(client, prior, nextRequest, options = {}) {
  if (!prior?.snapshot?.request || !prior.snapshot.release) {
    throw new Error('旧答复缺少请求快照或原发布编号，无法复核');
  }
  const oldRequest = prior.snapshot.request;
  const oldReleaseId = prior.snapshot.release;
  const nextOpening = nextRequest.opening ?? oldRequest.opening;
  const nextUse = nextRequest.use ?? oldRequest.use;

  // 原发布编号复核：固定原发布，确认旧答复每段在当时依据下是否仍成立。
  const onOldRelease = await buildDetermination(client, {
    consultation: nextRequest.consultation ?? oldRequest.consultation,
    use: nextUse,
    opening: nextOpening,
    boundary: nextRequest.boundary,
  }, { release: oldReleaseId, placeOrders: options.placeOrders ?? false });

  // 按拟开工日的当前有效发布复核，用于发现生效范围变化。
  const current = await buildDetermination(client, {
    consultation: nextRequest.consultation ?? oldRequest.consultation,
    use: nextUse,
    opening: nextOpening,
    boundary: nextRequest.boundary,
  }, { placeOrders: options.placeOrders ?? false });

  const boundaryChange = gridDiff(
    [oldRequest.boundary.coordinates[0]],
    [nextRequest.boundary.coordinates[0]],
  );
  const oldArea = ringArea(oldRequest.boundary.coordinates[0]);
  const newArea = ringArea(nextRequest.boundary.coordinates[0]);

  const sameRelease = current.release?.id === oldReleaseId;
  const reviewSource = sameRelease ? current : onOldRelease;

  const paragraphs = [];
  for (const oldParagraph of prior.paragraphs ?? []) {
    const oldUnit = findUnit(prior, oldParagraph.unit);
    const oldEntry = prior.units
      ?.find(item => item.unit === oldParagraph.unit)
      ?.entries?.find(entry => entry.id === oldParagraph.clause);
    const result = {
      paragraphId: oldParagraph.paragraphId,
      unit: oldParagraph.unit,
      clause: oldParagraph.clause,
      priorStatus: oldParagraph.status,
    };

    const unitNow = findUnit(reviewSource, oldParagraph.unit);
    const entryNow = findEntry(reviewSource, oldParagraph.unit, oldParagraph.clause);
    const currentEntry = findEntry(current, oldParagraph.unit, oldParagraph.clause);

    if (!unitNow || unitNow.relation === 'disjoint') {
      result.disposition = '立即暂停引用';
      result.reason = '项目边界调整后该单元已退出项目范围，旧段落失去空间依据';
    } else if (unitNow.relation === 'contact') {
      result.disposition = '立即暂停引用';
      result.reason = '项目范围与该单元仅剩线/点接触，限制面积归零';
    } else if (!entryNow) {
      result.disposition = '立即暂停引用';
      result.reason = sameRelease
        ? '原条目在本次发布中不再适用于当前项目范围或用途'
        : `原条目在发布 ${oldReleaseId} 的复核中已不再适用`;
    } else if (entryNow.status === '已暂停' || currentEntry?.status === '已暂停') {
      const paused = entryNow.status === '已暂停' ? entryNow : currentEntry;
      result.disposition = '立即暂停引用';
      result.reason = (sameRelease ? '' : `当前发布 ${current.release.id} 下，`) +
        '暂停条款在拟开工日暂停该条目：' +
        paused.pausedBy.map(pause =>
          `${pause.id}（${pause.fromDate} 至 ${pause.throughDate}，原件 ${pause.document}）`).join('；');
    } else if (entryNow.status === '适用' && (unitNow.status === '待补证' ||
               findUnit(current, oldParagraph.unit)?.status === '待补证')) {
      const unitForDocs = findUnit(current, oldParagraph.unit)?.status === '待补证'
        ? findUnit(current, oldParagraph.unit) : unitNow;
      result.disposition = '等待补件';
      result.reason = '条目仍适用，但同一次发布所需原件尚未齐备：' +
        unitForDocs.missingDocuments.map(item => item.document).join('、');
      result.awaiting = unitForDocs.missingDocuments.map(item => item.document);
    } else {
      const basisSource = sameRelease ? reviewSource : current;
      const basis = firmBasis(basisSource, { unit: oldParagraph.unit, documents: entryNow.documents });
      if (!basis) {
        result.disposition = '等待补件';
        result.reason = sameRelease
          ? '原引用原件当前无法认定来自本次有效发布'
          : `新发布 ${current.release.id} 中该条目的原件尚未齐备，旧发布原件不能跨发布引用`;
      } else {
        result.disposition = '未受影响';
        result.reason = sameRelease
          ? '同一次有效发布内项目边界调整未改变该条目的适用依据'
          : `条目在当前发布 ${current.release.id} 中继续适用且原件齐备，可按新发布原件重发（原发布 ${oldReleaseId} 依据存档）`;
        result.basis = basis;
      }
    }
    paragraphs.push(result);
  }

  // 新纳入部分：按当前有效发布评估，凡旧答复未覆盖的单元条目都需补资料；
  // 新发布新增的条目即使几何未变也在此列出。
  const coveredClauses = new Set((prior.paragraphs ?? []).map(item => item.unit + '|' + item.clause));
  const newRequirements = [];
  for (const unit of current.units ?? []) {
    for (const entry of unit.entries ?? []) {
      if (coveredClauses.has(unit.unit + '|' + entry.id)) continue;
      newRequirements.push({
        unit: unit.unit,
        clause: entry.id,
        status: entry.status,
        limit: entry.limit,
        documents: entry.documents,
        dueTo: !sameRelease && !findUnit(prior, unit.unit) ? '新发布纳入的单元'
          : !sameRelease ? '新发布新增条目' : '新纳入项目范围',
        evidenceReady: entry.documents.every(document =>
          ['public', 'delivered'].includes(
            unit.evidence?.find(item => item.document === document)?.status,
          )),
      });
    }
  }

  const suspended = paragraphs.filter(item => item.disposition === '立即暂停引用');
  const awaiting = paragraphs.filter(item => item.disposition === '等待补件');
  const unaffected = paragraphs.filter(item => item.disposition === '未受影响');

  const canResend = suspended.length === 0;
  const changeSummary = {
    releaseChanged: !sameRelease,
    priorRelease: oldReleaseId,
    currentRelease: current.release?.id ?? null,
    boundary: {
      oldArea,
      newArea,
      addedArea: boundaryChange.addedArea,
      removedArea: boundaryChange.removedArea,
    },
    suspendedParagraphs: suspended.map(item => item.paragraphId),
    awaitingParagraphs: awaiting.map(item => item.paragraphId),
    unaffectedParagraphs: unaffected.map(item => item.paragraphId),
  };

  return {
    consultation: nextRequest.consultation ?? oldRequest.consultation,
    use: nextUse,
    opening: nextOpening,
    reviewedAt: new Date().toISOString(),
    changeSummary,
    boundaryChange,
    releaseChanged: !sameRelease,
    oldReleaseDetermination: onOldRelease,
    currentDetermination: current,
    paragraphs,
    newRequirements,
    resend: {
      canResend,
      instruction: canResend
        ? (awaiting.length > 0
          ? '未受影响段落可立即重发；等待补件段落待原件交付后补发，不得使用旧调件号结果凑齐'
          : '全部旧段落依据成立，可按本复核结果重发答复')
        : '存在必须立即暂停引用的段落，重发答复前须先撤回或改写对应段落',
      unaffectedBasis: unaffected.map(item => ({
        paragraphId: item.paragraphId,
        unit: item.unit,
        clause: item.clause,
        basis: item.basis,
        reason: item.reason,
      })),
      awaiting,
    },
  };
}
