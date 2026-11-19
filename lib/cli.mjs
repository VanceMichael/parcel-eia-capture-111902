#!/usr/bin/env node
// 环评查件工具命令行：consult（新咨询）、poll（档案室轮询）、review（旧答复复核）。

import { readFile, writeFile } from 'node:fs/promises';
import { SourceClient, SourceError } from './source-client.mjs';
import { buildDetermination, refreshDetermination } from './determination.mjs';
import { reviewDetermination } from './review.mjs';

const usage = `用法：
  node lib/cli.mjs consult --request <请求.json> [--release <发布编号>] [--order] [--out <结论.json>] [--origin <来源地址>]
  node lib/cli.mjs poll    --prior <旧结论.json> [--order] [--out <结论.json>] [--origin <来源地址>]
  node lib/cli.mjs review  --prior <旧结论.json> --request <新请求.json> [--order] [--out <复核.json>] [--origin <来源地址>]

选项：
  --release  固定发布编号（历史复核）；默认按拟开工日选最新有效发布
  --order    对需预领的原件实际提交档案室调件；默认只给调件建议
  --out      结果写入文件；同时仍在标准输出打印 JSON
`;

function parseArgs(argv) {
  const args = { flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args.flags.add(key);
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args.command ??= token;
    }
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function summarize(determination) {
  const lines = [];
  lines.push(`结论状态：${determination.status}（${determination.reason}）`);
  if (determination.release) {
    lines.push(`有效发布：${determination.release.id}，生效日 ${determination.release.validFrom}`);
  }
  if (determination.coverage) {
    lines.push(`分片覆盖：${determination.coverage.complete ? '完整' : '不完整'}，` +
      `已查 ${determination.coverage.queriedCells.join('、') || '无'}` +
      (determination.coverage.duplicateRecords.length
        ? `，重复分片 ${determination.coverage.duplicateRecords.length} 处已去重` : ''));
  }
  for (const gap of determination.gaps ?? []) {
    lines.push(`  缺口：发布 ${gap.release} 网格 ${gap.cell} —— ${gap.error}`);
  }
  for (const unit of determination.units ?? []) {
    if (unit.relation === 'contact') {
      lines.push(`单元 ${unit.unit}：仅${unit.contact === 'segment' ? '共线' : '点'}接触，不计算限制面积`);
      continue;
    }
    lines.push(`单元 ${unit.unit}：${unit.status}，限制面积 ${unit.restrictedArea} 平方米` +
      (unit.missingDocuments?.length
        ? `，待原件 ${unit.missingDocuments.map(item => item.document).join('、')}` : ''));
    for (const entry of unit.entries ?? []) {
      lines.push(`  [${entry.paragraphId}] ${entry.id}（${entry.level}）${entry.status}：${entry.limit}` +
        (entry.pausedBy.length ? `，暂停于 ${entry.pausedBy.map(p => p.id).join('、')}` : '') +
        `，原件 ${entry.documents.join('、')}`);
    }
  }
  for (const conflict of determination.conflicts ?? []) {
    lines.push(`同层冲突：${conflict.units.join(' / ')} 实质交叠 ${conflict.overlapArea} 平方米，按门户口径「${conflict.policy}」，不得任选其一`);
  }
  for (const contact of determination.contacts ?? []) {
    lines.push(`接边关系：${contact.units.join(' / ')} 仅${contact.contact === 'segment' ? '共线' : '点'}接触，单独列示`);
  }
  for (const stale of determination.staleFulfillment ?? []) {
    lines.push(`旧调件忽略：${stale.requestKey} / ${stale.release} / ${stale.document}（${stale.reason}）`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  if (!command || args.flags.has('help')) {
    process.stdout.write(usage);
    return;
  }
  const client = new SourceClient(args.origin);

  let result;
  if (command === 'consult') {
    if (!args.request) throw new Error('consult 需要 --request');
    result = await buildDetermination(client, await readJson(args.request), {
      release: args.release,
      placeOrders: args.flags.has('order'),
    });
  } else if (command === 'poll') {
    if (!args.prior) throw new Error('poll 需要 --prior');
    result = await refreshDetermination(client, await readJson(args.prior), {
      placeOrders: args.flags.has('order'),
    });
  } else if (command === 'review') {
    if (!args.prior || !args.request) throw new Error('review 需要 --prior 与 --request');
    result = await reviewDetermination(client, await readJson(args.prior), await readJson(args.request), {
      placeOrders: args.flags.has('order'),
    });
  } else {
    throw new Error(`未知命令：${command}\n\n${usage}`);
  }

  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (command === 'review') {
    process.stderr.write([
      `复核结论：可重发=${result.resend.canResend ? '是' : '否'}；` +
      `暂停段落 ${result.changeSummary.suspendedParagraphs.length} 段，` +
      `等待补件 ${result.changeSummary.awaitingParagraphs.length} 段，` +
      `未受影响 ${result.changeSummary.unaffectedParagraphs.length} 段`,
      `边界变化：新增 ${result.boundaryChange.addedArea} 平方米，退出 ${result.boundaryChange.removedArea} 平方米`,
      ...result.paragraphs.map(item => `  [${item.paragraphId}] ${item.unit}/${item.clause}：${item.disposition} —— ${item.reason}`),
    ].join('\n') + '\n');
  } else {
    process.stderr.write(summarize(result) + '\n');
  }

  if (args.out) {
    await writeFile(args.out, JSON.stringify(result, null, 2) + '\n');
    process.stderr.write(`结果已写入 ${args.out}\n`);
  }
}

main().catch(error => {
  if (error instanceof SourceError) {
    process.stderr.write(`来源错误：${error.message}${error.path ? '（' + error.path + '）' : ''}\n`);
  } else {
    process.stderr.write(`错误：${error.message}\n\n${usage}`);
  }
  process.exitCode = 1;
});
