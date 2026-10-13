import { copyFile, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { deflateRawSync } from "node:zlib";

const root = process.cwd();
const dist = path.join(root, "dist");
const packageName = "payflex-on-onex-scorm-1.2.zip";
const packagePath = path.join(root, packageName);
const schemaDirectory = path.join(root, "scripts", "scorm-1.2-schemas");
const schemaFiles = [
  "adlcp_rootv1p2.xsd",
  "imscp_rootv1p1p2.xsd",
  "imsmd_rootv1p2p1.xsd",
  "ims_xml.xsd",
];

const xmlEscape = (value) => value
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

async function makePathsRelative() {
  const indexPath = path.join(dist, "index.html");
  const html = await readFile(indexPath, "utf8");
  await writeFile(
    indexPath,
    html.replace(/\b(src|href|poster)="\/(?!\/)/g, '$1="./'),
    "utf8",
  );

  const files = await listFiles(dist);
  for (const file of files.filter((name) => name.endsWith(".css"))) {
    const cssPath = path.join(dist, ...file.split("/"));
    const css = await readFile(cssPath, "utf8");
    const cssDirectory = path.posix.dirname(file);
    const relativeCss = css.replace(/url\((['"]?)\/([^)'"\s]+)\1\)/g, (_match, quote, asset) => {
      const relativeAsset = path.posix.relative(cssDirectory, asset);
      return `url(${quote}${relativeAsset}${quote})`;
    });
    await writeFile(cssPath, relativeCss, "utf8");
  }
}

function manifestFor(files) {
  const fileEntries = files
    .filter((file) => file !== "imsmanifest.xml" && file !== "scorm-api.js")
    .map((file) => `      <file href="${xmlEscape(file)}" />`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<manifest identifier="PAYFLEX_ON_ONEX_SCORM_12"
  version="1.0"
  xmlns="http://www.imsproject.org/xsd/imscp_rootv1p1p2"
  xmlns:adlcp="http://www.adlnet.org/xsd/adlcp_rootv1p2"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.imsproject.org/xsd/imscp_rootv1p1p2 imscp_rootv1p1p2.xsd http://www.adlnet.org/xsd/adlcp_rootv1p2 adlcp_rootv1p2.xsd">
  <metadata>
    <schema>ADL SCORM</schema>
    <schemaversion>1.2</schemaversion>
  </metadata>
  <organizations default="PAYFLEX_ON_ONEX_ORG">
    <organization identifier="PAYFLEX_ON_ONEX_ORG">
      <title>Payflex on oneX</title>
      <item identifier="PAYFLEX_ON_ONEX_ITEM" identifierref="PAYFLEX_ON_ONEX_RESOURCE">
        <title>Payflex on oneX</title>
      </item>
    </organization>
  </organizations>
  <resources>
    <resource identifier="PAYFLEX_ON_ONEX_RESOURCE" type="webcontent" adlcp:scormtype="sco" href="index.html">
${fileEntries}
    </resource>
  </resources>
</manifest>
`;
}

const crcTable = Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

function crc32(data) {
  let checksum = 0xffffffff;
  for (const byte of data) checksum = (checksum >>> 8) ^ crcTable[(checksum ^ byte) & 0xff];
  return (checksum ^ 0xffffffff) >>> 0;
}

function dosTimestamp(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

async function createZip(outputPath, files) {
  const localParts = [];
  const centralParts = [];
  const timestamp = dosTimestamp(new Date());
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file, "utf8");
    const data = await readFile(path.join(dist, ...file.split("/")));
    const compressed = deflateRawSync(data, { level: 9 });
    const checksum = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(timestamp.time, 10);
    localHeader.writeUInt16LE(timestamp.date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(timestamp.time, 12);
    centralHeader.writeUInt16LE(timestamp.date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, name, compressed);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  await writeFile(outputPath, Buffer.concat([...localParts, centralDirectory, end]));
}

function referencedPaths(content, extension) {
  const references = [];
  const pattern = extension === ".css"
    ? /url\((['"]?)([^)'"\s]+)\1\)/g
    : /\b(?:src|href|poster)="([^"]+)"/g;
  for (const match of content.matchAll(pattern)) references.push(match[2] ?? match[1]);
  return references;
}

async function validateReferences(files) {
  const errors = [];
  for (const file of files.filter((name) => /\.(?:html|css)$/.test(name))) {
    const content = await readFile(path.join(dist, ...file.split("/")), "utf8");
    for (const reference of referencedPaths(content, path.extname(file))) {
      if (!reference || reference.startsWith("#") || /^(?:data:|mailto:|tel:)/i.test(reference)) continue;
      if (/^(?:https?:)?\/\//i.test(reference) || /(?:localhost|netlify)/i.test(reference)) {
        errors.push(`${file}: external reference ${reference}`);
        continue;
      }
      if (reference.startsWith("/")) {
        errors.push(`${file}: root-relative reference ${reference}`);
        continue;
      }
      const cleanReference = reference.split(/[?#]/, 1)[0];
      const target = path.resolve(dist, path.dirname(file), cleanReference);
      if (!target.startsWith(dist + path.sep) && target !== dist) {
        errors.push(`${file}: reference escapes package ${reference}`);
        continue;
      }
      try {
        if (!(await stat(target)).isFile()) errors.push(`${file}: missing file ${reference}`);
      } catch {
        errors.push(`${file}: missing file ${reference}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

await makePathsRelative();
for (const schemaFile of schemaFiles) {
  await copyFile(path.join(schemaDirectory, schemaFile), path.join(dist, schemaFile));
}
let files = await listFiles(dist);
await writeFile(path.join(dist, "imsmanifest.xml"), manifestFor(files), "utf8");
files = await listFiles(dist);
await validateReferences(files);

const manifest = await readFile(path.join(dist, "imsmanifest.xml"), "utf8");
const wrapper = await readFile(path.join(dist, "course-runtime.js"), "utf8");
if (!manifest.includes('href="index.html"')) throw new Error("Manifest launch file is not index.html");
if (!manifest.includes("<title>Payflex on oneX</title>")) throw new Error("Manifest title is not Payflex on oneX");
if (/masteryscore|adlcp:masteryscore|\bpassed\b|\bfailed\b/i.test(manifest)) throw new Error("Manifest contains score or pass/fail requirements");
for (const required of [
  "LMSInitialize",
  "cmi.core.lesson_status",
  "cmi.core.entry",
  "cmi.core.lesson_location",
  "cmi.core.session_time",
  "cmi.core.total_time",
  "cmi.core.exit",
  "cmi.suspend_data",
  "incomplete",
  "completed",
  "suspend",
  "LMSCommit",
  "LMSFinish",
  "saveProgress",
]) {
  if (!wrapper.includes(required)) throw new Error(`SCORM wrapper is missing ${required}`);
}
for (const schemaFile of schemaFiles) {
  if (!files.includes(schemaFile)) throw new Error(`SCORM package is missing ${schemaFile}`);
}

const listeners = {};
const standaloneWindow = {
  opener: null,
  addEventListener(type, listener) { listeners[type] = listener; },
};
standaloneWindow.parent = standaloneWindow;
vm.runInNewContext(wrapper, { window: standaloneWindow });
standaloneWindow.CourseSCORM.setSuspendData('{"current":1}');
standaloneWindow.CourseSCORM.setCompleted();
listeners.pagehide();

const lmsCalls = [];
const lmsValues = {
  "cmi.core.lesson_status": "not attempted",
  "cmi.core.total_time": "0001:02:03.45",
};
const lmsApi = {
  LMSInitialize(value) { lmsCalls.push(["LMSInitialize", value]); return "true"; },
  LMSGetValue(element) { lmsCalls.push(["LMSGetValue", element]); return lmsValues[element] ?? ""; },
  LMSSetValue(element, value) { lmsCalls.push(["LMSSetValue", element, value]); lmsValues[element] = value; return "true"; },
  LMSCommit(value) { lmsCalls.push(["LMSCommit", value]); return "true"; },
  LMSFinish(value) { lmsCalls.push(["LMSFinish", value]); return "true"; },
};
const lmsListeners = {};
const lmsWindow = {
  API: lmsApi,
  opener: null,
  addEventListener(type, listener) { lmsListeners[type] = listener; },
};
lmsWindow.parent = lmsWindow;
vm.runInNewContext(wrapper, { window: lmsWindow });
const launchCompletedIndex = lmsCalls.findIndex(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed");
const launchCommitIndex = lmsCalls.findIndex(([method], index) => method === "LMSCommit" && index > launchCompletedIndex);
if (launchCompletedIndex < 0 || launchCommitIndex < 0) throw new Error("SCORM wrapper did not complete and commit immediately after launch");
lmsWindow.CourseSCORM.setSuspendData('{"current":3,"completed":true}');
lmsWindow.CourseSCORM.setCompleted();
const completionStatus = lmsWindow.CourseSCORM.getCompletionStatus();
const totalTime = lmsWindow.CourseSCORM.getTotalTime();
lmsListeners.pagehide();

const statuses = lmsCalls
  .filter(([method, element]) => method === "LMSSetValue" && element === "cmi.core.lesson_status")
  .map(([, , value]) => value);
if (!statuses.includes("completed") || statuses.includes("incomplete")) throw new Error("SCORM launch-completion lifecycle validation failed");
const completedWriteIndex = lmsCalls.findIndex(([method, element, value]) => method === "LMSSetValue" && element === "cmi.core.lesson_status" && value === "completed");
const completionCommitIndex = lmsCalls.findIndex(([method], index) => method === "LMSCommit" && index > completedWriteIndex);
if (completedWriteIndex < 0 || completionCommitIndex < 0) throw new Error("SCORM launch completion was not committed");
if (completionStatus !== "completed") throw new Error("SCORM completion status alias validation failed");
if (totalTime !== "0001:02:03.45") throw new Error("SCORM total time retrieval validation failed");
const sessionTimes = lmsCalls
  .filter(([method, element]) => method === "LMSSetValue" && element === "cmi.core.session_time")
  .map(([, , value]) => value);
if (!sessionTimes.length || sessionTimes.some((value) => !/^\d{4}:\d{2}:\d{2}\.\d{2}$/.test(value))) {
  throw new Error("SCORM session time validation failed");
}
if (!lmsCalls.some(([method, element, value]) => (
  method === "LMSSetValue"
  && element === "cmi.core.exit"
  && value === ""
))) throw new Error("SCORM completed exit validation failed");
if (!lmsCalls.some(([method]) => method === "LMSCommit")) throw new Error("SCORM commit validation failed");
if (!lmsCalls.some(([method]) => method === "LMSFinish")) throw new Error("SCORM finish validation failed");
if (lmsCalls.some((call) => /score|mastery|passed|failed/i.test(call.join(" ")))) throw new Error("SCORM wrapper emitted score or pass/fail data");

await import("./verify-scorm.mjs");

await createZip(packagePath, files);

console.log(JSON.stringify({ files: files.length, launch: "index.html", manifest: "imsmanifest.xml", package: packageName }, null, 2));
