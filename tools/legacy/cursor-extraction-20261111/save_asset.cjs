const fs = require('fs');
const target = process.argv[2];
const b64 = process.argv[3];
fs.writeFileSync(target, Buffer.from(b64, 'base64'));
console.log('Successfully wrote ' + target);