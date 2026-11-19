// 平面格网（米）上的多边形几何工具。
// 夹具中的多边形均为闭合、正交（矩形）多边形；相交裁剪采用通用的
// Sutherland-Hodgman 凸多边形裁剪，面积与差异统计走正交格网，保证整数坐标下精确。

export const EPS = 1e-9;

function cleanRing(ring) {
  const pts = ring.map(([x, y]) => [x, y]);
  if (pts.length > 1) {
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (Math.abs(first[0] - last[0]) <= EPS && Math.abs(first[1] - last[1]) <= EPS) {
      pts.pop();
    }
  }
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > EPS || Math.abs(q[1] - p[1]) > EPS) out.push(p);
  }
  return out;
}

export function signedArea(ring) {
  const pts = cleanRing(ring);
  let sum = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

export function ringArea(ring) {
  return Math.abs(signedArea(ring));
}

export function roundArea(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function cross(ax, ay, bx, by) {
  return ax * by - ay * bx;
}

function side(a, b, p) {
  return cross(b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]);
}

// 直线 AB 与线段 PQ 的交点
function lineIntersection(a, b, p, q) {
  const dx1 = b[0] - a[0];
  const dy1 = b[1] - a[1];
  const dx2 = q[0] - p[0];
  const dy2 = q[1] - p[1];
  const denom = cross(dx2, dy2, dx1, dy1);
  if (Math.abs(denom) <= EPS) return null;
  const t = cross(a[0] - p[0], a[1] - p[1], dx1, dy1) / denom;
  return [p[0] + t * dx2, p[1] + t * dy2];
}

// Sutherland-Hodgman：用凸多边形 clip 裁剪 subject，返回闭合环；无实质交叠时返回 null。
export function intersectConvex(subject, clip) {
  let output = cleanRing(subject);
  const clipRing = cleanRing(clip);
  if (signedArea(clipRing) < 0) clipRing.reverse();
  for (let i = 0; i < clipRing.length; i += 1) {
    const a = clipRing[i];
    const b = clipRing[(i + 1) % clipRing.length];
    const input = output;
    output = [];
    if (input.length === 0) break;
    for (let j = 0; j < input.length; j += 1) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const pInside = side(a, b, p) >= -EPS;
      const qInside = side(a, b, q) >= -EPS;
      if (qInside) {
        if (!pInside) {
          const hit = lineIntersection(a, b, p, q);
          if (hit) output.push(hit);
        }
        output.push(q);
      } else if (pInside) {
        const hit = lineIntersection(a, b, p, q);
        if (hit) output.push(hit);
      }
    }
  }
  if (output.length < 3) return null;
  output.push(output[0]);
  if (ringArea(output) <= EPS) return null;
  return output;
}

export function pointOnSegment(p, a, b) {
  if (Math.abs(side(a, b, p)) > EPS) return false;
  const minX = Math.min(a[0], b[0]) - EPS;
  const maxX = Math.max(a[0], b[0]) + EPS;
  const minY = Math.min(a[1], b[1]) - EPS;
  const maxY = Math.max(a[1], b[1]) + EPS;
  return p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY;
}

