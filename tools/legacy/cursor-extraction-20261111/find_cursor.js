
async function run() {
  const r = await fetch('https://www.cursor.com');
  const html = await r.text();
  const reg = /href="([^"]+)"/g;
  let match;
  while ((match = reg.exec(html)) !== null) {
    if (match[1].includes('download') || match[1].includes('Setup') || match[1].includes('.exe') || match[1].includes('cursor')) {
      console.log('href:', match[1]);
    }
  }
}
run();

