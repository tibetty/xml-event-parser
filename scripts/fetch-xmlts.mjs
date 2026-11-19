// Download the W3C XML Conformance Test Suite for test/conformance.test.ts.
//
// James Clark's xmltest licence allows redistribution only as the unmodified
// archive, so the suite is fetched from W3C into .cache/ (gitignored) rather
// than vendored. The archive is pinned by SHA-256.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const URL = 'https://www.w3.org/XML/Test/xmlts20130923.tar.gz';
const SHA256 = '9b61db9f5dbffa545f4b8d78422167083a8568c59bd1129f94138f936cf6fc1f';
const DIR = '.cache/xmlts';

if (existsSync(`${DIR}/xmlconf/xmltest/valid/sa`)) {
    console.log(`${DIR} is already present`);
    process.exit(0);
}

const response = await fetch(URL);
if (!response.ok) {
    throw new Error(`${URL}: HTTP ${response.status}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash('sha256').update(archive).digest('hex');
if (digest !== SHA256) {
    throw new Error(`${URL}: SHA-256 ${digest}, expected ${SHA256}`);
}
mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/xmlts.tar.gz`, archive);
execFileSync('tar', ['-xzf', `${DIR}/xmlts.tar.gz`, '-C', DIR, 'xmlconf/xmltest']);
console.log(`extracted xmlconf/xmltest into ${DIR}`);
