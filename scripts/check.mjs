// Syntax check for every source file (run: npm run check).
import { execFileSync } from 'node:child_process';
const files = ['api/index.js', 'lib/auth.js', 'lib/db.js', 'lib/drive.js', 'public/student.js', 'public/admin.js'];
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
await import('../api/index.js');
console.log('OK:', files.length, 'files');
