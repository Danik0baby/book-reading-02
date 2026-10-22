const assert = require("node:assert/strict");
const { readFileSync, existsSync } = require("node:fs");
const { resolve, join } = require("node:path");
const { createHash } = require("node:crypto");
const root = resolve(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "book-data/manifest.json"), "utf8"));
const original = readFileSync(join(root, "book/backend.pdf"));
assert.equal(manifest.length, original.length);
assert.equal(manifest.sha256, createHash("sha256").update(original).digest("hex"));
const count = Math.ceil(manifest.length / manifest.chunkSize);
const blocks = Array.from({ length: count }, (_, i) => {
    const block = readFileSync(join(root, "book-data", manifest.baseUrl, `${i}.bin`));
    assert.equal(block.length, Math.min(manifest.chunkSize, original.length - i * manifest.chunkSize));
    return block;
});
assert.deepEqual(Buffer.concat(blocks), original, "Run npm run prepare:assets after replacing the PDF.");
const html = readFileSync(join(root, "index.html"), "utf8");
for (const [, path] of html.matchAll(/(?:src|href)="\.\/([^"?]+)(?:\?[^\"]*)?"/g)) {
    assert.ok(existsSync(join(root, path)), `Missing published asset: ${path}`);
}
for (const name of ["pdf.min.mjs", "pdf.worker.min.mjs", "LICENSE"]) {
    assert.ok(existsSync(join(root, "vendor/pdfjs/6.4.299", name)), `Missing PDF.js file: ${name}`);
}
console.log(`Assets OK: ${count} blocks reconstruct ${original.length} PDF bytes exactly.`);
