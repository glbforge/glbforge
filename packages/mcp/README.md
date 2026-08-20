# @glbforge/mcp

MCP server exposing the [glbforge](https://www.npmjs.com/package/glbforge)
pipeline to AI agents (Claude Code, Cursor, ...): `analyze_glb`,
`optimize_glb`, `extrude_image`, `export_stl`, `list_profiles`,
`meshy_create_task`, `meshy_task_status`, `meshy_download`.

```bash
claude mcp add glbforge -- npx -y @glbforge/mcp
```

Tool descriptions teach the routing that matters: flat artwork → deterministic
extrusion (free, instant, exact); photographic/dimensional subjects → Meshy
generation; everything → budget-checked optimization.

Docs: **https://github.com/glbforge/glbforge**
