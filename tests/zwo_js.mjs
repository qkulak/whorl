// Runs public/zwo.js on workouts given as JSON on stdin, for tests/test_zwo.py.
// Prints, for each: the XML serializeZwo writes, and the stats the app shows.
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../public/zwo.js", import.meta.url), "utf8");
const zwo = await import(`data:text/javascript,${encodeURIComponent(src)}`);
const input = JSON.parse(readFileSync(0, "utf8"));
const out = input.map((w) => {
  const tl = zwo.expand(w);
  const s = zwo.stats(tl);
  return { xml: zwo.serializeZwo(w), duration: s.duration, IF: s.IF, tss: s.tss, category: zwo.categorize(w, tl) };
});
process.stdout.write(JSON.stringify(out));
