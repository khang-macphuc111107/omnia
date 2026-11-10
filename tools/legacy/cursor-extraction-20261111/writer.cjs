const fs = require('fs');
const target = process.argv[2];
const append = process.argv[3] === 'append';
const data = Buffer.from(process.argv[4], 'hex');
if (append) {
  fs.appendFileSync(target, data);
} else {
  fs.writeFileSync(target, data);
}
