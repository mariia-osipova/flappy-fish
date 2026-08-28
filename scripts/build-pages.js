import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const defaultOutput = path.join(root, "dist-pages");
const marker = ".flappy-fish-pages";
const markerContent = "flappy-fish-practice-build-v1\n";
const WEB_FILES = ["index.html", "rank.html", "app.js", "rank.js", "ranked-client.js", "name-filter.js", "styles.css", "favicon.png", "THIRD_PARTY_NOTICES.md"];
const SHARED_FILES = ["game-core.js", "collision-data.js"];

export function pagesOutputPath(outputDirectory) {
  const output = path.resolve(outputDirectory);
  const outputPrefix = output.endsWith(path.sep) ? output : output + path.sep;
  if (output === root || root.startsWith(outputPrefix) || (output.startsWith(root + path.sep) && output !== defaultOutput)) {
    throw new Error("Static output must not overwrite repository sources.");
  }
  return output;
}

export async function buildPages(outputDirectory = defaultOutput) {
  const requestedOutput = pagesOutputPath(outputDirectory);
  // Resolve aliases before any mutation, then independently require ownership
  // of a nonempty output directory. Never clear an arbitrary existing folder.
  const output = pagesOutputPath(path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput)));
  let existing;
  try { existing = await lstat(output); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error("Static output must be a real directory.");
  if (existing && (await readdir(output)).length) {
    let owned = false;
    try { owned = await readFile(path.join(output, marker), "utf8") === markerContent; } catch { /* Missing marker: do not touch. */ }
    if (!owned) throw new Error("Static output directory is not owned by this builder; refusing to clear it.");
  }
  await rm(output, { recursive: true, force: true });
  await mkdir(path.join(output, "shared"), { recursive: true });
  await writeFile(path.join(output, marker), markerContent);
  // Explicit allowlists keep server source, local .env files and credentials
  // out of the deployment, even when a developer's workspace contains them.
  for (const filename of WEB_FILES) {
    const source = path.join(root, "src/web", filename);
    const destination = path.join(output, filename);
    if (filename.endsWith(".html")) {
      let html = await readFile(source, "utf8");
      html = html.replace("<head>", '<head>\n    <meta name="flappy-fish-mode" content="practice">');
      html = html.replaceAll("Official best: unavailable", "Practice only — no leaderboard");
      html = html.replace('id="ranked-start"', 'id="ranked-start" hidden');
      html = html.replace("Ranked games are checked by the server. Practice does not enter the leaderboard.", "Practice-only deployment. No scores are sent or recorded.");
      html = html.replace("No registration. Anyone can use the same name; records are grouped by nickname.", "This deployment offers practice only. Your nickname is remembered locally; no scores are recorded.");
      html = html.replace("Best completed game for each nickname. Historical records are marked as unverified; anyone can use the same nickname.", "Practice-only deployment. A protected leaderboard requires the separate Node.js server and is not available here.");
      await writeFile(destination, html);
    } else if (filename.endsWith(".js")) {
      const script = (await readFile(source, "utf8")).replaceAll('"../shared/', '"./shared/');
      await writeFile(destination, script);
    } else {
      await copyFile(source, destination);
    }
  }
  for (const filename of SHARED_FILES) await copyFile(path.join(root, "src/shared", filename), path.join(output, "shared", filename));
  for (const directory of ["img", "font", "audios"]) {
    await cp(path.join(root, "data", directory), path.join(output, "assets", directory), { recursive: true });
  }
  await writeFile(path.join(output, ".nojekyll"), "");
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = await buildPages();
  console.info(`Built practice-only GitHub Pages site: ${output}`);
}
