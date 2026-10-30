// 데이터 파일을 git 커밋이 아니라 GitHub 릴리스 첨부파일로 보관한다(2026-10-30 결정).
// 압축 파일은 조금만 바뀌어도 통째로 다시 저장돼 git 이력에 쌓이므로, 데이터는 릴리스 'data'의
// 첨부파일로 덮어쓰고(이력 없음) 저장소에는 가리킴 파일(data-release.json)만 커밋한다.
// 가리킴 파일이 바뀌면 Vercel이 다시 배포하고, 빌드 단계(fetch)가 첨부파일을 받아 함수에 넣는다.
//
//   node scripts/release-data.mjs fetch                 가리킴 파일대로 받아 둔다(Vercel 빌드·워크플로 시작)
//   node scripts/release-data.mjs publish <파일...>     바뀐 파일만 올리고 가리킴 파일을 고친다(워크플로, GH_TOKEN 필요)
//   node scripts/release-data.mjs prune <접두>          그 접두 아래에서 디스크에 없는 항목을 가리킴·릴리스에서 뺀다
//   node scripts/release-data.mjs link <repo> <path...> 다른 저장소 가리킴 파일의 항목을 그대로 가져온다(사본 대신)
//
// 외부 패키지를 쓰지 않는다. 올리기·지우기는 러너에 있는 gh CLI를 쓴다.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POINTER = path.join(ROOT, "data-release.json");
const TAG = "data";

function readPointer() {
  try { return JSON.parse(fs.readFileSync(POINTER, "utf8")); } catch { return { tag: TAG, files: {} }; }
}
function writePointer(p) {
  // 항목마다 한 줄 — 서로 다른 워크플로가 다른 파일을 고쳐도 git rebase가 충돌 없이 합친다.
  const keys = Object.keys(p.files).sort();
  const lines = keys.map((k, i) => `  ${JSON.stringify(k)}: ${JSON.stringify(p.files[k])}${i < keys.length - 1 ? "," : ""}`);
  const head = `{"tag": ${JSON.stringify(p.tag || TAG)}, "note": "데이터는 릴리스 첨부파일에 있다. scripts/release-data.mjs 참조", "files": {`;
  fs.writeFileSync(POINTER, head + "\n" + lines.join("\n") + "\n}}\n");
}
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const assetName = (rel) => rel.replace(/^data\//, "").replace(/\//g, "__");
function selfRepo() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const p = readPointer();
  if (p.repo) return p.repo;
  throw new Error("저장소를 알 수 없습니다(GITHUB_REPOSITORY)");
}
const gh = (args) => execFileSync("gh", args, { stdio: ["ignore", "pipe", "inherit"] }).toString();

async function download(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((s) => setTimeout(s, 1500 * (i + 1)));
    }
  }
  throw new Error(`${url} 받기 실패: ${last && last.message}`);
}

async function cmdFetch() {
  const p = readPointer();
  const ents = Object.entries(p.files);
  let got = 0, kept = 0;
  // 동시에 6개까지
  const queue = ents.slice();
  async function worker() {
    while (queue.length) {
      const [rel, e] = queue.shift();
      const dest = path.join(ROOT, rel);
      if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === e.sha256) { kept++; continue; }
      const url = `https://github.com/${e.repo}/releases/download/${e.tag || TAG}/${encodeURIComponent(e.asset)}`;
      const buf = await download(url);
      if (sha(buf) !== e.sha256) throw new Error(`${rel}: 받은 파일의 sha256이 가리킴과 다릅니다(첨부파일이 가리킴보다 새것일 수 있음 — 다시 배포)`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      got++;
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  console.log(`release-data fetch: 받음 ${got}, 그대로 ${kept}, 전체 ${ents.length}`);
  // Vercel은 빌드 명령이 있으면 정적 출력 폴더(public)를 요구한다. 이 서버는 함수(api/)만 쓰므로 빈 자리만 만든다.
  if (process.env.VERCEL) {
    fs.mkdirSync(path.join(ROOT, "public"), { recursive: true });
    fs.writeFileSync(path.join(ROOT, "public", "robots.txt"), "User-agent: *\nDisallow: /\n");
  }
}

function ensureRelease(repo) {
  try { gh(["release", "view", TAG, "-R", repo, "--json", "tagName"]); }
  catch {
    gh(["release", "create", TAG, "-R", repo, "--title", "data", "--latest=false",
      "--notes", "MCP 서버 데이터 파일 보관용. 워크플로가 첨부파일을 덮어쓴다. 저장소의 data-release.json이 지금 쓰는 파일을 가리킨다."]);
  }
}

function cmdPublish(files) {
  const repo = selfRepo();
  const p = readPointer();
  ensureRelease(repo);
  const tmp = fs.mkdtempSync(path.join(ROOT, ".release-up-"));
  let changed = 0;
  try {
    for (const f of files) {
      const rel = path.relative(ROOT, path.resolve(f)).split(path.sep).join("/");
      const buf = fs.readFileSync(path.join(ROOT, rel));
      const h = sha(buf);
      const cur = p.files[rel];
      if (cur && cur.sha256 === h && cur.repo === repo) continue;
      const name = assetName(rel);
      const up = path.join(tmp, name);
      fs.writeFileSync(up, buf);
      gh(["release", "upload", TAG, up, "-R", repo, "--clobber"]);
      p.files[rel] = { repo, tag: TAG, asset: name, sha256: h, size: buf.length };
      changed++;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writePointer(p);
  console.log(`release-data publish: 올림 ${changed} / 대상 ${files.length}`);
}

function cmdPrune(prefix) {
  const repo = selfRepo();
  const p = readPointer();
  let n = 0;
  for (const rel of Object.keys(p.files)) {
    if (!rel.startsWith(prefix)) continue;
    if (fs.existsSync(path.join(ROOT, rel))) continue;
    const e = p.files[rel];
    if (e.repo === repo) { try { gh(["release", "delete-asset", TAG, e.asset, "-R", repo, "-y"]); } catch {} }
    delete p.files[rel];
    n++;
  }
  writePointer(p);
  console.log(`release-data prune ${prefix}: 뺌 ${n}`);
}

async function cmdLink(srcRepo, rels) {
  const p = readPointer();
  const url = `https://raw.githubusercontent.com/${srcRepo}/main/data-release.json`;
  const src = JSON.parse((await download(url)).toString("utf8"));
  let n = 0;
  for (const rel of rels) {
    const e = src.files[rel];
    if (!e) throw new Error(`${srcRepo} 가리킴에 ${rel}이 없습니다`);
    if (JSON.stringify(p.files[rel]) !== JSON.stringify(e)) { p.files[rel] = e; n++; }
  }
  writePointer(p);
  console.log(`release-data link ${srcRepo}: 바뀜 ${n}`);
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "fetch") await cmdFetch();
else if (cmd === "publish") cmdPublish(rest);
else if (cmd === "prune") cmdPrune(rest[0] || "data/");
else if (cmd === "link") await cmdLink(rest[0], rest.slice(1));
else { console.error("명령: fetch | publish <파일...> | prune <접두> | link <repo> <path...>"); process.exit(1); }
