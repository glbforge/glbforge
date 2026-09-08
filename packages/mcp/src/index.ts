#!/usr/bin/env node
/** GLBForge MCP server over stdio. See server.ts for the tool surface. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, loadDotEnv } from './server.js';

loadDotEnv();
await createServer().connect(new StdioServerTransport());
