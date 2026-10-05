// apps/backend/src/scripts/gen-email-assets.ts
//
// Builds the static images the approval emails use (services/approvalEmails/
// layout.ts) into apps/frontend/public/email-assets/, which Amplify serves as
// https://plumbox.plumtrips.com/email-assets/<file>. Run it again only when an
// asset should change; the PNGs are committed.
//
//   npx tsx src/scripts/gen-email-assets.ts
//
// Sources (both already frontend dependencies, read from its node_modules):
//   - icons: Lucide outlines (ISC), drawn in the brand navy on a light-blue disc
//   - hero:  world-atlas land-110m — the LAND outline only, so no country
//            borders exist to draw — sampled into a single-colour dot map on a
//            transparent background (reads on light and dark backgrounds)
//   - logo:  apps/frontend/public/assets/PlumtripsB_O.png on a white plate, so
//            it stays legible when a mail app darkens the header
// Every image is written at 2x its display size.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath, pathToFileURL } from "url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const frontend = path.join(repo, "apps/frontend");
const outDir = path.join(frontend, "public/email-assets");
const feRequire = createRequire(path.join(frontend, "package.json"));

const NAVY = "#00477f";
const DISC = "#e6f0fa";
const NOTE_DISC = "#fbe3dc";
const NOTE_INK = "#b9452b";
const MAP_DOT = "#8fb8e3";

fs.mkdirSync(outDir, { recursive: true });

/* ───────────── icons ───────────── */

type IconNode = Array<[string, Record<string, string>]>;

async function lucide(name: string): Promise<IconNode> {
  const dir = path.dirname(feRequire.resolve("lucide-react/package.json"));
  const mod = await import(pathToFileURL(path.join(dir, "dist/esm/icons", `${name}.js`)).href);
  return mod.__iconNode as IconNode;
}

function nodeSvg(node: IconNode): string {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${v}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
}

