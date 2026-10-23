// mos-store.js 单元测试（应用商店核心逻辑，零网络：fetcher 注入 fixture）
// 运行: node tests/test_mos_store.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
mkdirSync(join(ROOT, "tests/fixtures"), { recursive: true });
execFileSync("python3", ["-c", `
import zipfile
p="${join(ROOT, "tests/fixtures")}"; PNG=bytes([0x89,0x50,0x4e,0x47])
z=zipfile.ZipFile(p+"/app_demo.zip",'w',zipfile.ZIP_DEFLATED)
z.writestr('main.wasm', b'\\x00asm\\x01\\x00\\x00\\x00CODECODECODE')
z.writestr('assets/icon.png', PNG)
z.writestr('README.txt', b'hi')
z.close()
open(p+"/solo.wasm","wb").write(b'\\x00asm\\x01\\x00\\x00\\x00SOLO')
z=zipfile.ZipFile(p+"/theme_min.zip",'w',zipfile.ZIP_DEFLATED)
z.writestr('desktop-wallpaper.html','<html><body>wall</body></html>')
z.close()
`]);

const { createVFS, MemoryBackend } = await import(join(ROOT, "public/assets/mos-vfs.js"));
const { installItem, uninstallApp, listInstalled, APPS_ROOT } = await import(
  join(ROOT, "public/assets/mos-store.js"));

let passed = 0, failed = 0; const lines = [];
async function t(name, fn) {
  try { await fn(); passed++; lines.push("  PASS " + name); }
  catch (e) { failed++; lines.push("  FAIL " + name + ": " + e.message); }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, b, m) { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}: 期望 ${y} 实际 ${x}`); }
const file = (f) => { const b = readFileSync(join(ROOT, "tests/fixtures", f));
  return () => Promise.resolve(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
import { createHash } from "node:crypto";
const sha = (f) => createHash("sha256").update(readFileSync(join(ROOT, "tests/fixtures", f))).digest("hex");
const appItem = (f, cat = "mosapp") => ({
  name: f, path: "uploads/" + cat + "/" + f, category: cat,
  sha256: sha(f), size: readFileSync(join(ROOT, "tests/fixtures", f)).length,
});
const vfsOf = async () => { const v = createVFS({ backend: MemoryBackend() }); await v.init(); return v; };

await t("安装 zip 应用 → /system/apps/app_demo/，全量文件+元数据", async () => {
  const v = await vfsOf();
  const r = await installItem(appItem("app_demo.zip"), v, file("app_demo.zip"));
  eq(r.kind, "app", "kind");
  assert(await v.exists(APPS_ROOT + "/app_demo/main.wasm"), "主文件入库");
  assert(await v.exists(APPS_ROOT + "/app_demo/assets/icon.png"), "嵌套资源入库");
  assert(await v.exists(APPS_ROOT + "/app_demo/.app.json"), "元数据存在");
  const meta = JSON.parse(await v.readText(APPS_ROOT + "/app_demo/.app.json"));
  eq(meta.sha256, sha("app_demo.zip"), "记录源校验值");
});
await t("安装单文件应用（wasm）→ /system/apps/solo.wasm", async () => {
  const v = await vfsOf();
  await installItem(appItem("solo.wasm"), v, file("solo.wasm"));
  assert(await v.exists(APPS_ROOT + "/solo.wasm"), "单文件入库");
});
await t("SHA256 不符 → 拒绝且无残留", async () => {
  const v = await vfsOf();
  const item = appItem("app_demo.zip");
  item.sha256 = "0".repeat(64);
  let err = "";
  try { await installItem(item, v, file("app_demo.zip")); } catch (e) { err = e.message; }
  assert(/校验失败/.test(err), "应报校验失败: " + err);
  eq(await v.exists(APPS_ROOT + "/app_demo/main.wasm"), false, "无残留");
  eq((await listInstalled(v)).length, 0, "列表为空");
});
await t("listInstalled 汇总目录与单文件", async () => {
  const v = await vfsOf();
  await installItem(appItem("app_demo.zip"), v, file("app_demo.zip"));
  await installItem(appItem("solo.wasm"), v, file("solo.wasm"));
  const list = await listInstalled(v);
  eq(list.map(x => x.id).sort(), ["app_demo", "solo"], "两个应用");
  const demo = list.find(x => x.id === "app_demo");
  eq(demo.files.includes("main.wasm"), true, "文件清单");
});
await t("卸载应用", async () => {
  const v = await vfsOf();
  await installItem(appItem("app_demo.zip"), v, file("app_demo.zip"));
  await uninstallApp("app_demo", v);
  eq((await listInstalled(v)).length, 0, "列表清空");
  eq(await v.exists(APPS_ROOT + "/app_demo"), false, "目录删除");
});
await t("wallpaper 分类路由到主题/壁纸管线", async () => {
  const v = await vfsOf();
  const it = appItem("theme_min.zip", "wallpaper");
  const r = await installItem(it, v, file("theme_min.zip"));
  eq(r.kind, "theme", "走主题安装");
  eq(r.themeDir, "/system/wallpaper/theme_min", "落壁纸目录");
});
await t("重复安装覆盖并更新元数据", async () => {
  const v = await vfsOf();
  await installItem(appItem("solo.wasm"), v, file("solo.wasm"));
  await installItem(appItem("solo.wasm"), v, file("solo.wasm"));
  eq((await listInstalled(v)).length, 1, "仍为一个应用");
});

console.log(lines.join("\n"));
console.log(`\n总计: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
