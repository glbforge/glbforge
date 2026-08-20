import pc from 'picocolors';
import type { AnalysisResult } from '@xui/core';

const fmt = (n: number) => n.toLocaleString('en-US');
const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1) + 'MB';

const BADGE = {
  error: pc.bgRed(pc.white(' ERROR ')),
  warn: pc.bgYellow(pc.black(' WARN  ')),
  info: pc.bgBlue(pc.white(' INFO  ')),
} as const;

export function printReport(r: AnalysisResult): void {
  const g = r.geometry;
  const line = pc.dim('─'.repeat(64));

  console.log();
  console.log(pc.bold(`  ${r.file.path ?? '(document)'}`));
  if (r.asset.generator) console.log(pc.dim(`  generator: ${r.asset.generator}`));
  console.log(line);

  const scoreColor = r.score >= 80 ? pc.green : r.score >= 50 ? pc.yellow : pc.red;
  console.log(
    `  ${pc.bold('Score')} ${scoreColor(pc.bold(String(r.score)))}${pc.dim('/100')}` +
    `   ${pc.bold('Profile')} ${r.profile.name}` +
    `   ${r.passed ? pc.green('✓ within budget') : pc.red('✗ over budget')}`,
  );
  console.log(line);

  console.log(pc.bold('  Geometry'));
  console.log(`    triangles      ${fmt(g.triangles)}  ${budget(g.triangles, r.profile.maxTriangles)}`);
  console.log(`    vertices       ${fmt(g.vertices)}`);
  console.log(`    draw calls     ~${g.drawCallEstimate}  ${budget(g.drawCallEstimate, r.profile.maxDrawCalls)}`);
  console.log(`    meshes/prims   ${g.meshCount}/${g.primitiveCount}`);
  if (g.bounds) {
    console.log(`    bounds (m)     ${g.bounds.size.map((v) => v.toPrecision(3)).join(' x ')}`);
  }
  if (g.topology) {
    const t = g.topology;
    console.log(
      `    topology       ${fmt(t.boundaryEdges)} boundary, ${fmt(t.nonManifoldEdges)} non-manifold, ` +
      `${fmt(t.degenerateTriangles)} degenerate, ${fmt(t.redundantVertices)} redundant (${fmt(t.duplicateVertexPositions)} pos-dup incl. UV seams)`,
    );
  }

  console.log(pc.bold('  Materials & textures'));
  console.log(`    materials      ${r.materials.length}  ${budget(r.materials.length, r.profile.maxMaterials)}`);
  console.log(`    textures       ${r.textures.length} (${mb(r.textureBytesTotal)})  ${budget(r.textureBytesTotal, r.profile.maxTextureBytes, mb)}`);
  if (r.textureVramTotal > 0) {
    console.log(`    est. GPU mem   ${mb(r.textureVramTotal)}  ${budget(r.textureVramTotal, r.profile.maxTextureVramBytes, mb)}`);
  }
  for (const t of r.textures) {
    console.log(pc.dim(`      ${t.name} ${t.width}x${t.height} ${t.mimeType} ${mb(t.bytes)}`));
  }
  console.log(`    file size      ${r.file.bytes ? mb(r.file.bytes) : 'n/a'}  ${r.file.bytes ? budget(r.file.bytes, r.profile.maxFileBytes, mb) : ''}`);
  console.log(line);

  if (r.findings.length === 0) {
    console.log(pc.green('  No findings — ship it.'));
  } else {
    console.log(pc.bold(`  Findings (${r.findings.length})`));
    for (const f of r.findings) {
      console.log(`  ${BADGE[f.severity]} ${pc.bold(f.ruleId)}`);
      console.log(`     ${f.message}`);
      if (f.suggestion) console.log(pc.dim(`     → ${f.suggestion}`));
    }
  }
  console.log();
}

/** Render "of budget N" marker: green check under, red over. */
function budget(value: number, max: number, format: (n: number) => string = fmt): string {
  return value <= max
    ? pc.green(`✓ ≤ ${format(max)}`)
    : pc.red(`✗ > ${format(max)}`);
}

export function printDiff(
  before: AnalysisResult,
  after: AnalysisResult,
  steps: string[],
): void {
  const line = pc.dim('─'.repeat(64));
  console.log();
  console.log(pc.bold('  Optimization result') + pc.dim(`  (${steps.join(' → ')})`));
  console.log(line);
  row('triangles', fmt(before.geometry.triangles), fmt(after.geometry.triangles));
  row('vertices', fmt(before.geometry.vertices), fmt(after.geometry.vertices));
  row('draw calls', '~' + before.geometry.drawCallEstimate, '~' + after.geometry.drawCallEstimate);
  row('texture bytes', mb(before.textureBytesTotal), mb(after.textureBytesTotal));
  row('file size', mb(before.file.bytes), mb(after.file.bytes));
  row('score', `${before.score}/100`, `${after.score}/100`);
  console.log(line);
  const savings = 1 - after.file.bytes / Math.max(1, before.file.bytes);
  console.log(
    `  ${after.passed ? pc.green('✓ within ' + after.profile.name + ' budget') : pc.red('✗ still over budget')}` +
    pc.dim(`   (${(savings * 100).toFixed(1)}% smaller)`),
  );
  if (!after.passed) {
    for (const f of after.findings.filter((x) => x.severity === 'error')) {
      console.log(pc.red(`    ${f.ruleId}: `) + f.message);
    }
  }
  console.log();
}

function row(label: string, a: string, b: string): void {
  console.log(`    ${label.padEnd(14)} ${pc.dim(a.padStart(12))}  →  ${pc.bold(b.padStart(12))}`);
}
