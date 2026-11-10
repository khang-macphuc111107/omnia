import fs from "node:fs";
const data = JSON.parse(fs.readFileSync("artifacts/headless-chat-focused/report.json", "utf8"));
for (const report of data.reports) {
  console.log("\\n", report.viewport.name);
  for (const [key, value] of Object.entries(report.rectangles)) {
    if (value) console.log(key, JSON.stringify({ x: value.x, y: value.y, w: value.width, h: value.height, right: value.right, bottom: value.bottom, flex: value.flex, scrollH: value.scrollHeight, clientH: value.clientHeight }));
  }
  console.log("out", report.outOfViewport.map((item) => item.label));
  console.log("inter", report.interaction.map((item) => ({ label: item.label, status: item.status, disabled: item.disabled, contained: item.containedOverlays })));
}
