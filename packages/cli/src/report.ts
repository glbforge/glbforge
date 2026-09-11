import type { InspectReport, PerceptualVerdict } from '@glbforge/core';
import pc from 'picocolors';
import type { AnalysisResult } from '@glbforge/core';

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
    `   ${pc.bold('Profile')} ${r.profile.name}@${r.profile.version}` +
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
  perceptual: PerceptualVerdict | null = null,
  fidelityBound = 0,
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
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  if (perceptual) {
    const verdict = perceptual.passed
      ? pc.green(`✓ SSIM ${pct(perceptual.ssimMean)}`)
      : pc.red(`✗ SSIM ${pct(perceptual.ssimMean)}`);
    console.log(
      `  visual fidelity ${verdict}` +
      pc.dim(`  weakest view ${pct(perceptual.ssimMin)} @ ${perceptual.worstView} · floor ${pct(perceptual.threshold)}` +
        (perceptual.textured ? '' : ' · untextured') +
        (fidelityBound ? ` · geometric deviation ≤ ${pct(fidelityBound)}` : '')),
    );
  } else if (fidelityBound) {
    console.log(pc.dim(`  geometric deviation ≤ ${pct(fidelityBound)} of extent (perceptual check skipped)`));
  }
  const savings = 1 - after.file.bytes / Math.max(1, before.file.bytes);
  console.log(
    `  ${after.passed ? pc.green(`✓ within ${after.profile.name}@${after.profile.version} budget`) : pc.red('✗ still over budget')}` +
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

const INSPECT_BADGE = {
  error: pc.bgRed(pc.white(' ERROR ')),
  warning: pc.bgYellow(pc.black(' WARN  ')),
  info: pc.bgBlue(pc.white(' INFO  ')),
} as const;

/** `glbforge inspect`: the summary an agent reads first, the facts, then every finding with cause and fix. */
export function printInspect(r: InspectReport, path: string, durationMs: number): void {
  const line = pc.dim('─'.repeat(64));
  const m3 = (v: number[]) => v.map((x) => x.toFixed(3)).join(' × ');
  console.log();
  console.log(pc.bold(`  ${path}`) + pc.dim(`   ${r.profile} · ${r.packs.join(', ')} · ${durationMs} ms`));
  console.log(line);
  console.log(`  ${r.summary}`);
  console.log(line);

  console.log(pc.bold('  Topology') + pc.dim('  (welded space: UV seams are not holes)'));
  if (r.topology.shells === null) console.log(pc.dim('    not checked (--no-topology)'));
  else {
    console.log(`    shells         ${fmt(r.topology.shells)}   watertight ${r.topology.watertight ? pc.green('yes') : pc.yellow('no')}`);
    for (const m of r.topology.meshes) {
      const bits = [`${fmt(m.triangles)} tris`];
      if (m.shells !== null) bits.push(`${fmt(m.shells)} shell${m.shells === 1 ? '' : 's'}`);
      if (m.boundary_loops) bits.push(`${fmt(m.boundary_loops)} open loop${m.boundary_loops === 1 ? '' : 's'}`);
      if (m.non_manifold_edges) bits.push(`${fmt(m.non_manifold_edges)} non-manifold`);
      if (m.degenerate_triangles) bits.push(`${fmt(m.degenerate_triangles)} degenerate`);
      console.log(pc.dim(`      ${m.name.padEnd(20)} ${bits.join(', ')}${m.watertight ? '  ✓' : ''}`));
    }
  }

  console.log(pc.bold('  Scale & orientation'));
  console.log(`    bounds (m)     ${r.scale.bounding_box ? m3(r.scale.bounding_box.size) : 'no geometry'}   largest ${r.scale.largest_dimension_m?.toFixed(3) ?? '-'} m`);
  const front = r.orientation.front_source === 'declared' ? `${r.orientation.front} ${pc.dim('(declared, not measured)')}` : pc.dim('unknown — declare it with --expect');
  const b = r.scale.plausibility_basis;
  const plaus = r.scale.plausibility === 'unknown' ? pc.dim('unknown — needs a category (--expect)') : `${r.scale.plausibility === 'plausible' ? pc.green('plausible') : pc.yellow('implausible')} ${pc.dim(`for a ${b!.category}: ${b!.typical_m.map((v) => v.toFixed(2)).join('–')} m ${b!.measure}${b!.confidence < 1 ? `, ${Math.round(b!.confidence * 100)}% prior` : ''}`)}`;
  console.log(`    up axis        ${r.orientation.up_axis} (${r.orientation.up_axis_source})   front ${front}`);
  console.log(`    plausibility   ${plaus}`);
  if (r.expectation) {
    const e = r.expectation;
    console.log(`    expectation    ${e.raw ?? JSON.stringify(e.expectation)}${e.unparsed.length ? pc.yellow(`   could not parse: ${e.unparsed.map((u) => `"${u}"`).join(', ')}`) : ''}`);
  }

  console.log(pc.bold('  Origin'));
  if (r.origin.position_in_bounds) {
    console.log(`    at             ${r.origin.at}   in bounds ${r.origin.position_in_bounds.map((v) => v.toFixed(2)).join(', ')}   height above base ${r.origin.height_above_base_m!.toFixed(3)} m`);
    if (r.origin.at !== 'base-center') console.log(pc.dim(`    → base centre  translate geometry by ${r.origin.offset_to_base_center_m!.map((v) => +v.toFixed(4)).join(', ')} m`));
  }

  const h = r.hierarchy;
  console.log(pc.bold('  Hierarchy'));
  console.log(`    nodes          ${fmt(h.nodes)} (${fmt(h.mesh_nodes)} with meshes, depth ${h.depth})   roots: ${h.root_names.join(', ') || '-'}`);
  for (const t of h.unapplied_transforms) {
    const parts: string[] = [];
    if (t.translation.some((v) => v !== 0)) parts.push(`t ${t.translation.join(', ')}`);
    if (t.rotation_deg) parts.push(`r ${t.rotation_deg}°`);
    if (t.scale.some((v) => v !== 1)) parts.push(`s ${t.scale.join(', ')}`);
    console.log(pc.dim(`      ${t.name.padEnd(20)} ${parts.join('  ')}${t.dequantization ? '   (quantization encoding, not an edit)' : '   unapplied'}`));
  }
  if (h.mirrored.length) console.log(pc.dim(`      mirrored: ${h.mirrored.join(', ')}`));
  console.log(line);

  if (r.findings.length === 0) {
    console.log(pc.green('  No findings.'));
  } else {
    console.log(pc.bold(`  Findings (${r.findings.length})`));
    for (const f of r.findings) {
      const badge = INSPECT_BADGE[f.severity];
      const changed = f.severity !== f.default_severity ? pc.dim(` (pack default ${f.default_severity})`) : '';
      console.log(`  ${badge} ${pc.bold(f.rule)} ${pc.dim(`${f.certainty}${f.confidence !== undefined ? ` ${(f.confidence * 100).toFixed(0)}%` : ''} · ${f.prim_path}`)}${changed}`);
      console.log(`     ${f.message}`);
      if (f.likely_cause) console.log(pc.dim(`     cause (${(f.likely_cause.confidence * 100).toFixed(0)}%): ${f.likely_cause.text}`));
      console.log(pc.dim(`     → ${f.fix}`));
    }
  }
  if (r.skipped.length) console.log(pc.dim(`  Skipped: ${r.skipped.map((s) => `${s.rule} (${s.reason})`).join('; ')}`));
  console.log();
}
