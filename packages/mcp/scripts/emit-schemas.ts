/**
 * Emit the published JSON schemas (schemas/*.json at the repo root) from the
 * zod output schemas, plus docs/error-codes.md and the input schemas as the
 * MCP server advertises them. Run by `pnpm --filter @glbforge/mcp build`.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { renderErrorCodesMarkdown } from '@glbforge/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { DiagnosticSchema, envelopeSchema, ToolDataSchemas } from '../src/schemas.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = join(root, 'schemas');
mkdirSync(outDir, { recursive: true });

const write = (name: string, value: unknown) => {
  const path = join(outDir, name);
  const text = JSON.stringify(value, null, 2) + '\n';
  let existing: string | null = null;
  try { existing = readFileSync(path, 'utf8'); } catch { /* new */ }
  if (existing !== text) writeFileSync(path, text);
};

const version = JSON.parse(readFileSync(join(root, 'packages', 'mcp', 'package.json'), 'utf8')).version as string;
const meta = (title: string, description: string) => ({ $schema: 'http://json-schema.org/draft-07/schema#', $id: `https://glbforge.dev/schemas/${version}/${title}.json`, title, description });

write('diagnostic.json', { ...meta('diagnostic', 'One entry of the errors[] array every tool returns.'), ...zodToJsonSchema(DiagnosticSchema, { $refStrategy: 'none' }) });
write('envelope.json', { ...meta('envelope', 'Common response envelope; data is tool-specific (see <tool>.output.json).'), ...zodToJsonSchema(envelopeSchema(z.record(z.unknown()).describe('Tool-specific payload')), { $refStrategy: 'none' }) });

const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
await createServer().connect(serverSide);
const client = new Client({ name: 'schema-emitter', version: '0' });
await client.connect(clientSide);
const tools = (await client.listTools()).tools;
const index: Record<string, { description: string; input: string; output: string; readOnly: boolean }> = {};
for (const t of tools) {
  const data = ToolDataSchemas[t.name as keyof typeof ToolDataSchemas];
  if (!data) throw new Error(`no output schema registered for tool ${t.name}`);
  write(`${t.name}.input.json`, { ...meta(`${t.name}.input`, `Arguments of the ${t.name} tool.`), ...t.inputSchema });
  write(`${t.name}.output.json`, { ...meta(`${t.name}.output`, `Response envelope of the ${t.name} tool.`), ...zodToJsonSchema(envelopeSchema(data), { $refStrategy: 'none' }) });
  index[t.name] = { description: t.description ?? '', input: `${t.name}.input.json`, output: `${t.name}.output.json`, readOnly: !!(t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint };
}
write('index.json', { ...meta('index', 'Every tool of the GLBForge MCP server with its input/output schema files.'), version, tools: index });
await client.close();

const codesPath = join(root, 'docs', 'error-codes.md');
const md = renderErrorCodesMarkdown();
let existing: string | null = null;
try { existing = readFileSync(codesPath, 'utf8'); } catch { /* new */ }
if (existing !== md) writeFileSync(codesPath, md);
console.log(`schemas: ${tools.length} tools → ${outDir}; docs/error-codes.md`);