export function pointInRing(p, ring) {
  const pts = cleanRing(ring);
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i, i += 1) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersects = ((yi > p[1]) !== (yj > p[1])) &&
      (p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function edgesOf(ring) {
  const pts = cleanRing(ring);
  return pts.map((p, i) => [p, pts[(i + 1) % pts.length]]);
}

// 两个环边界的接触方式：共线重叠为 segment，仅端点/穿越点接触为 point，否则 null。
export function boundaryContact(ringA, ringB) {
  const a = cleanRing(ringA);
  const b = cleanRing(ringB);
  let pointHit = false;
  for (const [a0, a1] of edgesOf(a)) {
    const d1x = a1[0] - a0[0];
    const d1y = a1[1] - a0[1];
    for (const [b0, b1] of edgesOf(b)) {
      const d2x = b1[0] - b0[0];
      const d2y = b1[1] - b0[1];
      const cr = cross(d1x, d1y, d2x, d2y);
      if (Math.abs(cr) <= EPS) {
        // 平行：共线时计算投影重叠长度
        if (Math.abs(side(a0, a1, b0)) <= EPS) {
          const len1 = Math.hypot(d1x, d1y);
          const ux = d1x / len1;
          const uy = d1y / len1;
          const ta0 = 0;
          const ta1 = len1;
          const tb0 = (b0[0] - a0[0]) * ux + (b0[1] - a0[1]) * uy;
          const tb1 = (b1[0] - a0[0]) * ux + (b1[1] - a0[1]) * uy;
          const overlap = Math.min(ta1, Math.max(tb0, tb1)) - Math.max(ta0, Math.min(tb0, tb1));
          if (overlap > EPS) return 'segment';
        }
      } else {
        const hit = lineIntersection(a0, a1, b0, b1);
        if (hit && pointOnSegment(hit, a0, a1) && pointOnSegment(hit, b0, b1)) {
          pointHit = true;
        }
      }
    }
  }
  for (const p of a) {
    for (const [b0, b1] of edgesOf(b)) {
      if (pointOnSegment(p, b0, b1)) pointHit = true;
    }
  }
  for (const p of b) {
    for (const [a0, a1] of edgesOf(a)) {
      if (pointOnSegment(p, a0, a1)) pointHit = true;
    }
  }
  return pointHit ? 'point' : null;
}

// 两个环的关系分类：实质交叠（带面积）、仅接触（线/点，面积为 0）或分离。
export function classify(ringA, ringB) {
  const intersection = intersectConvex(ringA, ringB);
  if (intersection) {
    return {
      relation: 'overlap',
      contact: null,
      intersection,
      area: roundArea(ringArea(intersection)),
    };
  }
  const contact = boundaryContact(ringA, ringB);
  return {
    relation: contact ? 'contact' : 'disjoint',
    contact: contact ?? null,
    intersection: null,
    area: 0,
  };
}

// 重复分片判定：unit 与 feature 相同且多边形几何（坐标集合）一致。
export function sameFeature(a, b) {
  if (a.unit !== b.unit || a.feature !== b.feature) return false;
  const pa = cleanRing(a.polygon);
  const pb = cleanRing(b.polygon);
  if (pa.length !== pb.length) return false;
  const keyOf = p => `${p[0]},${p[1]}`;
  const setA = new Set(pa.map(keyOf));
  const setB = new Set(pb.map(keyOf));
  if (setA.size !== setB.size) return false;
  for (const key of setA) {
    if (!setB.has(key)) return false;
  }
  return true;
}

// 多组环之间的关系：任一对实质交叠即 overlap，否则取最强接触。
export function relationBetween(ringsA, ringsB) {
  let contact = null;
  const intersections = [];
  for (const a of ringsA) {
    for (const b of ringsB) {
      const result = classify(a, b);
      if (result.relation === 'overlap') intersections.push(result.intersection);
      else if (result.contact === 'segment') contact = 'segment';
      else if (result.contact === 'point' && !contact) contact = 'point';
    }
  }
  if (intersections.length > 0) {
    return { relation: 'overlap', contact: null, area: roundArea(unionArea(intersections)) };
  }
  return { relation: contact ? 'contact' : 'disjoint', contact, area: 0 };
}

function grid(rings) {
  const xs = new Set();
  const ys = new Set();
  for (const ring of rings) {
    for (const [x, y] of cleanRing(ring)) {
      xs.add(x);
      ys.add(y);
    }
  }
  return {
    xs: [...xs].sort((a, b) => a - b),
    ys: [...ys].sort((a, b) => a - b),
  };
}

function cellInsideAny(x0, x1, y0, y1, rings) {
  const center = [(x0 + x1) / 2, (y0 + y1) / 2];
  return rings.some(ring => pointInRing(center, ring));
}

// 多个正交多边形的并集面积（格网中心法，坐标来自各多边形顶点时精确）。
export function unionArea(rings) {
  const { xs, ys } = grid(rings);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < ys.length - 1; j += 1) {
      if (cellInsideAny(xs[i], xs[i + 1], ys[j], ys[j + 1], rings)) {
        area += (xs[i + 1] - xs[i]) * (ys[j + 1] - ys[j]);
      }
    }
  }
  return roundArea(area);
}

function mergeCells(cells) {
  const merged = [];
  const used = new Set();
  for (let i = 0; i < cells.length; i += 1) {
    if (used.has(i)) continue;
    let cur = { ...cells[i] };
    used.add(i);
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < cells.length; j += 1) {
        if (used.has(j)) continue;
        const other = cells[j];
        if (Math.abs(other.y0 - cur.y0) <= EPS && Math.abs(other.y1 - cur.y1) <= EPS &&
            Math.abs(other.x0 - cur.x1) <= EPS) {
          cur.x1 = other.x1;
          used.add(j);
          grew = true;
        }
      }
    }
    merged.push(cur);
  }
  return merged.map(rect => ({
    polygon: [
      [rect.x0, rect.y0],
      [rect.x1, rect.y0],
      [rect.x1, rect.y1],
      [rect.x0, rect.y1],
      [rect.x0, rect.y0],
    ],
    area: roundArea((rect.x1 - rect.x0) * (rect.y1 - rect.y0)),
  }));
}

// 两批正交多边形的差异：新增/退出的矩形条带及面积，用于项目边界调整复核。
export function gridDiff(baseRings, nextRings) {
  const all = [...baseRings, ...nextRings];
  const { xs, ys } = grid(all);
  const addedCells = [];
  const removedCells = [];
  let addedArea = 0;
  let removedArea = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    for (let j = 0; j < ys.length - 1; j += 1) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const y0 = ys[j];
      const y1 = ys[j + 1];
      const inBase = cellInsideAny(x0, x1, y0, y1, baseRings);
      const inNext = cellInsideAny(x0, x1, y0, y1, nextRings);
      const area = (x1 - x0) * (y1 - y0);
      if (inNext && !inBase) {
        addedCells.push({ x0, x1, y0, y1 });
        addedArea += area;
      } else if (inBase && !inNext) {
        removedCells.push({ x0, x1, y0, y1 });
        removedArea += area;
      }
    }
  }
  return {
    addedArea: roundArea(addedArea),
    removedArea: roundArea(removedArea),
    added: mergeCells(addedCells),
    removed: mergeCells(removedCells),
  };
}
