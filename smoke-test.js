// Manual smoke test: runs the same pipeline the plugin uses inside LM Studio.
const { researchWeb, readUrl } = require("./dist/research.js");

const query = process.argv[2] || "погода в Москве завтра";
const pages = Number(process.argv[3] ?? 3);

(async () => {
  const t0 = Date.now();
  const out = await researchWeb(query, pages, undefined, (message) => console.log(`[status] ${message}`));
  console.log(`\n=== took ${Date.now() - t0} ms, output ${out.length} chars ===\n`);
  console.log(out);
})();