/** A Lucide icon centred on a disc. size = output px (2x the display size). */
async function discIcon(file: string, icon: string, size: number, opts: { disc?: string; ink?: string; ring?: boolean } = {}) {
  const node = await lucide(icon);
  const disc = opts.disc ?? DISC;
  const ink = opts.ink ?? NAVY;
  const g = size * 0.5; // glyph box
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${disc ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${disc}"/>` : ""}
    <g transform="translate(${(size - g) / 2} ${(size - g) / 2}) scale(${g / 24})" fill="none" stroke="${ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodeSvg(node)}</g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, file));
}

/** A Lucide glyph on a rounded light tile (itinerary rows). */
async function tileIcon(file: string, icon: string, size: number) {
  const node = await lucide(icon);
  const g = size * 0.5;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <rect width="${size}" height="${size}" rx="${size * 0.2}" fill="${DISC}"/>
    <g transform="translate(${(size - g) / 2} ${(size - g) / 2}) scale(${g / 24})" fill="none" stroke="${NAVY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${nodeSvg(node)}</g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, file));
}

/** The plane between the two airport codes: a bare glyph pointing right. */
async function routePlane(file: string, size: number) {
  const node = await lucide("plane");
  // Lucide's plane points to the upper right; turn it 45° to point right.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
    <g transform="rotate(45 12 12)" fill="none" stroke="${NAVY}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${nodeSvg(node)}</g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(path.join(outDir, file));
}

/* ───────────── hero dot map ───────────── */

type Ring = Array<[number, number]>;

/** Decodes the land-110m TopoJSON into polygons of [lon, lat] rings (no topojson-client needed). */
function landPolygons(): Ring[][] {
  const topo = JSON.parse(fs.readFileSync(feRequire.resolve("world-atlas/land-110m.json"), "utf8"));
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  const arcs: Ring[] = topo.arcs.map((arc: number[][]) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
  const ring = (ids: number[]): Ring => {
    const out: Ring = [];
    for (const id of ids) {
      const a = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const polys: Ring[][] = [];
  for (const geom of topo.objects.land.geometries) {
    if (geom.type === "Polygon") polys.push(geom.arcs.map(ring));
    if (geom.type === "MultiPolygon") for (const p of geom.arcs) polys.push(p.map(ring));
  }
  return polys;
}

function inRing(lon: number, lat: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i];
    const [xj, yj] = r[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 600x230 display (1200x460 file). Land between 60°S and 80°N, equirectangular.
 * Dots fade out towards the left so the headline that sits over that side of
 * the hero stays clean.
 */
async function heroMap(file: string) {
  const W = 1200;
  const H = 460;
  const polys = landPolygons();
  const LON0 = -170;
  const LON1 = 190;
  const LAT0 = 80;
  const LAT1 = -58;
  const mapLeft = 560; // the map occupies the right part of the hero
  const mapW = W - mapLeft - 10;
  const step = 10;
  const dots: string[] = [];
  for (let py = 10; py < H - 6; py += step) {
    for (let px = mapLeft; px < W - 8; px += step) {
      let lon = LON0 + ((px - mapLeft) / mapW) * (LON1 - LON0);
      if (lon > 180) lon -= 360;
      const lat = LAT0 + (py / H) * (LAT1 - LAT0);
      const land = polys.some((rings) => inRing(lon, lat, rings[0]) && !rings.slice(1).some((h) => inRing(lon, lat, h)));
      if (!land) continue;
      const fade = Math.min(1, Math.max(0.25, (px - mapLeft) / 160));
      dots.push(`<circle cx="${px}" cy="${py}" r="3.4" fill="${MAP_DOT}" fill-opacity="${(0.85 * fade).toFixed(2)}"/>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${dots.join("")}</svg>`;
  await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toFile(path.join(outDir, file));
  return dots.length;
}

/* ───────────── logo ───────────── */

async function logo(file: string) {
  const src = path.join(frontend, "public/assets/PlumtripsB_O.png");
  const w = 300; // 150 display
  const inner = await sharp(src).resize({ width: w - 16 }).png().toBuffer();
  const meta = await sharp(inner).metadata();
  const h = (meta.height || 80) + 16;
  await sharp({ create: { width: w, height: h, channels: 4, background: "#ffffff" } })
    .composite([{ input: inner, left: 8, top: 8 }])
    .png()
    .toFile(path.join(outDir, file));
  return `${w}x${h}`;
}

/* ───────────── run ───────────── */

const ICONS: Array<[string, string]> = [
  ["flight", "plane"],
  ["hotel", "bed-double"],
  ["visa", "stamp"],
  ["cab", "car-taxi-front"],
  ["forex", "banknote"],
  ["esim", "smartphone"],
  ["holiday", "tree-palm"],
  ["mice", "presentation"],
  ["other", "file-text"],
];

const written: string[] = [];
const note = async (f: string) => written.push(f);

for (const [file, icon] of [
  ["i-workspace.png", "building-2"],
  ["i-user.png", "user"],
  ["i-items.png", "file-text"],
  ["i-calendar.png", "calendar"],
  ["i-travellers.png", "users"],
  ["i-clock.png", "clock"],
] as const) {
  await discIcon(file, icon, 72);
  await note(file);
}
await discIcon("i-note.png", "message-square-text", 72, { disc: NOTE_DISC, ink: NOTE_INK });
await note("i-note.png");
await discIcon("i-help.png", "circle-question-mark", 72, { disc: NAVY, ink: "#ffffff" });
await note("i-help.png");
for (const [svc, icon] of ICONS) {
  await tileIcon(`s-${svc}.png`, icon, 96);
  await note(`s-${svc}.png`);
  await discIcon(`c-${svc}.png`, icon, 88);
  await note(`c-${svc}.png`);
}
await routePlane("route-plane.png", 56);
await note("route-plane.png");
const dots = await heroMap("hero-map.png");
await note("hero-map.png");
const logoSize = await logo("logo.png");
await note("logo.png");

console.log(`hero dots: ${dots}, logo: ${logoSize}`);
for (const f of written) console.log(path.join(outDir, f), `${fs.statSync(path.join(outDir, f)).size} bytes`);
