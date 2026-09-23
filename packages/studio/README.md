# @glbforge/studio

The web app behind `glbforge ui`, and the thing served at
[glbforge.dev/studio](https://glbforge.dev/studio).

**You probably want the [glbforge](https://www.npmjs.com/package/glbforge)
CLI instead** — this package is the built static bundle, published so the
CLI and the site can serve the same build. There is no API to import.

```bash
npx glbforge ui            # opens the Studio on a local port
npx glbforge ui model.glb  # …with a file already loaded
```

## What it does

Drop a GLB, glTF or an image on the window and the pipeline runs **in the
browser** — the same `@glbforge/core` that the CLI and the MCP server use,
compiled to run without Node:

- **Analyze** against a versioned budget profile (`mobile-hero`,
  `desktop-hero`, `product-configurator`) — score, per-cap verdicts, named
  rules with causes and fixes
- **Optimize** — dedup, join, weld, meshopt simplification to the budget,
  WebP or KTX2 textures — with the visual loss measured by SSIM over fixed
  cameras before and after, not asserted
- **Forge** an image into beveled, watertight 3D, including lifting a subject
  off a plain background when the artwork has no alpha of its own
- **Export** binary STL for printing, or USDZ for iOS AR Quick Look

Files you drop are decoded and processed locally; nothing is uploaded for any
of the above. Generating 3D from a photo is the exception — that needs a
provider key and a server, and the Studio says so before you click.

Because it is the same core, a caveat from the CLI is a caveat here: budgets
are versioned contracts, and "no visible loss" is a measurement rather than a
promise.

Docs: **https://github.com/glbforge/glbforge**
